import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MetOpening,
  RepertoireCoverageSchema,
  RepertoiresResponseSchema,
} from "@chess-coach/shared";
import { Chess, type Move } from "chess.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { type Database, openDatabase } from "../db/open.js";
import {
  createRepertoireVariation,
  insertRepertoireOwnMove,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { UciEngine } from "../engine/uci.js";
import { importFinishedGame } from "../import/pgn.js";
import { CachedExplorer } from "../openings/explorer-client.js";
import { positionKey } from "../openings/from-games.js";
import { parseRepertoireBranchBook } from "../openings/from-repertoire.js";
import { parseOpeningTable } from "../openings/names.js";

// The route reads the system clock, so a card is due or not by a wide margin either way.
const LONG_AGO = "2000-01-01T00:00:00.000Z";
const FAR_AHEAD = "2999-01-01T00:00:00.000Z";
const SETUP = ["e4", "e5", "Nf3", "Nc6", "Bc4"];

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-repertoire-route-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function placeOf(line: string[], san: string): { positionKey: string; uci: string } {
  const board = new Chess();
  for (const played of line) board.move(played);
  const key = positionKey(board.fen());
  const move = board.move(san);
  return { positionKey: key, uci: `${move.from}${move.to}${move.promotion ?? ""}` };
}

// Every line starts with the setup; a White move sits where the line before it has an even length.
function addVariation(name: string, branches: string[][]): number {
  const { id } = createRepertoireVariation(db, {
    side: "white",
    groupName: "Italian Game",
    variationName: name,
  });
  for (const branch of branches) {
    const sans = [...SETUP, ...branch];
    sans.forEach((san, index) => {
      const line = sans.slice(0, index);
      const row = {
        repertoireId: id,
        ...placeOf(line, san),
        ply: index + 1,
        line,
        reach: 1 / (branches.indexOf(branch) + 1),
        openingName: null,
        san,
        share: null,
        // As the generator stores them: the setup moves first, then what the explorer gave.
        source: index < SETUP.length ? ("setup" as const) : ("explorer" as const),
      };
      if (index % 2 === 1) upsertRepertoireReply(db, row);
      else if (!ownMoveStored(id, row.positionKey)) {
        insertRepertoireOwnMove(db, { ...row, cpLoss: 0, evalCp: 25, results: null });
      }
    });
  }
  return id;
}

const ownMoveStored = (repertoireId: number, key: string): boolean =>
  db
    .prepare(
      "SELECT 1 FROM repertoire_positions WHERE repertoire_id = ? AND position_key = ? AND kind = 'own'",
    )
    .get(repertoireId, key) !== undefined;

interface CardOptions {
  introducedAt?: string;
  intervalHours?: number;
}

function addCard(line: string[], san: string, nextReviewAt: string, card: CardOptions = {}): void {
  const place = placeOf(line, san);
  db.prepare(
    `INSERT INTO repertoire_cards (position_key, move_uci, introduced_at, next_review_at,
       interval_hours)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    place.positionKey,
    place.uci,
    card.introducedAt ?? LONG_AGO,
    nextReviewAt,
    card.intervalHours ?? 0,
  );
}

function setCardInterval(line: string[], san: string, intervalHours: number): void {
  const place = placeOf(line, san);
  db.prepare(
    "UPDATE repertoire_cards SET interval_hours = ? WHERE position_key = ? AND move_uci = ?",
  ).run(intervalHours, place.positionKey, place.uci);
}

// A card on every White move that has none, as a student who has met them all has: none is new, so
// none waits.
function addCardsForEveryMove(): void {
  db.prepare(
    `INSERT OR IGNORE INTO repertoire_cards (position_key, move_uci, introduced_at, next_review_at)
     SELECT DISTINCT position_key, move_uci, ?, ? FROM repertoire_positions WHERE kind = 'own'`,
  ).run(LONG_AGO, LONG_AGO);
}

async function getRepertoires() {
  const app = buildApp({ db });
  const response = await app.inject({ method: "GET", url: "/api/repertoires" });
  await app.close();
  return response;
}

describe("GET /api/repertoires", () => {
  it("returns each repertoire with the moves each scope would serve", async () => {
    const classical = addVariation("Classical Variation (4.c3)", [
      ["Bc5", "c3", "Nf6", "d4"],
      ["Nf6", "d3"],
    ]);
    const wide = addVariation(
      "Wide",
      ["Bc5", "Nf6", "Be7", "d6", "h6", "a6", "g6", "Qe7", "Na5"].map((reply) => [reply, "d3"]),
    );
    // A move both variations play has one card, so it is due, or not, in both at once.
    addCard(["e4", "e5", "Nf3", "Nc6"], "Bc4", FAR_AHEAD);
    addCard([], "e4", LONG_AGO);
    addCardsForEveryMove();

    const response = await getRepertoires();
    expect(response.statusCode).toBe(200);
    const body = RepertoiresResponseSchema.parse(response.json());
    expect(body.repertoires).toEqual([
      {
        id: classical,
        side: "white",
        group_name: "Italian Game",
        variation_name: "Classical Variation (4.c3)",
        moves: { recommended: 5, due: 5, all: 6 },
      },
      {
        id: wide,
        side: "white",
        group_name: "Italian Game",
        variation_name: "Wide",
        moves: { recommended: 10, due: 11, all: 12 },
      },
    ]);
  });

  it("answers an empty list before any repertoire is stored", async () => {
    const response = await getRepertoires();
    expect(response.statusCode).toBe(200);
    expect(RepertoiresResponseSchema.parse(response.json())).toEqual({
      repertoires: [],
      groups: [],
      sides: [],
      met: [],
      branches: [],
    });
  });
});

describe("GET /api/repertoires at the group and side levels", () => {
  it("counts each group and each side with a move two variations share counted once", async () => {
    addVariation("Classical Variation (4.c3)", [["Bc5", "c3"]]);
    addVariation("Giuoco Pianissimo (4.d3)", [["Bc5", "d3"]]);
    addRootedUnit(["e4", "d5"], "Scandinavian Defense", "exd5");
    // 1.e4 opens all three units and has one card, not due, so every level leaves it out alike.
    addCard([], "e4", FAR_AHEAD);
    // 2.Nf3 and 3.Bc4 are known, stable and due: 4.c3, 4.d3 and 2.exd5 are the new moves.
    const stable = { intervalHours: 72 };
    addCard(["e4", "e5"], "Nf3", LONG_AGO, stable);
    addCard(["e4", "e5", "Nf3", "Nc6"], "Bc4", LONG_AGO, stable);

    const body = RepertoiresResponseSchema.parse((await getRepertoires()).json());

    expect(body.repertoires.map((entry) => entry.moves)).toEqual([
      { recommended: 3, due: 3, all: 4 },
      { recommended: 3, due: 3, all: 4 },
      { recommended: 1, due: 1, all: 2 },
    ]);
    // 4.c3 and 4.d3 answer one position, so a drill over both takes one of them and the other waits.
    expect(body.groups).toEqual([
      {
        side: "white",
        group_name: "Italian Game",
        moves: { recommended: 3, due: 3, all: 4 },
      },
      {
        side: "white",
        group_name: "Scandinavian Defense",
        moves: { recommended: 1, due: 1, all: 2 },
      },
    ]);
    expect(body.sides).toEqual([{ side: "white", moves: { recommended: 4, due: 4, all: 5 } }]);
  });

  it("holds 2.exd5 back for 2.Nf3, its sibling, only at the level that covers both openings", async () => {
    const italian = addVariation("Classical Variation (4.c3)", [["Bc5", "c3"]]);
    addRootedUnit(["e4", "d5"], "Scandinavian Defense", "exd5");
    addCard([], "e4", LONG_AGO);
    addCard(["e4", "e5"], "Nf3", LONG_AGO, { intervalHours: 24 });
    addCard(["e4", "e5", "Nf3", "Nc6"], "Bc4", LONG_AGO);
    addCard(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"], "c3", LONG_AGO);
    const counts = async () => {
      const body = RepertoiresResponseSchema.parse((await getRepertoires()).json());
      return {
        italian: body.repertoires.find((entry) => entry.id === italian)?.moves,
        scandinavian: body.groups?.find((group) => group.group_name === "Scandinavian Defense")
          ?.moves,
        side: body.sides?.[0]?.moves,
      };
    };

    // 2.Nf3 is shown but not stable: the side's drill leaves 2.exd5 out, its own opening does not.
    expect(await counts()).toEqual({
      italian: { recommended: 4, due: 4, all: 4 },
      scandinavian: { recommended: 2, due: 2, all: 2 },
      side: { recommended: 4, due: 4, all: 4 },
    });

    setCardInterval(["e4", "e5"], "Nf3", 72);
    expect(await counts()).toEqual({
      italian: { recommended: 4, due: 4, all: 4 },
      scandinavian: { recommended: 2, due: 2, all: 2 },
      side: { recommended: 5, due: 5, all: 5 },
    });
  });
});

const SETUP_CARDS: [string[], string][] = [
  [[], "e4"],
  [["e4", "e5"], "Nf3"],
  [["e4", "e5", "Nf3", "Nc6"], "Bc4"],
];

describe("GET /api/repertoires pacing of new moves", () => {
  const AFTER_BC5 = [...SETUP, "Bc5"];
  const AFTER_NF6 = [...SETUP, "Nf6"];
  let classical: number;

  const classicalCounts = async () => {
    const body = RepertoiresResponseSchema.parse((await getRepertoires()).json());
    return body.repertoires.find((entry) => entry.id === classical)?.moves;
  };

  beforeEach(() => {
    classical = addVariation("Classical Variation (4.c3)", [
      ["Bc5", "c3", "Nf6", "d4"],
      ["Nf6", "d3"],
    ]);
  });

  it("leaves out a new move while a sibling is short of stable or an earlier move of its line is new", async () => {
    for (const [line, san] of SETUP_CARDS) addCard(line, san, LONG_AGO);
    // 4.c3 leads its sibling 4.d3, and 5.d4 below it waits for 4.c3 to be shown.
    expect(await classicalCounts()).toEqual({ recommended: 4, due: 4, all: 4 });

    // 4.d3 is shown, not due and not stable: 4.c3 waits for it, and so does 5.d4.
    addCard(AFTER_NF6, "d3", FAR_AHEAD, { intervalHours: 24 });
    expect(await classicalCounts()).toEqual({ recommended: 3, due: 3, all: 4 });

    setCardInterval(AFTER_NF6, "d3", 72);
    expect(await classicalCounts()).toEqual({ recommended: 4, due: 4, all: 5 });

    // Shown once, 4.c3 only has to be known for 5.d4 to enter.
    addCard(AFTER_BC5, "c3", LONG_AGO);
    expect(await classicalCounts()).toEqual({ recommended: 5, due: 5, all: 6 });
  });

  it("leaves out the new moves the day's limit holds back, counting only cards introduced in the last 24 hours", async () => {
    const hoursAgo = (hours: number): string =>
      new Date(Date.now() - hours * 3_600_000).toISOString();
    const known = [...SETUP_CARDS, [AFTER_BC5, "c3"] as [string[], string]];
    for (const [line, san] of known) {
      addCard(line, san, LONG_AGO, { introducedAt: hoursAgo(1), intervalHours: 72 });
    }
    // Four cards in the last day leave room for 5.d4, the likelier of the two new moves.
    expect(await classicalCounts()).toEqual({ recommended: 5, due: 5, all: 5 });

    // A fifth, which is 4.d3 and not due, leaves none: 5.d4 waits, though nothing else holds it.
    addCard(AFTER_NF6, "d3", FAR_AHEAD, { introducedAt: hoursAgo(1), intervalHours: 72 });
    expect(await classicalCounts()).toEqual({ recommended: 4, due: 4, all: 5 });

    // Introduced more than a day ago, the five leave room again.
    db.prepare("UPDATE repertoire_cards SET introduced_at = ?").run(hoursAgo(25));
    expect(await classicalCounts()).toEqual({ recommended: 5, due: 5, all: 6 });
  });
});

// The book after 3.Bc4: three White moves against 3...Bc5, two against 3...Nf6 and two against
// 3...h6, which no stored variation reaches.
const BRANCH_BOOK_TABLE = [
  "eco\tname\tpgn\tuci\tepd",
  ...[
    "3. Bc4 Bc5 4. c3",
    "3. Bc4 Bc5 4. d3",
    "3. Bc4 Bc5 4. b4",
    "3. Bc4 Nf6 4. d3",
    "3. Bc4 Nf6 4. Ng5",
    "3. Bc4 h6 4. d3",
    "3. Bc4 h6 4. c3",
  ].map((line) => `C50\tLine\t1. e4 e5 2. Nf3 Nc6 ${line}\t-\t-`),
].join("\n");

const keyAfterLine = (line: string[]): string => {
  const board = new Chess();
  for (const san of line) board.move(san);
  return positionKey(board.fen());
};

const BRANCH_NAMES = parseOpeningTable(
  [
    "eco\tname\tpgn\tuci\tepd",
    ...(
      [
        ["Italian Game: Giuoco Piano", ["Bc5"]],
        ["Italian Game: Classical Variation", ["Bc5", "c3"]],
        ["Italian Game: Giuoco Pianissimo", ["Bc5", "d3"]],
        ["Italian Game: Evans Gambit", ["Bc5", "b4"]],
        ["Italian Game: Two Knights Defense", ["Nf6"]],
        ["Italian Game: Two Knights Defense, Knight Attack", ["Nf6", "Ng5"]],
        ["Italian Game: Two Knights Defense, Modern Bishop's Opening", ["Nf6", "d3"]],
      ] as const
    ).map(([name, moves]) => `C50\t${name}\t-\t-\t${keyAfterLine([...SETUP, ...moves])}`),
  ].join("\n"),
);

async function getBranches() {
  const app = buildApp({
    db,
    openingNames: BRANCH_NAMES,
    repertoireBranches: parseRepertoireBranchBook(BRANCH_BOOK_TABLE),
  });
  const response = await app.inject({ method: "GET", url: "/api/repertoires" });
  await app.close();
  expect(response.statusCode).toBe(200);
  return RepertoiresResponseSchema.parse(response.json()).branches;
}

describe("GET /api/repertoires branch points", () => {
  it("lists the book's White moves where the first variation goes, named and with the variation that holds each", async () => {
    const classical = addVariation("Classical Variation (4.c3)", [
      ["Bc5", "c3"],
      ["Nf6", "d3"],
    ]);
    const pianissimo = addVariation("Giuoco Pianissimo (4.d3)", [["Bc5", "d3"]]);
    // A run cut short before it stored 4.b4 still holds its variation by name.
    const evans = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "Evans Gambit (4.b4)",
    }).id;

    expect(await getBranches()).toEqual([
      {
        group_name: "Italian Game",
        line: [...SETUP, "Bc5"],
        choices: [
          { san: "b4", variation_name: "Evans Gambit (4.b4)", repertoire_id: evans },
          { san: "c3", variation_name: "Classical Variation (4.c3)", repertoire_id: classical },
          { san: "d3", variation_name: "Giuoco Pianissimo (4.d3)", repertoire_id: pianissimo },
        ],
      },
      {
        group_name: "Italian Game",
        line: [...SETUP, "Nf6"],
        choices: [
          {
            san: "d3",
            variation_name: "Two Knights Defense, Modern Bishop's Opening (4.d3)",
            repertoire_id: classical,
          },
          {
            san: "Ng5",
            variation_name: "Two Knights Defense, Knight Attack (4.Ng5)",
            repertoire_id: null,
          },
        ],
      },
    ]);
  });

  it("lists none before the Italian is built, and none for another group's unit", async () => {
    addRootedUnit(["e4", "d5"], "Scandinavian Defense", "exd5");
    expect(await getBranches()).toEqual([]);
  });

  it("puts the likeliest position first", async () => {
    addVariation("Classical Variation (4.c3)", [
      ["Nf6", "d3"],
      ["Bc5", "c3"],
    ]);
    expect((await getBranches())?.map((branch) => branch.line.at(-1))).toEqual(["Nf6", "Bc5"]);
  });
});

// A game reviewed against the Italian: the student was White, and the review row holds the move that
// took the game out of the line the way the review writes it.
let gameCount = 0;
function addReviewedGame(
  line: string[],
  review: { outcome?: string; color?: "white" | "black"; leftPly?: number; name?: string | null },
  repertoireId: number,
): number {
  gameCount += 1;
  const pgn = line
    .map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}. ${san}` : san))
    .join(" ");
  const id = importFinishedGame(db, {
    pgn: `[Result "1-0"]\n\n${pgn} 1-0`,
    playerColor: review.color ?? "white",
    source: "pgn",
    sourceId: `met-${gameCount}`,
  }) as number;
  const board = new Chess();
  const left = review.leftPly ?? null;
  let key: string | null = null;
  let move: Move | null = null;
  for (const [index, san] of line.entries()) {
    if (index + 1 === left) key = positionKey(board.fen());
    const played = board.move(san);
    if (index + 1 === left) move = played;
  }
  db.prepare(
    `INSERT INTO repertoire_game_reviews
       (game_id, repertoire_id, reviewed_at, outcome, followed_plies, passed_moves, left_ply,
        left_position_key, left_san, left_uci, opening_name)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    repertoireId,
    LONG_AGO,
    review.outcome ?? "not_reached",
    left,
    key,
    move?.san ?? null,
    move ? `${move.from}${move.to}` : null,
    review.name ?? null,
  );
  return id;
}

// The rows the generator stores for the root of a unit: its moves as setup rows, then White's answer.
function addRootedUnit(root: string[], groupName: string, answer: string): number {
  const { id } = createRepertoireVariation(db, {
    side: "white",
    groupName,
    variationName: `Rooted (${answer})`,
  });
  [...root, answer].forEach((san, index) => {
    const line = [...root, answer].slice(0, index);
    const row = {
      repertoireId: id,
      ...placeOf(line, san),
      ply: index + 1,
      line,
      reach: 1,
      openingName: null,
      san,
      share: null,
      source: index < root.length ? ("setup" as const) : ("explorer" as const),
    };
    if (index % 2 === 1) upsertRepertoireReply(db, row);
    else insertRepertoireOwnMove(db, { ...row, cpLoss: 0, evalCp: 25, results: null });
  });
  return id;
}

async function getMet(): Promise<MetOpening[]> {
  const response = await getRepertoires();
  expect(response.statusCode).toBe(200);
  return RepertoiresResponseSchema.parse(response.json()).met;
}

describe("GET /api/repertoires met openings", () => {
  let italian: number;

  beforeEach(() => {
    gameCount = 0;
    // The Italian's own setup: White's moves and Black's replies, ending on 3.Bc4.
    italian = addVariation("Classical Variation (4.c3)", [["Bc5", "c3", "Nf6", "d4"]]);
  });

  it("lists, for each position the games left to, the root, the opening, the games and no unit yet", async () => {
    addReviewedGame(["e4", "d5", "exd5"], { leftPly: 2, name: "Scandinavian Defense" }, italian);
    addReviewedGame(["e4", "d5", "Nc3"], { leftPly: 2, name: "Scandinavian Defense" }, italian);
    addReviewedGame(["e4", "Nf6", "e5"], { leftPly: 2, name: "Alekhine Defense" }, italian);
    addReviewedGame(
      ["e4", "e5", "Nf3", "d6", "d4"],
      { leftPly: 4, name: "Philidor Defense" },
      italian,
    );
    expect(await getMet()).toEqual([
      { root: ["e4", "d5"], opening_name: "Scandinavian Defense", games: 2, repertoire_id: null },
      { root: ["e4", "Nf6"], opening_name: "Alekhine Defense", games: 1, repertoire_id: null },
      {
        root: ["e4", "e5", "Nf3", "d6"],
        opening_name: "Philidor Defense",
        games: 1,
        repertoire_id: null,
      },
    ]);
  });

  it("puts the most met first and breaks a tie by the game that met it first", async () => {
    addReviewedGame(["e4", "c6", "d4"], { leftPly: 2 }, italian);
    addReviewedGame(["e4", "e6", "d4"], { leftPly: 2 }, italian);
    addReviewedGame(["e4", "e6", "Nc3"], { leftPly: 2 }, italian);
    expect((await getMet()).map((entry) => [entry.root.join(" "), entry.games])).toEqual([
      ["e4 e6", 2],
      ["e4 c6", 1],
    ]);
  });

  it("leaves out a departure by White, a game as Black and a game that stayed in the line", async () => {
    addReviewedGame(["d4", "d5"], { leftPly: 1 }, italian);
    addReviewedGame(["e4", "e5", "d4", "exd4"], { leftPly: 3 }, italian);
    addReviewedGame(["e4", "d5", "exd5"], { outcome: "other_side", color: "black" }, italian);
    addReviewedGame(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"], { outcome: "in_book" }, italian);
    addReviewedGame(["e4", "e5"], { outcome: "departed", leftPly: 2 }, italian);
    expect(await getMet()).toEqual([]);
  });

  it("reads the root back from the moves of the game, up to the move that left", async () => {
    addReviewedGame(["e4", "e5", "Nf3", "Bc5", "Nxe5", "Bxf2+"], { leftPly: 4 }, italian);
    expect((await getMet()).map((entry) => entry.root)).toEqual([["e4", "e5", "Nf3", "Bc5"]]);
  });

  it("names the unit built from a root and none for a root without one", async () => {
    addReviewedGame(["e4", "d5", "exd5"], { leftPly: 2, name: "Scandinavian Defense" }, italian);
    addReviewedGame(["e4", "Nf6", "e5"], { leftPly: 2, name: "Alekhine Defense" }, italian);
    addReviewedGame(["e4", "e5", "Nf3", "d6", "d4"], { leftPly: 4 }, italian);
    const scandinavian = addRootedUnit(["e4", "d5"], "Scandinavian Defense", "exd5");
    expect((await getMet()).map((entry) => [entry.root.join(" "), entry.repertoire_id])).toEqual([
      ["e4 d5", scandinavian],
      ["e4 Nf6", null],
      ["e4 e5 Nf3 d6", null],
    ]);
  });

  it("does not take the Italian for the unit of a root that shares its first moves", async () => {
    addReviewedGame(["e4", "e5", "Nf3", "Nf6", "Nxe5"], { leftPly: 4 }, italian);
    const russian = addRootedUnit(["e4", "e5", "Nf3", "Nf6"], "Russian Game", "Nxe5");
    expect((await getMet()).map((entry) => entry.repertoire_id)).toEqual([russian]);
  });

  it("does not take a unit with a longer root for the unit of a shorter one that shares its moves", async () => {
    addReviewedGame(["e4", "e5", "Nf3", "Nf6", "Nxe5"], { leftPly: 4 }, italian);
    // Its fixed line passes through 2...Nf6 and goes on; only a unit whose root ends there is the one.
    const longer = addRootedUnit(["e4", "e5", "Nf3", "Nf6", "Bc4", "Nxe4"], "Two Knights", "Bxf7+");
    expect((await getMet()).map((entry) => entry.repertoire_id)).toEqual([null]);
    const shorter = addRootedUnit(["e4", "e5", "Nf3", "Nf6"], "Russian Game", "Nxe5");
    expect(shorter).not.toBe(longer);
    expect((await getMet()).map((entry) => entry.repertoire_id)).toEqual([shorter]);
  });

  it("lists a root again when its unit is deleted", async () => {
    addReviewedGame(["e4", "d5", "exd5"], { leftPly: 2 }, italian);
    const unit = addRootedUnit(["e4", "d5"], "Scandinavian Defense", "exd5");
    expect((await getMet())[0]?.repertoire_id).toBe(unit);
    db.prepare("DELETE FROM repertoires WHERE id = ?").run(unit);
    expect((await getMet())[0]).toMatchObject({ root: ["e4", "d5"], repertoire_id: null });
  });
});

async function getCoverage(app: ReturnType<typeof buildApp>, id: number | string) {
  const response = await app.inject({ method: "GET", url: `/api/repertoires/${id}/coverage` });
  await app.close();
  return response;
}

function addReplyWithoutAnswer(id: number, line: string[], san: string, reach: number): void {
  upsertRepertoireReply(db, {
    repertoireId: id,
    ...placeOf(line, san),
    ply: line.length + 1,
    line,
    reach,
    openingName: null,
    san,
    share: reach,
    source: "explorer",
  });
}

// The classical line and a second branch, with Black's 4...d6 stored and no White move after it.
function addVariationWithGap(): number {
  const id = addVariation("Classical Variation (4.c3)", [
    ["Bc5", "c3", "Nf6", "d4"],
    ["Nf6", "d3"],
  ]);
  addReplyWithoutAnswer(id, [...SETUP, "Bc5", "c3"], "d6", 0.3);
  return id;
}

// A second gap, likelier than the first and in the branch the walk meets after it, so that only
// sorting the gaps puts the likelier one first.
function addVariationWithTwoGaps(): number {
  const id = addVariationWithGap();
  addReplyWithoutAnswer(id, [...SETUP, "Nf6", "d3"], "d5", 0.45);
  return id;
}

describe("GET /api/repertoires/:id/coverage", () => {
  it("returns the covered share, the gaps with their lines and the largest gap", async () => {
    const id = addVariationWithGap();
    const response = await getCoverage(buildApp({ db }), id);
    expect(response.statusCode).toBe(200);
    const body = RepertoireCoverageSchema.parse(response.json());
    const gap = { line: [...SETUP, "Bc5", "c3", "d6"], incidence: 0.3, position: 3 };
    expect(body).toMatchObject({
      repertoire_id: id,
      goal_one_in: 50,
      rating_band: "0-1199",
      gaps: [gap],
      largest_gap: gap,
      start: 2,
    });
    // The lines end after 5.d4 (reach 1) and after 3...Nf6 4.d3 (0.5); the gap holds 0.3: 1.5 / 1.8.
    expect(body.covered_percent).toBe(83.3);
    expect(body.positions[body.start]?.line).toEqual(SETUP);
  });

  it("names the likeliest of two gaps the largest, though the walk meets the rarer one first", async () => {
    const id = addVariationWithTwoGaps();
    const body = RepertoireCoverageSchema.parse((await getCoverage(buildApp({ db }), id)).json());
    const likelier = { line: [...SETUP, "Nf6", "d3", "d5"], incidence: 0.45, position: 5 };
    const rarer = { line: [...SETUP, "Bc5", "c3", "d6"], incidence: 0.3, position: 3 };
    expect(body.gaps).toEqual([likelier, rarer]);
    expect(body.largest_gap).toEqual(likelier);
  });

  it("answers no scores for a variation whose moves carry no counts", async () => {
    const id = addVariationWithGap();
    const body = RepertoireCoverageSchema.parse((await getCoverage(buildApp({ db }), id)).json());
    expect(body.scores).toEqual({ line_ends: 0, expected_score: null, soundness: null });
  });

  it("answers 404 for a variation that does not exist and for an id that is no positive integer", async () => {
    addVariationWithGap();
    for (const id of ["999", "0", "-3", "1.5", "abc"]) {
      const response = await getCoverage(buildApp({ db }), id);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: "repertoire_not_found",
        message: "no such repertoire",
      });
    }
  });

  it("serves the coverage without asking the network, the explorer or the engine", async () => {
    const id = addVariationWithGap();
    const refuse = (asked: string) => (): never => {
      throw new Error(`the coverage asked ${asked}`);
    };
    const network = vi.fn(refuse("the network"));
    vi.stubGlobal("fetch", network);
    const explorer = vi
      .spyOn(CachedExplorer.prototype, "position")
      .mockImplementation(refuse("the explorer"));
    const engine = vi.spyOn(UciEngine.prototype, "search").mockImplementation(refuse("the engine"));
    const response = await getCoverage(buildApp({ db }), id);
    expect(response.statusCode).toBe(200);
    expect([network, explorer, engine].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
  });
});
