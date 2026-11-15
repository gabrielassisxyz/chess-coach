import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, FakeExplorer } from "../../test/fakes/fake-explorer.js";
import type { Searcher, SearchRequest, SearchResult } from "../engine/uci.js";
import { importFinishedGame } from "../import/pgn.js";
import { runRepertoireUnitDeleteCommand } from "../openings/delete-repertoire-unit-cli.js";
import { positionKey } from "../openings/from-games.js";
import { parseOpeningTable } from "../openings/names.js";
import { type GameReviewDeps, reviewRepertoireGames } from "../openings/repertoire-review.js";
import { setGrading } from "./games.js";
import { runMigrations } from "./migrate.js";
import type { Database } from "./open.js";
import {
  findRepertoireCard,
  introduceRepertoireCard,
  saveRepertoireCardReview,
} from "./repertoire-cards.js";
import {
  createRepertoireVariation,
  deleteRepertoireUnit,
  insertRepertoireOwnMove,
  listMetOpenings,
  upsertRepertoireReply,
} from "./repertoires.js";
import { endTrainingRun, insertTrainingRun, type StoredRunItem } from "./training.js";

const ITALIAN_SETUP = ["e4", "e5", "Nf3", "Nc6", "Bc4"];
const ITALIAN_LINE = [...ITALIAN_SETUP, "Bc5", "c3", "Nf6", "d4"];
const MCCONNELL_ROOT = ["e4", "e5", "Nf3", "Qf6"];
const MCCONNELL_LINE = [...MCCONNELL_ROOT, "Nc3", "c6", "d4", "d6", "Be2"];
const SCANDINAVIAN_LINE = ["e4", "d5", "exd5", "Qxd5", "Nc3"];
// The names the hub's Add stored for 1.e4 e5 2.Nf3 Qf6: the group is the book's whole name.
const MCCONNELL_GROUP = "King's Pawn Game: McConnell Defense";
const MCCONNELL_VARIATION = "McConnell Defense (3.Nc3)";
const DELETED_AT = "2026-11-15T15:00:00.000Z";

function fenOf(line: string[]): string {
  const game = new Chess();
  for (const san of line) game.move(san);
  return game.fen();
}

const keyOf = (line: string[]): string => positionKey(fenOf(line));

interface LineStep {
  ply: number;
  san: string;
  uci: string;
  keyBefore: string;
  before: string[];
}

function stepsOf(line: string[]): LineStep[] {
  const game = new Chess();
  return line.map((san, index) => {
    const keyBefore = positionKey(game.fen());
    const move = game.move(san);
    const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
    return { ply: index + 1, san, uci, keyBefore, before: line.slice(0, index) };
  });
}

const NAMES = parseOpeningTable(
  [
    "eco\tname\tpgn\tuci\tepd",
    `B00\tKing's Pawn Game\t-\t-\t${keyOf(["e4"])}`,
    `C40\t${MCCONNELL_GROUP}\t-\t-\t${keyOf(MCCONNELL_ROOT)}`,
    `C50\tItalian Game\t-\t-\t${keyOf(ITALIAN_SETUP)}`,
    `B01\tScandinavian Defense\t-\t-\t${keyOf(["e4", "d5"])}`,
  ].join("\n"),
);

/** Plays the first legal move of any position it is asked about, and keeps every request. */
class RepertoireDeleteFakeEngine implements Searcher {
  readonly requests: SearchRequest[] = [];

  async search(request: SearchRequest): Promise<SearchResult> {
    this.requests.push(request);
    const [move] = new Chess(request.fen).moves({ verbose: true });
    const lines = move
      ? [{ moves: [`${move.from}${move.to}${move.promotion ?? ""}`], score: 20 }]
      : [];
    return { fen: request.fen, bestmove: lines[0]?.moves[0] ?? null, lines };
  }
}

let db: Database;
let tmp: string;
let now: Date;
let engine: RepertoireDeleteFakeEngine;
let explorerClock: FakeClock;
let gameCounter: number;

beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  // openDatabase turns these on; the cascade the delete relies on needs them.
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  tmp = mkdtempSync(join(tmpdir(), "cc-repertoire-delete-"));
  now = new Date("2026-11-15T14:00:00.000Z");
  engine = new RepertoireDeleteFakeEngine();
  explorerClock = new FakeClock();
  gameCounter = 0;
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// The rows the generator stores for a unit: the root as setup, then White's moves and Black's replies.
function seedUnit(groupName: string, variationName: string, line: string[], rootPlies: number) {
  const id = createRepertoireVariation(db, { side: "white", groupName, variationName }).id;
  for (const step of stepsOf(line)) {
    const inRoot = step.ply <= rootPlies;
    const place = {
      repertoireId: id,
      positionKey: step.keyBefore,
      ply: step.ply,
      line: step.before,
      reach: inRoot ? 1 : 0.4,
      openingName: null,
      uci: step.uci,
      san: step.san,
    };
    const source = inRoot ? "setup" : "explorer";
    if (step.ply % 2 === 0) {
      upsertRepertoireReply(db, { ...place, share: 0.5, source });
    } else {
      insertRepertoireOwnMove(db, {
        ...place,
        share: null,
        source,
        cpLoss: 0,
        evalCp: 30,
        results: null,
      });
    }
  }
  return id;
}

const seedItalian = (): number => seedUnit("Italian Game", "Giuoco Piano (4.c3)", ITALIAN_LINE, 5);
const seedMcConnell = (): number =>
  seedUnit(MCCONNELL_GROUP, MCCONNELL_VARIATION, MCCONNELL_LINE, 4);

const ownRowIdsOf = (repertoireId: number): number[] =>
  (
    db
      .prepare(
        "SELECT id FROM repertoire_positions WHERE repertoire_id = ? AND kind = 'own' ORDER BY ply",
      )
      .all(repertoireId) as Array<{ id: number }>
  ).map((row) => row.id);

function moveOf(before: string[], san: string): { positionKey: string; uci: string } {
  const step = stepsOf([...before, san]).at(-1) as LineStep;
  return { positionKey: step.keyBefore, uci: step.uci };
}

// A card the drill has rated a few times, so a kept card shows its schedule and reviews unchanged.
function reviewedCard(before: string[], san: string): void {
  const move = moveOf(before, san);
  introduceRepertoireCard(db, move, "2026-11-10T10:00:00.000Z");
  const card = findRepertoireCard(db, move);
  if (!card) throw new Error(`no card for ${san}`);
  for (const reviewedAt of ["2026-11-11T10:00:00.000Z", "2026-11-12T10:00:00.000Z"]) {
    saveRepertoireCardReview(db, card.id, {
      schedule: { interval_hours: 72, ease_factor: 2.6, repetitions: 2 },
      nextReviewAt: "2026-11-15T10:00:00.000Z",
      reviewedAt,
    });
  }
}

const cardAt = (before: string[], san: string) => findRepertoireCard(db, moveOf(before, san));

function pgnOf(line: string[]): string {
  const text = line
    .map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}. ${san}` : san))
    .join(" ");
  return `[Result "1-0"]\n\n${text} 1-0`;
}

function addGame(line: string[]): number {
  gameCounter += 1;
  const id = importFinishedGame(db, {
    pgn: pgnOf(line),
    playerColor: "white",
    source: "pgn",
    sourceId: `delete-${gameCounter}`,
  }) as number;
  setGrading(db, id, "done");
  return id;
}

function insertReview(gameId: number, repertoireId: number, outcome: string): void {
  db.prepare(
    `INSERT INTO repertoire_game_reviews
       (game_id, repertoire_id, reviewed_at, outcome, followed_plies, passed_moves)
     VALUES (?, ?, '2026-11-12T10:00:00.000Z', ?, 9, 3)`,
  ).run(gameId, repertoireId, outcome);
}

interface SeededRun {
  mode: "srs" | "puzzles" | "repertoire";
  items: StoredRunItem[];
  current: Record<string, unknown>;
}

function insertRun(run: SeededRun): number {
  return insertTrainingRun(db, {
    mode: run.mode,
    motif: null,
    color: run.mode === "repertoire" ? "white" : null,
    size: run.items.length,
    items: run.items,
    position: 0,
    solved: 0,
    failed: 0,
    outcomes: [],
    currentJson: JSON.stringify(run.current),
    startedAt: "2026-11-14T09:00:00.000Z",
  });
}

const drillItems = (rowIds: number[]): StoredRunItem[] =>
  rowIds.map((id) => ({ kind: "repertoire", id }));

// The current item a paused drill stores: the unit it started from, its level and the pass's unit.
const drillCurrent = (anchorId: number, level: string, passUnitId: number) => ({
  repertoire_id: anchorId,
  scope: "all",
  level,
  pass_index: 0,
  pass: { variation_id: passUnitId },
});

const runRow = (id: number) => db.prepare("SELECT * FROM training_runs WHERE id = ?").get(id);

function tablesSnapshot() {
  const all = (sql: string) => db.prepare(sql).all();
  return {
    repertoires: all("SELECT * FROM repertoires ORDER BY id"),
    positions: all("SELECT * FROM repertoire_positions ORDER BY id"),
    cards: all("SELECT * FROM repertoire_cards ORDER BY id"),
    runs: all("SELECT * FROM training_runs ORDER BY id"),
    reviews: all("SELECT * FROM repertoire_game_reviews ORDER BY game_id"),
  };
}

const count = (sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

describe("deleteRepertoireUnit", () => {
  it("deletes the unit's row, its positions and its games' reviews, and counts them", () => {
    const italian = seedItalian();
    const mcconnell = seedMcConnell();
    const italianPositions = count(
      "SELECT COUNT(*) AS n FROM repertoire_positions WHERE repertoire_id = ?",
      italian,
    );
    const first = addGame(MCCONNELL_LINE);
    const italianGame = addGame(ITALIAN_LINE);
    const second = addGame([...MCCONNELL_ROOT, "Bc4"]);
    insertReview(first, mcconnell, "in_book");
    insertReview(italianGame, italian, "in_book");
    insertReview(second, mcconnell, "departed");

    const deletion = deleteRepertoireUnit(db, mcconnell, DELETED_AT);

    expect(deletion).toEqual({
      positions: MCCONNELL_LINE.length,
      cardsDeleted: 0,
      cardsKept: 0,
      runsEnded: 0,
      gamesToReview: [first, second],
    });
    expect(count("SELECT COUNT(*) AS n FROM repertoires WHERE id = ?", mcconnell)).toBe(0);
    expect(
      count("SELECT COUNT(*) AS n FROM repertoire_positions WHERE repertoire_id = ?", mcconnell),
    ).toBe(0);
    expect(
      count("SELECT COUNT(*) AS n FROM repertoire_game_reviews WHERE repertoire_id = ?", mcconnell),
    ).toBe(0);
    expect(
      count("SELECT COUNT(*) AS n FROM repertoire_positions WHERE repertoire_id = ?", italian),
    ).toBe(italianPositions);
    expect(db.prepare("SELECT game_id, repertoire_id FROM repertoire_game_reviews").all()).toEqual([
      { game_id: italianGame, repertoire_id: italian },
    ]);
  });

  it("deletes a card only the unit stores and keeps a shared one with its schedule and reviews", () => {
    seedItalian();
    const mcconnell = seedMcConnell();
    // 1.e4 and 2.Nf3 are the Italian's moves too; 3.Nc3 and 4.d4 are the McConnell unit's alone.
    reviewedCard([], "e4");
    reviewedCard(["e4", "e5"], "Nf3");
    reviewedCard(MCCONNELL_ROOT, "Nc3");
    reviewedCard([...MCCONNELL_ROOT, "Nc3", "c6"], "d4");
    reviewedCard([...ITALIAN_SETUP, "Bc5"], "c3");
    const sharedBefore = [cardAt([], "e4"), cardAt(["e4", "e5"], "Nf3")];
    const italianOnlyBefore = cardAt([...ITALIAN_SETUP, "Bc5"], "c3");

    const deletion = deleteRepertoireUnit(db, mcconnell, DELETED_AT);

    expect(deletion).toMatchObject({ cardsDeleted: 2, cardsKept: 2 });
    expect(cardAt(MCCONNELL_ROOT, "Nc3")).toBeUndefined();
    expect(cardAt([...MCCONNELL_ROOT, "Nc3", "c6"], "d4")).toBeUndefined();
    expect([cardAt([], "e4"), cardAt(["e4", "e5"], "Nf3")]).toEqual(sharedBefore);
    expect(sharedBefore.map((card) => card?.reviews)).toEqual([2, 2]);
    expect(cardAt([...ITALIAN_SETUP, "Bc5"], "c3")).toEqual(italianOnlyBefore);
  });

  it("discards every open run that points at the unit and leaves the others alone", () => {
    const italian = seedItalian();
    const mcconnell = seedMcConnell();
    const scandinavian = seedUnit(
      "Scandinavian Defense",
      "Mieses-Kotroc Variation (2.exd5)",
      SCANDINAVIAN_LINE,
      2,
    );
    const mcconnellRows = ownRowIdsOf(mcconnell);
    const italianRows = ownRowIdsOf(italian);
    const ended = {
      // A variation drill of the unit.
      variation: insertRun({
        mode: "repertoire",
        items: drillItems(mcconnellRows),
        current: drillCurrent(mcconnell, "variation", mcconnell),
      }),
      // Started from the unit at the found level, with only another unit's moves in its queue.
      foundAnchor: insertRun({
        mode: "repertoire",
        items: drillItems(ownRowIdsOf(scandinavian)),
        current: drillCurrent(mcconnell, "found", scandinavian),
      }),
      // Started from the Italian at the side level, holding one of the unit's moves.
      sideMerge: insertRun({
        mode: "repertoire",
        items: drillItems([...italianRows, mcconnellRows.at(-1) as number]),
        current: drillCurrent(italian, "side", italian),
      }),
    };
    const kept = {
      italianDrill: insertRun({
        mode: "repertoire",
        items: drillItems(italianRows),
        current: drillCurrent(italian, "variation", italian),
      }),
      // A card id can be the same number as one of the unit's rows.
      cards: insertRun({
        mode: "srs",
        items: mcconnellRows.map((id) => ({ kind: "card", id })),
        current: {},
      }),
      puzzles: insertRun({
        mode: "puzzles",
        items: [{ kind: "puzzle", id: "lichess-db:00008" }],
        current: {},
      }),
      finished: insertRun({
        mode: "repertoire",
        items: drillItems(mcconnellRows),
        current: drillCurrent(mcconnell, "variation", mcconnell),
      }),
    };
    endTrainingRun(db, kept.finished, "finished", "2026-11-14T10:00:00.000Z");
    const keptBefore = Object.values(kept).map(runRow);

    const deletion = deleteRepertoireUnit(db, mcconnell, DELETED_AT);

    expect(deletion.runsEnded).toBe(3);
    for (const id of Object.values(ended)) {
      expect(runRow(id)).toMatchObject({
        ended_at: DELETED_AT,
        ended_reason: "discarded",
        updated_at: DELETED_AT,
      });
    }
    expect(Object.values(kept).map(runRow)).toEqual(keptBefore);
  });

  it("leaves the unit, its positions, its cards and the runs as they were when it fails", () => {
    const italian = seedItalian();
    const mcconnell = seedMcConnell();
    reviewedCard(["e4", "e5"], "Nf3");
    reviewedCard(MCCONNELL_ROOT, "Nc3");
    insertRun({
      mode: "repertoire",
      items: drillItems(ownRowIdsOf(mcconnell)),
      current: drillCurrent(mcconnell, "variation", mcconnell),
    });
    insertReview(addGame(MCCONNELL_LINE), mcconnell, "in_book");
    insertReview(addGame(ITALIAN_LINE), italian, "in_book");
    const before = tablesSnapshot();
    // The cards are swept last, after the runs were ended and the unit deleted.
    db.exec(`CREATE TRIGGER forced_failure BEFORE DELETE ON repertoire_cards
             BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);

    expect(() => deleteRepertoireUnit(db, mcconnell, DELETED_AT)).toThrow("forced failure");

    expect(tablesSnapshot()).toEqual(before);
  });

  it("refuses a unit that does not exist and writes nothing", () => {
    const mcconnell = seedMcConnell();
    insertRun({
      mode: "repertoire",
      items: [],
      current: drillCurrent(mcconnell + 1, "variation", mcconnell + 1),
    });
    const before = tablesSnapshot();

    expect(() => deleteRepertoireUnit(db, mcconnell + 1, DELETED_AT)).toThrow(
      `repertoire ${mcconnell + 1} does not exist`,
    );
    expect(tablesSnapshot()).toEqual(before);
  });
});

describe("the delete:repertoire-unit command", () => {
  const reviewDeps = (): GameReviewDeps => ({
    db,
    engine,
    fetcher: new FakeExplorer(explorerClock),
    cacheDir: join(tmp, "explorer-cache"),
    explorerClock,
    names: NAMES,
    clock: { now: () => now },
  });

  async function runCommand(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const status = await runRepertoireUnitDeleteCommand(argv, {
      review: reviewDeps(),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { status, out, err };
  }

  // The unit as the hub's Add left it: two games reviewed against it, a card of its own move.
  async function seedReviewedMcConnell() {
    const italian = seedItalian();
    const mcconnell = seedMcConnell();
    const games = {
      inBook: addGame(MCCONNELL_LINE),
      departed: addGame([...MCCONNELL_ROOT, "Bc4", "c6"]),
      italian: addGame(ITALIAN_LINE),
    };
    await reviewRepertoireGames(reviewDeps());
    return { italian, mcconnell, games };
  }

  it("deletes the unit, prints what went and reviews its games again against the Italian", async () => {
    const { italian, mcconnell, games } = await seedReviewedMcConnell();
    const reviewOf = (gameId: number) =>
      db.prepare("SELECT * FROM repertoire_game_reviews WHERE game_id = ?").get(gameId) as
        | Record<string, unknown>
        | undefined;
    expect(reviewOf(games.inBook)).toMatchObject({ repertoire_id: mcconnell, outcome: "in_book" });
    expect(reviewOf(games.departed)).toMatchObject({
      repertoire_id: mcconnell,
      outcome: "departed",
    });
    const italianReview = reviewOf(games.italian);
    now = new Date("2026-11-15T15:30:00.000Z");

    const run = await runCommand("--", "--group", MCCONNELL_GROUP);

    expect(run).toEqual({
      status: 0,
      out: [
        `repertoire: ${mcconnell}`,
        `group: ${MCCONNELL_GROUP}`,
        `variation: ${MCCONNELL_VARIATION}`,
        "setup line: e4 e5 Nf3 Qf6",
        `positions: ${MCCONNELL_LINE.length}`,
        // The reviews gave each of the student's moves a card: 3.Nc3, 4.d4 and 5.Be2 are the
        // unit's alone, 1.e4 and 2.Nf3 the Italian's as well.
        "cards deleted: 3",
        "cards kept: 2",
        "runs ended: 0",
        `games to review: 2 (${games.inBook}, ${games.departed})`,
        `game ${games.inBook}: not_reached against repertoire ${italian} (Italian Game: Giuoco Piano (4.c3))`,
        `game ${games.departed}: not_reached against repertoire ${italian} (Italian Game: Giuoco Piano (4.c3))`,
      ],
      err: [],
    });
    for (const gameId of [games.inBook, games.departed]) {
      expect(reviewOf(gameId)).toMatchObject({
        repertoire_id: italian,
        reviewed_at: now.toISOString(),
        outcome: "not_reached",
        left_ply: 4,
        left_san: "Qf6",
        opening_name: MCCONNELL_GROUP,
      });
    }
    expect(reviewOf(games.italian)).toEqual(italianReview);
    expect(listMetOpenings(db)).toEqual([
      { root: MCCONNELL_ROOT, openingName: MCCONNELL_GROUP, games: 2, repertoireId: null },
    ]);
    expect(engine.requests).toEqual([]);
  });

  it("prints the same with --dry-run and writes nothing", async () => {
    const { mcconnell } = await seedReviewedMcConnell();
    insertRun({
      mode: "repertoire",
      items: drillItems(ownRowIdsOf(mcconnell)),
      current: drillCurrent(mcconnell, "variation", mcconnell),
    });
    const before = tablesSnapshot();

    const dry = await runCommand("--group", MCCONNELL_GROUP, "--dry-run");

    expect(tablesSnapshot()).toEqual(before);
    expect(dry.status).toBe(0);
    expect(dry.err).toEqual([]);
    expect(dry.out.at(-1)).toBe("dry run: nothing was written");
    const real = await runCommand("--group", MCCONNELL_GROUP);
    expect(real.status).toBe(0);
    expect(dry.out.slice(0, -1)).toEqual(real.out.slice(0, dry.out.length - 1));
    expect(dry.out).toContain("runs ended: 1");
  });

  it("refuses a group that holds no unit and writes nothing", async () => {
    await seedReviewedMcConnell();
    const before = tablesSnapshot();

    const run = await runCommand("--", "--group", "King's Pawn Game");

    expect(run.status).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err).toEqual([
      `refused: no unit is stored under the group "King's Pawn Game"; groups: "Italian Game", "${MCCONNELL_GROUP}"`,
    ]);
    expect(tablesSnapshot()).toEqual(before);
  });

  it("refuses a group that holds more than one variation and writes nothing", async () => {
    await seedReviewedMcConnell();
    seedUnit(MCCONNELL_GROUP, "McConnell Defense (3.Bc4)", [...MCCONNELL_ROOT, "Bc4"], 4);
    const before = tablesSnapshot();

    const run = await runCommand("--group", MCCONNELL_GROUP);

    expect(run.status).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err).toEqual([
      `refused: the group "${MCCONNELL_GROUP}" holds 2 variations ("${MCCONNELL_VARIATION}", "McConnell Defense (3.Bc4)"), not one`,
    ]);
    expect(tablesSnapshot()).toEqual(before);
  });

  it("refuses a unit rooted anywhere but 1.e4 e5 2.Nf3 Qf6 and writes nothing", async () => {
    await seedReviewedMcConnell();
    const scandinavian = seedUnit(
      "Scandinavian Defense",
      "Mieses-Kotroc Variation (2.exd5)",
      SCANDINAVIAN_LINE,
      2,
    );
    const before = tablesSnapshot();

    const run = await runCommand("--group", "Scandinavian Defense");

    expect(run.status).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err).toEqual([
      `refused: unit ${scandinavian} is rooted at "e4 d5", not at "e4 e5 Nf3 Qf6"`,
    ]);
    expect(tablesSnapshot()).toEqual(before);
  });

  it("answers a missing --group or an unknown flag with its usage and writes nothing", async () => {
    await seedReviewedMcConnell();
    const before = tablesSnapshot();

    const missing = await runCommand("--dry-run");
    const unknown = await runCommand("--group", MCCONNELL_GROUP, "--force");

    expect([missing.status, unknown.status]).toEqual([2, 2]);
    expect(missing.err[0]).toBe("--group is required");
    expect(unknown.err[0]).toContain("--force");
    expect(unknown.out).toEqual([]);
    expect(tablesSnapshot()).toEqual(before);
  });
});
