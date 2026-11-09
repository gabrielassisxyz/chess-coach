import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess, type Move } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../test/fakes/fake-explorer.js";
import { buildApp } from "../app.js";
import { type Database, openDatabase } from "../db/open.js";
import {
  createRepertoireVariation,
  insertRepertoireOwnMove,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { applyUci } from "../engine/moves.js";
import type { Searcher, SearchRequest, SearchResult } from "../engine/uci.js";
import { RecordingLog } from "../log.js";
import {
  EXPLORER_RATINGS,
  type ExplorerFetcher,
  ITALIAN_WHITE_RATINGS,
} from "./explorer-client.js";
import { positionKey } from "./from-games.js";
import {
  generateRepertoire,
  REPERTOIRE_MAX_PLY,
  type RepertoireOptions,
  type RepertoireResult,
} from "./from-repertoire.js";
import { NO_OPENING_NAMES, type OpeningNames, parseOpeningTable } from "./names.js";

const SETUP = ["e4", "e5", "Nf3", "Nc6", "Bc4"];
const BEFORE_BC4 = SETUP.slice(0, 4);
const AFTER_BC5 = [...SETUP, "Bc5"];
const AFTER_C3 = [...AFTER_BC5, "c3"];

function fenOf(line: string[]): string {
  const game = new Chess();
  for (const san of line) game.move(san);
  return game.fen();
}

const keyOf = (line: string[]): string => positionKey(fenOf(line));

/** Answers by position and band from numbers a test writes out; anything unwritten has no games. */
class RepertoireFakeExplorer implements ExplorerFetcher {
  readonly calls: Array<{ key: string; ratings: string | undefined }> = [];
  /** A student-band position nobody wrote answers its first legal move, so a line never stalls. */
  autoplay = false;
  private readonly answers = new Map<string, unknown>();

  write(line: string[], ratings: string, moves: Record<string, number>, total: number): this {
    const white = Math.round(total * 0.5);
    const draws = Math.round(total * 0.04);
    this.answers.set(`${ratings}|${keyOf(line)}`, {
      white,
      draws,
      black: total - white - draws,
      moves: Object.entries(moves).map(([san, games]) => ({
        san,
        white: games,
        draws: 0,
        black: 0,
      })),
    });
    return this;
  }

  gamesWrittenAt(key: string, ratings: string): number {
    const answer = this.answers.get(`${ratings}|${key}`) as
      | { white: number; draws: number; black: number }
      | undefined;
    return answer ? answer.white + answer.draws + answer.black : 0;
  }

  async fetch(fen: string, ratings?: string): Promise<string> {
    const key = positionKey(fen);
    this.calls.push({ key, ratings });
    return JSON.stringify(this.answers.get(`${ratings}|${key}`) ?? this.unwritten(fen, ratings));
  }

  private unwritten(fen: string, ratings: string | undefined): unknown {
    const empty = { white: 0, draws: 0, black: 0, moves: [] };
    if (!this.autoplay || ratings !== EXPLORER_RATINGS) return empty;
    const move = forwardMove(fen);
    if (!move) return empty;
    const counts = { white: 1000, draws: 0, black: 0 };
    return { ...counts, moves: [{ san: move.san, ...counts }] };
  }
}

/** A pawn move when there is one: it can never repeat a position, so a line stays new to its end. */
function forwardMove(fen: string): Move | undefined {
  const moves = new Chess(fen).moves({ verbose: true });
  return moves.find((move) => move.piece === "p") ?? moves[0];
}

/** Scores the moves a test writes out; an unwritten position has one forward move alone. */
class RepertoireFakeEngine implements Searcher {
  readonly requests: SearchRequest[] = [];
  private readonly scripted = new Map<string, Array<{ moves: string[]; score: number }>>();

  write(line: string[], scores: Array<[uci: string, score: number]>): this {
    this.scripted.set(
      keyOf(line),
      scores.map(([uci, score]) => ({ moves: [uci], score })),
    );
    return this;
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    this.requests.push(request);
    const written = this.scripted.get(positionKey(request.fen));
    // Stockfish answers as many lines as MultiPV asks for, and too few would change White's pick.
    const lines = (written ?? forwardMoveLines(request.fen)).slice(0, request.multipv ?? 1);
    return { fen: request.fen, bestmove: lines[0]?.moves[0] ?? null, lines };
  }
}

function forwardMoveLines(fen: string): SearchResult["lines"] {
  const move = forwardMove(fen);
  return move ? [{ moves: [`${move.from}${move.to}${move.promotion ?? ""}`], score: 20 }] : [];
}

const ITALIAN_FIXTURE_NAMES: OpeningNames = parseOpeningTable(
  [
    "eco\tname\tpgn\tuci\tepd",
    `C50\tItalian Game\t-\t-\t${keyOf(SETUP)}`,
    `C50\tItalian Game: Giuoco Piano\t-\t-\t${keyOf(AFTER_BC5)}`,
    `C53\tItalian Game: Classical Variation\t-\t-\t${keyOf(AFTER_C3)}`,
    `C55\tItalian Game: Two Knights Defense\t-\t-\t${keyOf([...SETUP, "Nf6"])}`,
  ].join("\n"),
);

interface RepertoireTestRow {
  id: number;
  repertoire_id: number;
  kind: "own" | "reply";
  position_key: string;
  ply: number;
  line_san: string;
  move_uci: string;
  move_san: string;
  share: number | null;
  reach: number;
  opening_name: string | null;
  idea: string | null;
  source: string;
  cp_loss: number | null;
  wins: number | null;
  draws: number | null;
  losses: number | null;
}

let tmp: string;
let cacheDir: string;
let db: Database;
let clock: FakeClock;
let explorer: RepertoireFakeExplorer;
let engine: RepertoireFakeEngine;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-repertoire-"));
  cacheDir = join(tmp, "explorer-cache");
  db = openDatabase(tmp);
  clock = new FakeClock();
  explorer = new RepertoireFakeExplorer();
  engine = new RepertoireFakeEngine();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const generate = (
  options: RepertoireOptions = {},
  names: OpeningNames = ITALIAN_FIXTURE_NAMES,
): Promise<RepertoireResult> =>
  generateRepertoire(db, engine, explorer, cacheDir, clock, names, options);

const rowsOf = (database: Database): RepertoireTestRow[] =>
  database
    .prepare("SELECT * FROM repertoire_positions ORDER BY ply, kind, position_key, move_uci")
    .all() as RepertoireTestRow[];

const ownAt = (line: string[]): RepertoireTestRow | undefined =>
  rowsOf(db).find((row) => row.kind === "own" && row.position_key === keyOf(line));

const replyAt = (line: string[], san: string): RepertoireTestRow | undefined =>
  rowsOf(db).find(
    (row) => row.kind === "reply" && row.position_key === keyOf(line) && row.move_san === san,
  );

const variationsOf = (database: Database) =>
  database.prepare("SELECT side, group_name, variation_name FROM repertoires").all();

/** The shares of 3.Bc4 and of 3...Bc5 at 1800 to 2499 are the ones measured on 2026-11-09. */
function writeItalianTree(): void {
  explorer
    .write([], ITALIAN_WHITE_RATINGS, { e4: 5000 }, 10000)
    .write(["e4"], EXPLORER_RATINGS, { e5: 62500, c5: 20000 }, 100000)
    .write(["e4", "e5"], ITALIAN_WHITE_RATINGS, { Nf3: 8000 }, 10000)
    .write(["e4", "e5", "Nf3"], EXPLORER_RATINGS, { Nc6: 50600, d6: 9000 }, 100000)
    .write(BEFORE_BC4, ITALIAN_WHITE_RATINGS, { Bc4: 6000, Bb5: 3000 }, 10000)
    .write(
      SETUP,
      EXPLORER_RATINGS,
      {
        Nf6: 40200,
        Bc5: 22600,
        h6: 8700,
        d6: 7400,
        Nd4: 3700,
        f6: 3000,
        Nh6: 2200,
        a6: 1700,
      },
      100000,
    )
    .write(AFTER_BC5, ITALIAN_WHITE_RATINGS, { c3: 3410, "O-O": 2650, d3: 1380, b4: 1130 }, 10000)
    // Read by nobody: if the student's band chose White's move, the answer would be 4.d3.
    .write(AFTER_BC5, EXPLORER_RATINGS, { d3: 9000, c3: 100 }, 10000)
    .write(AFTER_C3, EXPLORER_RATINGS, { Nf6: 3000, d6: 250 }, 5000)
    .write([...AFTER_C3, "Nf6"], ITALIAN_WHITE_RATINGS, { d4: 6000 }, 8000)
    .write([...AFTER_C3, "Nf6", "d4"], EXPLORER_RATINGS, { exd4: 1000 }, 2000)
    .write([...AFTER_C3, "Nf6", "d4", "exd4"], ITALIAN_WHITE_RATINGS, { cxd4: 5000 }, 6000)
    .write([...SETUP, "Nf6"], ITALIAN_WHITE_RATINGS, { d3: 5000, Ng5: 2000 }, 8000)
    .write([...SETUP, "Nf6", "d3"], EXPLORER_RATINGS, { Be7: 2500 }, 5000);
  engine
    .write([], [["e2e4", 30]])
    .write(["e4", "e5"], [["g1f3", 30]])
    .write(BEFORE_BC4, [
      ["f1b5", 40],
      ["f1c4", 30],
    ])
    .write(AFTER_BC5, [
      ["e1g1", 40],
      ["c2c3", 30],
      ["d2d3", 20],
      ["b2b4", 0],
    ])
    .write([...AFTER_C3, "Nf6"], [["d2d4", 35]])
    .write([...AFTER_C3, "Nf6", "d4", "exd4"], [["c3d4", 45]])
    .write(
      [...SETUP, "Nf6"],
      [
        ["d2d3", 25],
        ["f3g5", 20],
      ],
    );
}

describe("the repertoire tables", () => {
  const newOwnMove = (repertoireId: number, positionKeyText: string, uci: string) => ({
    repertoireId,
    positionKey: positionKeyText,
    ply: 7,
    line: AFTER_BC5,
    reach: 0.2,
    openingName: null,
    uci,
    san: uci,
    share: null,
    source: "explorer" as const,
    cpLoss: 10,
    results: null,
  });

  it("has the columns the drill and the statistics read", () => {
    const columnsOf = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
    expect(columnsOf("repertoires")).toEqual(["id", "side", "group_name", "variation_name"]);
    expect(columnsOf("repertoire_positions")).toEqual([
      "id",
      "repertoire_id",
      "kind",
      "position_key",
      "ply",
      "line_san",
      "move_uci",
      "move_san",
      "share",
      "reach",
      "opening_name",
      "idea",
      "source",
      "cp_loss",
      "wins",
      "draws",
      "losses",
    ]);
  });

  it("allows one expected White move per repertoire and position", () => {
    const first = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "A",
    });
    const second = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "B",
    });
    insertRepertoireOwnMove(db, newOwnMove(first.id, "position", "c2c3"));
    expect(() => insertRepertoireOwnMove(db, newOwnMove(first.id, "position", "d2d3"))).toThrow(
      /UNIQUE/,
    );
    // Another variation may expect another move in the same position.
    insertRepertoireOwnMove(db, newOwnMove(second.id, "position", "d2d3"));
    expect(rowsOf(db)).toHaveLength(2);
  });

  it("allows many replies in one position, each stored once", () => {
    const repertoire = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "A",
    });
    const reply = (uci: string) => ({
      repertoireId: repertoire.id,
      positionKey: "position",
      ply: 8,
      line: AFTER_C3,
      reach: 0.1,
      openingName: null,
      uci,
      san: uci,
      share: 0.5,
      source: "explorer" as const,
    });
    upsertRepertoireReply(db, reply("g8f6"));
    upsertRepertoireReply(db, reply("g8f6"));
    upsertRepertoireReply(db, reply("d7d6"));
    expect(rowsOf(db).map((row) => row.move_uci)).toEqual(["d7d6", "g8f6"]);
  });
});

describe("generateRepertoire", () => {
  it("answers 3...Bc5 with 4.c3 from the White band's numbers and keeps a 3...Nf6 branch", async () => {
    writeItalianTree();
    await generate();
    expect(ownAt(AFTER_BC5)).toMatchObject({
      move_san: "c3",
      move_uci: "c2c3",
      source: "explorer",
    });
    expect(ownAt(AFTER_BC5)?.share).toBeCloseTo(0.341);
    expect(replyAt(SETUP, "Nf6")).toBeDefined();
    expect(ownAt([...SETUP, "Nf6"])).toMatchObject({ move_san: "d3" });
  });

  it("stores the fixed setup from move 1 at reach 1", async () => {
    writeItalianTree();
    await generate();
    const setup = rowsOf(db).filter((row) => row.ply <= 5);
    expect(setup.map((row) => row.move_san)).toEqual(SETUP);
    expect(setup.map((row) => row.kind)).toEqual(["own", "reply", "own", "reply", "own"]);
    for (const row of setup) expect(row).toMatchObject({ reach: 1, source: "setup" });
    expect(JSON.parse(ownAt([])?.line_san ?? "null")).toEqual([]);
    expect(JSON.parse(replyAt(["e4"], "e5")?.line_san ?? "null")).toEqual(["e4"]);
    expect(replyAt(["e4"], "e5")?.share).toBeCloseTo(0.625);
  });

  it("keeps every reply reaching 1 in 50 since 3.Bc4 and none below it", async () => {
    writeItalianTree();
    await generate();
    const replies = rowsOf(db)
      .filter((row) => row.kind === "reply" && row.position_key === keyOf(SETUP))
      .map((row) => row.move_san)
      .sort();
    expect(replies).toEqual(["Bc5", "Nd4", "Nf6", "Nh6", "d6", "f6", "h6"]);
  });

  it("keeps a reply at exactly 1 in 50 and drops one just under", async () => {
    writeItalianTree();
    explorer.write(SETUP, EXPLORER_RATINGS, { Bc5: 60000, f6: 2000, a6: 1999 }, 100000);
    await generate();
    expect(replyAt(SETUP, "f6")?.reach).toBeCloseTo(0.02, 10);
    expect(replyAt(SETUP, "a6")).toBeUndefined();
  });

  it("drops a reply under the floor of 200 games even when its reach clears 1 in 50", async () => {
    writeItalianTree();
    explorer.write(SETUP, EXPLORER_RATINGS, { Bc5: 500, Nf6: 200, h6: 199 }, 1000);
    await generate();
    expect(replyAt(SETUP, "Nf6")).toBeDefined();
    expect(replyAt(SETUP, "h6")).toBeUndefined();
  });

  it("multiplies Black's shares along the line", async () => {
    writeItalianTree();
    await generate();
    // 3...Bc5 holds 22.6%, and 4...d6 is 5% of that: it would clear the goal only at the root.
    expect(replyAt(AFTER_C3, "d6")).toBeUndefined();
    expect(replyAt(AFTER_C3, "Nf6")?.reach).toBeCloseTo(0.226 * 0.6);
    expect(ownAt([...AFTER_C3, "Nf6"])?.reach).toBeCloseTo(0.226 * 0.6);
    expect(replyAt([...AFTER_C3, "Nf6", "d4"], "exd4")?.reach).toBeCloseTo(0.226 * 0.6 * 0.5);
  });

  it("walks to ply 30 and no further", async () => {
    explorer.autoplay = true;
    const result = await generate();
    expect(REPERTOIRE_MAX_PLY).toBe(30);
    expect(result.deepestPly).toBe(30);
    expect(Math.max(...rowsOf(db).map((row) => row.ply))).toBe(30);
    expect(rowsOf(db).filter((row) => row.kind === "own" && row.ply === 29)).toHaveLength(1);
  });

  it("reads Black's replies in the student's band and White's moves in the White band", async () => {
    writeItalianTree();
    await generate();
    const bandsAt = (line: string[]) =>
      new Set(
        explorer.calls.filter((call) => call.key === keyOf(line)).map((call) => call.ratings),
      );
    expect(bandsAt(SETUP)).toEqual(new Set([EXPLORER_RATINGS]));
    expect(bandsAt(AFTER_BC5)).toEqual(new Set([ITALIAN_WHITE_RATINGS]));
  });

  it("stores the group name and the variation named after White's answer to 3...Bc5", async () => {
    writeItalianTree();
    const result = await generate();
    expect(result.variation).toBe("Classical Variation (4.c3)");
    expect(variationsOf(db)).toEqual([
      { side: "white", group_name: "Italian Game", variation_name: "Classical Variation (4.c3)" },
    ]);
  });

  it("names the variation after the group when the book has no name for the line", async () => {
    writeItalianTree();
    await generate({}, NO_OPENING_NAMES);
    expect(variationsOf(db)).toMatchObject([{ variation_name: "Italian Game (4.c3)" }]);
  });

  it("stores each position's opening name from the last named position on its line", async () => {
    writeItalianTree();
    await generate();
    expect(ownAt([])?.opening_name).toBeNull();
    expect(ownAt(AFTER_BC5)?.opening_name).toBe("Italian Game: Giuoco Piano");
    expect(replyAt(AFTER_C3, "Nf6")?.opening_name).toBe("Italian Game: Classical Variation");
    expect(ownAt([...AFTER_C3, "Nf6"])?.opening_name).toBe("Italian Game: Classical Variation");
    expect(rowsOf(db).every((row) => row.idea === null)).toBe(true);
  });

  it("gives every White move a centipawn loss against the engine's best move", async () => {
    writeItalianTree();
    await generate();
    for (const row of rowsOf(db).filter((row) => row.kind === "own")) {
      expect(row.cp_loss).toEqual(expect.any(Number));
    }
    expect(ownAt(BEFORE_BC4)?.cp_loss).toBe(10);
    expect(ownAt(AFTER_BC5)?.cp_loss).toBe(10);
    expect(ownAt([...AFTER_C3, "Nf6"])?.cp_loss).toBe(0);
  });

  it("scores a setup move outside the engine's top lines from the position after it", async () => {
    writeItalianTree();
    engine.write(BEFORE_BC4, [["f1b5", 40]]).write(SETUP, [["g8f6", 15]]);
    await generate();
    expect(ownAt(BEFORE_BC4)?.cp_loss).toBe(55);
  });

  it("searches every White position at depth 16 for five lines within 30 s", async () => {
    writeItalianTree();
    await generate();
    expect(engine.requests.length).toBeGreaterThan(0);
    for (const request of engine.requests) {
      expect(request).toMatchObject({ depth: 16, multipv: 5, deadlineMs: 30_000 });
    }
  });

  it("scores a setup move outside the top lines at depth 16 within 30 s as well", async () => {
    writeItalianTree();
    engine.write(BEFORE_BC4, [["f1b5", 40]]).write(SETUP, [["g8f6", 15]]);
    await generate();
    const reply = engine.requests.find((request) => positionKey(request.fen) === keyOf(SETUP));
    expect(reply).toMatchObject({ depth: 16, multipv: 1, deadlineMs: 30_000 });
  });

  it("stores result counts for every White move whose next position has games", async () => {
    writeItalianTree();
    await generate();
    expect(ownAt(AFTER_BC5)).toMatchObject({ wins: 2500, draws: 200, losses: 2300 });
    expect(ownAt([...AFTER_C3, "Nf6", "d4", "exd4"])).toMatchObject({
      wins: null,
      draws: null,
      losses: null,
    });
    for (const row of rowsOf(db).filter((candidate) => candidate.kind === "own")) {
      const game = new Chess(`${row.position_key} 0 1`);
      applyUci(game, row.move_uci);
      const games = explorer.gamesWrittenAt(positionKey(game.fen()), EXPLORER_RATINGS);
      expect(row.wins !== null, `${row.move_san} after ${row.line_san}`).toBe(games > 0);
    }
  });

  it("stores the counts of the position after White's move even at the ply limit", async () => {
    writeItalianTree();
    await generate({ maxPly: 5 });
    expect(rowsOf(db).filter((row) => row.ply > 5)).toEqual([]);
    expect(ownAt(BEFORE_BC4)).toMatchObject({
      move_san: "Bc4",
      wins: 50000,
      draws: 4000,
      losses: 46000,
    });
  });

  it("adds no row on a second run and asks neither the network nor the engine", async () => {
    writeItalianTree();
    const first = await generate();
    const stored = rowsOf(db);
    const searches = engine.requests.length;
    const second = await generate();
    expect(first.created).toBe(stored.length);
    expect(second).toMatchObject({
      created: 0,
      requests: 0,
      truncated: false,
      ownMoves: first.ownMoves,
      replies: first.replies,
      deepestPly: first.deepestPly,
    });
    expect(second.cacheHits).toBeGreaterThan(0);
    expect(engine.requests).toHaveLength(searches);
    expect(rowsOf(db)).toEqual(stored);
    expect(variationsOf(db)).toHaveLength(1);
  });

  it("keeps a stored expected move when the data would now choose another", async () => {
    writeItalianTree();
    await generate();
    rmSync(cacheDir, { recursive: true, force: true });
    explorer.write(AFTER_BC5, ITALIAN_WHITE_RATINGS, { d3: 9000 }, 10000);
    engine.write(AFTER_BC5, [["d2d3", 50]]);
    const second = await generate();
    expect(second.created).toBe(0);
    expect(ownAt(AFTER_BC5)?.move_san).toBe("c3");
    expect(variationsOf(db)).toMatchObject([{ variation_name: "Classical Variation (4.c3)" }]);
  });

  it("resumes a run the request budget cut short and ends like an uninterrupted one", async () => {
    writeItalianTree();
    const cut = await generate({ maxRequests: 9 });
    expect(cut.truncated).toBe(true);
    expect(cut.created).toBeGreaterThan(0);
    const resumed = await generate();
    expect(resumed.truncated).toBe(false);
    const cleanDir = mkdtempSync(join(tmpdir(), "cc-repertoire-clean-"));
    const cleanDb = openDatabase(cleanDir);
    await generateRepertoire(
      cleanDb,
      engine,
      explorer,
      join(cleanDir, "explorer-cache"),
      clock,
      ITALIAN_FIXTURE_NAMES,
    );
    const comparable = (rows: RepertoireTestRow[]) =>
      rows.map(({ id: _id, repertoire_id: _repertoire, ...row }) => row);
    expect(comparable(rowsOf(db))).toEqual(comparable(rowsOf(cleanDb)));
    cleanDb.close();
    rmSync(cleanDir, { recursive: true, force: true });
  });

  it("stores nothing and says so when the budget ends before the variation has a name", async () => {
    writeItalianTree();
    const result = await generate({ maxRequests: 0 });
    expect(result).toMatchObject({
      variation: null,
      ownMoves: 0,
      replies: 0,
      deepestPly: 0,
      created: 0,
      truncated: true,
    });
    expect(variationsOf(db)).toEqual([]);
  });

  it("keeps one row per transposed position, on its likeliest line", async () => {
    writeItalianTree();
    // 3...Nf6 4.d3 Bc5 and 3...Bc5 4.d3 Nf6 meet in one position, the second one at higher reach.
    explorer
      .write(SETUP, EXPLORER_RATINGS, { Nf6: 40000, Bc5: 30000 }, 100000)
      .write(AFTER_BC5, ITALIAN_WHITE_RATINGS, { d3: 9000 }, 10000)
      .write([...SETUP, "Nf6", "d3"], EXPLORER_RATINGS, { Bc5: 1250 }, 5000)
      .write([...AFTER_BC5, "d3"], EXPLORER_RATINGS, { Nf6: 4000 }, 5000);
    engine.write(AFTER_BC5, [["d2d3", 40]]);
    await generate();
    const transposed = [...SETUP, "Nf6", "d3", "Bc5"];
    const own = rowsOf(db).filter(
      (row) => row.kind === "own" && row.position_key === keyOf(transposed),
    );
    expect(own).toHaveLength(1);
    expect(own[0]?.reach).toBeCloseTo(0.3 * 0.8);
    expect(JSON.parse(own[0]?.line_san ?? "null")).toEqual([...SETUP, "Bc5", "d3", "Nf6"]);
  });
});

describe("POST /api/openings/generate with the repertoire source", () => {
  it("builds the variation, adds no row on a second run and logs the counts", async () => {
    writeItalianTree();
    const log = new RecordingLog();
    const app = buildApp({
      db,
      log,
      generateOpenings: async () => ({ positions: 0, created: 0, updated: 0 }),
      generateRepertoireOpenings: () =>
        generateRepertoire(db, engine, explorer, cacheDir, clock, ITALIAN_FIXTURE_NAMES),
    });
    const post = () =>
      app.inject({
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["repertoire"] },
      });
    const first = await post();
    const stored = rowsOf(db);
    const second = await post();
    await app.close();
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(stored.length).toBeGreaterThan(0);
    expect(rowsOf(db)).toEqual(stored);
    expect(log.named("openings.generate")[0]?.fields).toMatchObject({
      sources: ["repertoire"],
      result: {
        repertoire: {
          ownMoves: stored.filter((row) => row.kind === "own").length,
          replies: stored.filter((row) => row.kind === "reply").length,
          deepestPly: Math.max(...stored.map((row) => row.ply)),
        },
      },
    });
  });
});

describe("the documentation of the repertoire source", () => {
  const repositoryRoot = join(import.meta.dirname, "../../../..");

  it("documents the source and its two rating groups under Openings in AGENTS.md", () => {
    const agents = readFileSync(join(repositoryRoot, "AGENTS.md"), "utf8");
    const openings = /- \*\*Openings:\*\*[\s\S]*?(?=\n- \*\*)/.exec(agents)?.[0] ?? "";
    expect(openings).toContain('`POST /api/openings/generate {sources: ["repertoire"]}`');
    expect(openings).toContain("`EXPLORER_RATINGS`");
    expect(openings).toContain("`ITALIAN_WHITE_RATINGS`");
  });

  it("never names a rating group the explorer does not have", () => {
    const filesUnder = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          return entry.name === "node_modules" || entry.name === "dist" ? [] : filesUnder(path);
        }
        return entry.isFile() ? [path] : [];
      });
    const files = [
      ...filesUnder(join(repositoryRoot, "packages")),
      join(repositoryRoot, "AGENTS.md"),
    ];
    const forbidden = [["400", "600"].join("-"), ["400", "600"].join(",")];
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((file) =>
      forbidden.some((text) => readFileSync(file, "utf8").includes(text)),
    );
    expect(offenders).toEqual([]);
  });
});
