import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MetOpening,
  RepertoireCoverageSchema,
  RepertoiresResponseSchema,
} from "@chess-coach/shared";
import { Chess, type Move } from "chess.js";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { insertDrillReview, repertoireCardKey } from "../db/drill-reviews.js";
import { type Database, openDatabase } from "../db/open.js";
import { insertRepertoireFirstAttempt } from "../db/repertoire-cards.js";
import {
  createRepertoireVariation,
  insertRepertoireOwnMove,
  REPERTOIRE_REBUILD_GROUP_SUFFIX,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { UciEngine } from "../engine/uci.js";
import { importFinishedGame } from "../import/pgn.js";
import { CachedExplorer } from "../openings/explorer-client.js";
import { positionKey } from "../openings/from-games.js";
import { parseRepertoireBranchBook } from "../openings/from-repertoire.js";
import { parseOpeningTable } from "../openings/names.js";
import { GRADE } from "../srs/fsrs.js";
import { type RepertoireRebuildState, registerRepertoireRoutes } from "./repertoires.js";

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
function addVariation(name: string, branches: string[][], groupName = "Italian Game"): number {
  const { id } = createRepertoireVariation(db, {
    side: "white",
    groupName,
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

function addCard(line: string[], san: string, nextReviewAt: string): void {
  const place = placeOf(line, san);
  db.prepare(
    `INSERT INTO repertoire_cards (position_key, move_uci, introduced_at, next_review_at,
       interval_hours)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(place.positionKey, place.uci, LONG_AGO, nextReviewAt);
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

    const response = await getRepertoires();
    expect(response.statusCode).toBe(200);
    const body = RepertoiresResponseSchema.parse(response.json());
    // The counts and the build fields as before; the figures and the line have tests of their own.
    expect(body.repertoires).toMatchObject([
      {
        id: classical,
        side: "white",
        group_name: "Italian Game",
        variation_name: "Classical Variation (4.c3)",
        moves: { recommended: 5, due: 5, all: 6 },
        points: null,
        root: null,
        branch: null,
      },
      {
        id: wide,
        side: "white",
        group_name: "Italian Game",
        variation_name: "Wide",
        moves: { recommended: 10, due: 11, all: 12 },
        points: null,
        root: null,
        branch: null,
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
      found: { moves: { recommended: 0, due: 0, all: 0, missed: 0 } },
      met: [],
      branches: [],
      rebuilding_id: null,
    });
  });

  it("reports side black for a Black repertoire", async () => {
    const { id } = createRepertoireVariation(db, {
      side: "black",
      groupName: "Caro-Kann Defense",
      variationName: "Main Line",
    });
    const body = RepertoiresResponseSchema.parse((await getRepertoires()).json());
    expect(body.repertoires.find((entry) => entry.id === id)).toMatchObject({
      side: "black",
      group_name: "Caro-Kann Defense",
    });
  });
});

describe("GET /api/repertoires: what each unit was built with and from", () => {
  const BRANCH = [...SETUP, "Bc5", "d3"];

  it("returns the points, the root and the branch of each unit, and null where a unit has none", async () => {
    // Built before the points were stored: its points and branch are null, and so is its root,
    // since the Italian's setup is no root.
    const before = addVariation("Classical Variation (4.c3)", [["Bc5", "c3"]]);
    const branched = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "Giuoco Pianissimo (4.d3)",
      points: { effectiveness: 3, soundness: 2, learnability: 1 },
      branch: BRANCH,
    }).id;
    const rooted = addRootedUnit(["e4", "d5"], "Scandinavian Defense", "exd5");
    db.prepare(
      `UPDATE repertoires SET points_effectiveness = 1, points_soundness = 1,
         points_learnability = 4 WHERE id = ?`,
    ).run(rooted);

    const response = await getRepertoires();

    expect(response.statusCode).toBe(200);
    const listed = RepertoiresResponseSchema.parse(response.json()).repertoires;
    expect(listed.map(({ id, points, root, branch }) => ({ id, points, root, branch }))).toEqual([
      { id: before, points: null, root: null, branch: null },
      {
        id: branched,
        points: { effectiveness: 3, soundness: 2, learnability: 1 },
        root: null,
        branch: BRANCH,
      },
      {
        id: rooted,
        points: { effectiveness: 1, soundness: 1, learnability: 4 },
        root: ["e4", "d5"],
        branch: null,
      },
    ]);
  });
});

// A unit as an import of a PGN file stores it: marked `pgn`, its moves from the file and none of
// them carrying a centipawn loss or an evaluation.
function addImportedUnit(): number {
  const line = ["d4", "d5", "Bf4", "Nf6", "e3"];
  const { id } = createRepertoireVariation(db, {
    side: "white",
    groupName: "London System",
    variationName: "Main line",
  });
  db.prepare("UPDATE repertoires SET origin = 'pgn' WHERE id = ?").run(id);
  line.forEach((san, index) => {
    const row = {
      repertoireId: id,
      ...placeOf(line.slice(0, index), san),
      ply: index + 1,
      line: line.slice(0, index),
      reach: 1,
      openingName: null,
      san,
      share: null,
      source: "pgn" as const,
    };
    if (index % 2 === 1) upsertRepertoireReply(db, row);
    else insertRepertoireOwnMove(db, { ...row, cpLoss: null, evalCp: null, results: null });
  });
  return id;
}

describe("GET /api/repertoires: where each unit came from", () => {
  it("returns generated for a unit the builder stored and pgn for one read from a file", async () => {
    const built = addVariation("Classical Variation (4.c3)", [["Bc5", "c3"]]);
    const imported = addImportedUnit();

    const response = await getRepertoires();

    expect(response.statusCode).toBe(200);
    const listed = RepertoiresResponseSchema.parse(response.json()).repertoires;
    expect(listed.map(({ id, origin }) => ({ id, origin }))).toEqual([
      { id: built, origin: "generated" },
      { id: imported, origin: "pgn" },
    ]);
  });

  it("lists a unit whose moves carry no figures with its moves counted", async () => {
    const imported = addImportedUnit();

    const body = RepertoiresResponseSchema.parse((await getRepertoires()).json());

    expect(body.repertoires.find((entry) => entry.id === imported)).toMatchObject({
      side: "white",
      group_name: "London System",
      moves_total: 3,
    });
  });

  it("gives an imported unit and its opening no covered share, though their moves and attempts are counted", async () => {
    const built = addVariation("Classical Variation (4.c3)", [["Bc5", "c3"]]);
    const imported = addImportedUnit();
    insertRepertoireFirstAttempt(
      db,
      { ...placeOf([], "d4"), repertoireId: imported, correct: true },
      new Date(Date.now() - 2 * 86_400_000).toISOString(),
    );

    const body = RepertoiresResponseSchema.parse((await getRepertoires()).json());

    const unit = body.repertoires.find((entry) => entry.id === imported);
    const opening = body.groups?.find((entry) => entry.group_name === "London System");
    for (const figures of [unit, opening]) {
      expect(figures).toMatchObject({
        moves_total: 3,
        remembered_30d: { right: 1, of: 1 },
        covered_percent: null,
      });
    }
    expect(body.repertoires.find((entry) => entry.id === built)?.covered_percent).toBe(100);
  });
});

describe("GET /api/repertoires at the group and side levels", () => {
  it("counts each group and each side with a move two variations share counted once", async () => {
    addVariation("Classical Variation (4.c3)", [["Bc5", "c3"]]);
    addVariation("Giuoco Pianissimo (4.d3)", [["Bc5", "d3"]]);
    addRootedUnit(["e4", "d5"], "Scandinavian Defense", "exd5");
    // 1.e4 opens all three units and has one card, not due, so every level leaves it out of due alike.
    addCard([], "e4", FAR_AHEAD);
    // 2.Nf3 and 3.Bc4 are known and due: 4.c3, 4.d3 and 2.exd5 are new, so they are due too.
    addCard(["e4", "e5"], "Nf3", LONG_AGO);
    addCard(["e4", "e5", "Nf3", "Nc6"], "Bc4", LONG_AGO);

    const body = RepertoiresResponseSchema.parse((await getRepertoires()).json());

    expect(body.repertoires.map((entry) => entry.moves)).toEqual([
      { recommended: 3, due: 3, all: 4, missed: 0 },
      { recommended: 3, due: 3, all: 4, missed: 0 },
      { recommended: 1, due: 1, all: 2, missed: 0 },
    ]);
    // 4.c3 and 4.d3 answer one position, and a drill over both serves both of them.
    expect(body.groups).toMatchObject([
      {
        side: "white",
        group_name: "Italian Game",
        moves: { recommended: 4, due: 4, all: 5 },
      },
      {
        side: "white",
        group_name: "Scandinavian Defense",
        moves: { recommended: 1, due: 1, all: 2 },
      },
    ]);
    expect(body.sides).toEqual([
      { side: "white", moves: { recommended: 5, due: 5, all: 6, missed: 0 } },
    ]);
  });

  // Black's replies to 3.Bc4 that White answers with 4.d3: the same position gives White thirty
  // moves of its own when each reply has an answer.
  function repliesAnsweredByD3(count: number): string[] {
    const board = new Chess();
    for (const san of SETUP) board.move(san);
    const answered = board.moves().filter((reply) => {
      const after = new Chess(board.fen());
      after.move(reply);
      return after.moves().includes("d3");
    });
    return answered.slice(0, count);
  }

  it("counts a variation of thirty new moves as ten recommended and thirty due and all, at every level", async () => {
    // The setup's three moves and 4.d3 against twenty-seven replies: thirty moves, none with a card.
    addVariation(
      "Fan",
      repliesAnsweredByD3(27).map((reply) => [reply, "d3"]),
    );

    const thirty = { recommended: 10, due: 30, all: 30, missed: 0 };
    const counts = async () => {
      const body = RepertoiresResponseSchema.parse((await getRepertoires()).json());
      return {
        variations: body.repertoires.map((entry) => entry.moves),
        groups: body.groups?.map((group) => group.moves),
        sides: body.sides?.map((side) => side.moves),
      };
    };
    expect(await counts()).toEqual({ variations: [thirty], groups: [thirty], sides: [thirty] });

    // A second variation of the opening and a unit of another one add their own new moves to the
    // levels that cover them, a move they share with the first counted once: 4.c3 is one more move
    // for the Italian and 2.exd5 one for the side.
    addVariation("Short", [["Bc5", "c3"]]);
    addRootedUnit(["e4", "d5"], "Scandinavian Defense", "exd5");
    expect(await counts()).toEqual({
      variations: [
        thirty,
        { recommended: 4, due: 4, all: 4, missed: 0 },
        { recommended: 2, due: 2, all: 2, missed: 0 },
      ],
      groups: [
        { recommended: 10, due: 31, all: 31, missed: 0 },
        { recommended: 2, due: 2, all: 2, missed: 0 },
      ],
      sides: [{ recommended: 10, due: 32, all: 32, missed: 0 }],
    });
  });
});

describe("GET /api/repertoires and a rebuild's copy", () => {
  const COPY_GROUP = `Italian Game${REPERTOIRE_REBUILD_GROUP_SUFFIX}`;

  it("lists no repertoire, group or side count of the copy, which answers 3...Bc5 with a move of its own", async () => {
    addVariation("Classical Variation (4.c3)", [["Bc5", "c3"]]);
    const before = RepertoiresResponseSchema.parse((await getRepertoires()).json());
    // A rebuild halfway through: 4.d3 is a move the unit does not play, so it would add to any count.
    addVariation("Giuoco Pianissimo (4.d3)", [["Bc5", "d3"]], COPY_GROUP);

    const during = RepertoiresResponseSchema.parse((await getRepertoires()).json());

    expect(during).toEqual(before);
    expect(during.repertoires.map((entry) => entry.group_name)).toEqual(["Italian Game"]);
    expect(during.groups?.map((group) => group.group_name)).toEqual(["Italian Game"]);
    expect(during.rebuilding_id).toBeNull();
  });

  it("names the unit the rebuild state holds, and none once it is cleared", async () => {
    const unit = addVariation("Classical Variation (4.c3)", [["Bc5", "c3"]]);
    const rebuilding: RepertoireRebuildState = { unitId: unit };
    const app = Fastify();
    registerRepertoireRoutes(app, db, { rebuilding });
    const read = async () =>
      RepertoiresResponseSchema.parse(
        (await app.inject({ method: "GET", url: "/api/repertoires" })).json(),
      ).rebuilding_id;

    expect(await read()).toBe(unit);
    rebuilding.unitId = null;
    expect(await read()).toBeNull();
    await app.close();
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

  it("names no rebuild's copy as the unit of the root it is built from", async () => {
    addReviewedGame(["e4", "d5", "exd5"], { leftPly: 2 }, italian);
    // No unit ends on 1...d5, as when its first run stopped short of it: only a rebuild's copy does.
    addRootedUnit(["e4", "d5"], `Scandinavian Defense${REPERTOIRE_REBUILD_GROUP_SUFFIX}`, "exd5");
    expect(await getMet()).toEqual([
      { root: ["e4", "d5"], opening_name: null, games: 1, repertoire_id: null },
    ]);
  });

  it("lists a root again when its unit is deleted", async () => {
    addReviewedGame(["e4", "d5", "exd5"], { leftPly: 2 }, italian);
    const unit = addRootedUnit(["e4", "d5"], "Scandinavian Defense", "exd5");
    expect((await getMet())[0]?.repertoire_id).toBe(unit);
    db.prepare("DELETE FROM repertoires WHERE id = ?").run(unit);
    expect((await getMet())[0]).toMatchObject({ root: ["e4", "d5"], repertoire_id: null });
  });
});

describe("GET /api/repertoires at the found level", () => {
  let italian: number;

  beforeEach(() => {
    gameCount = 0;
    italian = addVariation("Classical Variation (4.c3)", [["Bc5", "c3"]]);
  });

  // Two units built from openings the games met against the Italian, so the met openings name them.
  function addFoundUnits(): { scandinavian: number; alekhine: number } {
    const scandinavian = addRootedUnit(["e4", "d5"], "Scandinavian Defense", "exd5");
    const alekhine = addRootedUnit(["e4", "Nf6"], "Alekhine Defense", "e5");
    addReviewedGame(["e4", "d5", "exd5"], { leftPly: 2 }, italian);
    addReviewedGame(["e4", "Nf6", "e5"], { leftPly: 2 }, italian);
    return { scandinavian, alekhine };
  }

  const bodyOf = async () => RepertoiresResponseSchema.parse((await getRepertoires()).json());

  it("counts the moves of the units the met openings name, a shared move once and none of the Italian's", async () => {
    const { scandinavian } = addFoundUnits();
    // 1.e4 is in every unit and has one card, not due; the Italian's other moves are known and due.
    addCard([], "e4", FAR_AHEAD);
    addCard(["e4", "e5"], "Nf3", LONG_AGO);
    addCard([...SETUP.slice(0, 4)], "Bc4", LONG_AGO);
    addCard([...SETUP, "Bc5"], "c3", LONG_AGO);

    const body = await bodyOf();

    // 1.e4 is in all and not in due; 2.exd5 and 2.e5 have no card, so both are new and due.
    expect(body.found).toEqual({ moves: { recommended: 2, due: 2, all: 3, missed: 0 } });
    expect(body.repertoires.find((entry) => entry.id === scandinavian)?.moves).toEqual({
      recommended: 1,
      due: 1,
      all: 2,
      missed: 0,
    });
    // The side's drill also holds the Italian's three moves, which the found drill never serves.
    expect(body.sides).toEqual([
      { side: "white", moves: { recommended: 5, due: 5, all: 6, missed: 0 } },
    ]);
  });

  it("counts nothing for a unit no met opening names, and nothing before any game was met", async () => {
    addRootedUnit(["e4", "d5"], "Scandinavian Defense", "exd5");
    expect((await bodyOf()).found).toEqual({
      moves: { recommended: 0, due: 0, all: 0, missed: 0 },
    });

    // A game that met an opening with no unit built from it names no unit either.
    addReviewedGame(["e4", "Nf6", "e5"], { leftPly: 2 }, italian);
    expect((await bodyOf()).found).toEqual({
      moves: { recommended: 0, due: 0, all: 0, missed: 0 },
    });
  });

  it("starts counting a unit once a met opening names it, and stops when none does", async () => {
    addRootedUnit(["e4", "d5"], "Scandinavian Defense", "exd5");
    const gameId = addReviewedGame(["e4", "d5", "exd5"], { leftPly: 2 }, italian);
    expect((await bodyOf()).found?.moves.all).toBe(2);

    db.prepare("DELETE FROM repertoire_game_reviews WHERE game_id = ?").run(gameId);
    expect((await bodyOf()).found?.moves.all).toBe(0);
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

describe("GET /api/repertoires and the moves missed most", () => {
  const DAY = 24 * 3_600_000;
  const bodyOf = async () => RepertoiresResponseSchema.parse((await getRepertoires()).json());

  // A miss is a rating of Again in the log of drill reviews, written by the drill and the game review.
  function logMisses(line: string[], san: string, times: number, daysAgo = 3): void {
    const cardKey = repertoireCardKey(placeOf(line, san));
    for (let index = 0; index < times; index++) {
      insertDrillReview(db, {
        cardKind: "repertoire",
        cardKey,
        reviewedAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
        grade: GRADE.Again,
      });
    }
  }

  // Two Italian variations and the Scandinavian, whose 1.e4 is the same move; a game that met the
  // Scandinavian makes it a unit found in games. White's moves: 1.e4 in all three, 2.Nf3 and 3.Bc4
  // in both Italians, 4.c3 and 4.d3 one each, and 2.exd5.
  function addMissedFixture(): { classical: number; pianissimo: number; scandinavian: number } {
    gameCount = 0;
    const classical = addVariation("Classical Variation (4.c3)", [["Bc5", "c3"]]);
    const pianissimo = addVariation("Giuoco Pianissimo (4.d3)", [["Bc5", "d3"]]);
    const scandinavian = addRootedUnit(["e4", "d5"], "Scandinavian Defense", "exd5");
    addReviewedGame(["e4", "d5", "exd5"], { leftPly: 2 }, classical);
    logMisses([], "e4", 3);
    logMisses(["e4", "e5"], "Nf3", 2);
    logMisses([...SETUP, "Bc5"], "c3", 4);
    // Missed once, so it is in no count.
    logMisses([...SETUP, "Bc5"], "d3", 1);
    logMisses(["e4", "d5"], "exd5", 5);
    return { classical, pianissimo, scandinavian };
  }

  it("counts the moves missed twice or more in the last 30 days at the variation, opening, colour and found levels", async () => {
    const { classical, pianissimo, scandinavian } = addMissedFixture();

    const body = await bodyOf();

    const missedOf = (id: number) =>
      body.repertoires.find((entry) => entry.id === id)?.moves.missed;
    // 1.e4, 2.Nf3 and 4.c3 for the Classical, 1.e4 and 2.Nf3 for the Pianissimo, 1.e4 and 2.exd5.
    expect([classical, pianissimo, scandinavian].map(missedOf)).toEqual([3, 2, 2]);
    // The two Italians share 1.e4 and 2.Nf3, which one card holds, so the opening counts them once.
    expect(body.groups?.map((group) => [group.group_name, group.moves.missed])).toEqual([
      ["Italian Game", 3],
      ["Scandinavian Defense", 2],
    ]);
    expect(body.sides).toMatchObject([{ side: "white", moves: { missed: 4 } }]);
    // The found drill holds the Scandinavian alone, which a game met, and not the Italians.
    expect(body.found?.moves.missed).toBe(2);
  });

  it("leaves out a move missed twice 31 days ago and never since, which the clock of the request decides", async () => {
    addVariation("Classical Variation (4.c3)", [["Bc5", "c3"]]);
    logMisses([], "e4", 2, 31);
    logMisses(["e4", "e5"], "Nf3", 1, 2);

    const body = await bodyOf();

    expect(body.repertoires[0]?.moves.missed).toBe(0);
    expect(body.sides?.[0]?.moves.missed).toBe(0);
  });

  it("reads the log of reviews once for the whole answer, however many variations, openings and cards it counts", async () => {
    addMissedFixture();
    let reads = 0;
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      if (!sql.includes("drill_reviews")) return statement;
      for (const method of ["all", "get", "iterate", "run"] as const) {
        const run = statement[method].bind(statement);
        statement[method] = ((...args: unknown[]) => {
          reads += 1;
          return run(...args);
        }) as never;
      }
      return statement;
    }) as never);

    const body = await bodyOf();

    expect(body.repertoires).toHaveLength(3);
    expect(reads).toBe(1);
  });
});

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

  it("answers 409 for an imported unit, which lists only the replies it answers, and reads none of its rows", async () => {
    addVariationWithGap();
    const imported = addImportedUnit();
    const app = buildApp({ db });
    const prepared = vi.spyOn(db, "prepare");

    const response = await getCoverage(app, imported);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "imported_unit", message: expect.any(String) });
    expect(RepertoireCoverageSchema.safeParse(response.json()).success).toBe(false);
    expect(
      prepared.mock.calls.filter(([sql]) => String(sql).includes("repertoire_positions")),
    ).toEqual([]);
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

describe("GET /api/repertoires: the numbers of the Openings page", () => {
  const DAY_MS = 24 * 3_600_000;
  const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();
  const AFTER_PIANISSIMO = [...SETUP, "Bc5", "d3"];
  const AFTER_TWO_KNIGHTS = [...SETUP, "Nf6", "Ng5"];
  let pianissimo: number;
  let twoKnights: number;
  let bare: number;
  let scandinavian: number;

  beforeEach(() => {
    gameCount = 0;
    // The first variation answers 3...Bc5 and leaves 3...Nf6 open, the second the other way round, so
    // each has a gap that the opening as a whole does not.
    pianissimo = addVariation("Giuoco Pianissimo (4.d3)", [["Bc5", "d3"]]);
    addReplyWithoutAnswer(pianissimo, SETUP, "Nf6", 0.4);
    twoKnights = addVariation("Two Knights Defense (4.Ng5)", [["Nf6", "Ng5"]]);
    addReplyWithoutAnswer(twoKnights, SETUP, "Bc5", 0.6);
    db.prepare("UPDATE repertoires SET branch_san = ? WHERE id = ?").run(
      JSON.stringify(AFTER_TWO_KNIGHTS),
      twoKnights,
    );
    // Neither the first of its group nor built at a branch point, and with no move stored.
    bare = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "Evans Gambit (4.b4)",
    }).id;
    scandinavian = addRootedUnit(["e4", "d5"], "Scandinavian Defense", "exd5");
  });

  const firstAttempt = (repertoireId: number, correct: boolean, at: string): void =>
    insertRepertoireFirstAttempt(db, { ...placeOf([], "e4"), repertoireId, correct }, at);

  // Inside the 30 days and outside them, so the window is read from the clock of the request.
  function addFirstAttempts(): void {
    firstAttempt(pianissimo, true, daysAgo(2));
    firstAttempt(pianissimo, false, daysAgo(10));
    firstAttempt(pianissimo, true, daysAgo(29));
    firstAttempt(pianissimo, true, daysAgo(31));
    firstAttempt(twoKnights, false, daysAgo(1));
    firstAttempt(twoKnights, true, daysAgo(20));
    firstAttempt(twoKnights, false, daysAgo(45));
  }

  // Every outcome the review writes; the last two never reached the line and carry the Italian's id.
  function addReviewedGames(): void {
    const outcomes = ["in_book", "in_book", "reply_added", "reply_not_stored", "departed"];
    for (const outcome of outcomes) addReviewedGame(AFTER_PIANISSIMO, { outcome }, pianissimo);
    addReviewedGame(AFTER_PIANISSIMO, { outcome: "not_reached" }, pianissimo);
    addReviewedGame(AFTER_PIANISSIMO, { outcome: "other_side", color: "black" }, pianissimo);
    addReviewedGame(AFTER_TWO_KNIGHTS, { outcome: "in_book" }, twoKnights);
    addReviewedGame(AFTER_TWO_KNIGHTS, { outcome: "departed" }, twoKnights);
    addReviewedGame(AFTER_TWO_KNIGHTS, { outcome: "departed" }, twoKnights);
  }

  const bodyOf = async () => RepertoiresResponseSchema.parse((await getRepertoires()).json());

  const figuresOf = (entry: {
    moves_total?: number | undefined;
    remembered_30d?: object | undefined;
    in_line?: object | undefined;
    covered_percent?: number | null | undefined;
    line?: string | null | undefined;
  }) => ({
    moves_total: entry.moves_total,
    remembered_30d: entry.remembered_30d,
    in_line: entry.in_line,
    covered_percent: entry.covered_percent,
    line: entry.line,
  });

  it("sends the five numbers and the line of each variation", async () => {
    addFirstAttempts();
    addReviewedGames();

    const { repertoires } = await bodyOf();

    expect(repertoires.map((entry) => entry.id)).toEqual([
      pianissimo,
      twoKnights,
      bare,
      scandinavian,
    ]);
    expect(repertoires.map(figuresOf)).toEqual([
      {
        moves_total: 4,
        remembered_30d: { right: 2, of: 3 },
        in_line: { stayed: 4, of: 5 },
        // The line ends at 4.d3 with 1 against a gap of 0.4: 1 / 1.4.
        covered_percent: 71.4,
        line: "3...Bc5 4.d3",
      },
      {
        moves_total: 4,
        remembered_30d: { right: 1, of: 2 },
        in_line: { stayed: 1, of: 3 },
        // The line ends at 4.Ng5 with 1 against a gap of 0.6: 1 / 1.6.
        covered_percent: 62.5,
        line: "3...Nf6 4.Ng5",
      },
      {
        moves_total: 0,
        remembered_30d: { right: 0, of: 0 },
        in_line: { stayed: 0, of: 0 },
        covered_percent: null,
        line: null,
      },
      {
        moves_total: 2,
        remembered_30d: { right: 0, of: 0 },
        in_line: { stayed: 0, of: 0 },
        covered_percent: 100,
        line: "2.exd5",
      },
    ]);
  });

  it("sends the same numbers for each opening, taken over all its variations at once", async () => {
    addFirstAttempts();
    addReviewedGames();

    const { groups } = await bodyOf();

    expect(groups?.map((group) => group.group_name)).toEqual([
      "Italian Game",
      "Scandinavian Defense",
    ]);
    expect(groups?.map(figuresOf)).toEqual([
      {
        // 1.e4, 2.Nf3 and 3.Bc4 are in both variations: 4 + 4 moves are 5.
        moves_total: 5,
        remembered_30d: { right: 3, of: 5 },
        in_line: { stayed: 5, of: 8 },
        // Each variation answers the reply the other leaves open, so no gap is left: 2 / 2.
        covered_percent: 100,
        line: "1.e4 e5 2.Nf3 Nc6 3.Bc4",
      },
      {
        moves_total: 2,
        remembered_30d: { right: 0, of: 0 },
        in_line: { stayed: 0, of: 0 },
        covered_percent: 100,
        line: "1.e4 d5",
      },
    ]);
  });

  it("counts the moves an opening would serve once across its two variations, apart from either's own", async () => {
    // 1.e4 and 3.Bc4 are held in both variations but not due; 2.Nf3 is shared and due, 4.Ng5 is due
    // for the second variation only, and 4.d3 is not due.
    const later = new Date(Date.now() + 30 * DAY_MS).toISOString();
    addCard([], "e4", later);
    addCard(["e4", "e5"], "Nf3", LONG_AGO);
    addCard(SETUP.slice(0, 4), "Bc4", later);
    addCard([...SETUP, "Bc5"], "d3", later);
    addCard([...SETUP, "Nf6"], "Ng5", LONG_AGO);

    const { repertoires, groups } = await bodyOf();

    const own = (id: number) => repertoires.find((entry) => entry.id === id)?.moves;
    expect(own(pianissimo)).toEqual({ recommended: 1, due: 1, all: 4, missed: 0 });
    expect(own(twoKnights)).toEqual({ recommended: 2, due: 2, all: 4, missed: 0 });
    const italian = groups?.find((entry) => entry.group_name === "Italian Game");
    expect(italian?.moves).toEqual({ recommended: 2, due: 2, all: 5, missed: 0 });
  });

  it("gives an opening of one variation the numbers of that variation", async () => {
    const { repertoires, groups } = await bodyOf();

    const alone = repertoires.find((entry) => entry.id === scandinavian);
    const group = groups?.find((entry) => entry.group_name === "Scandinavian Defense");
    expect(group && figuresOf(group)).toMatchObject({
      moves_total: alone?.moves_total,
      remembered_30d: alone?.remembered_30d,
      in_line: alone?.in_line,
      covered_percent: alone?.covered_percent,
    });
  });

  it("gives each variation the covered share its coverage route gives", async () => {
    const { repertoires } = await bodyOf();

    for (const entry of repertoires) {
      const route = await getCoverage(buildApp({ db }), entry.id);
      const coverage = RepertoireCoverageSchema.parse(route.json());
      expect(entry.covered_percent).toBe(coverage.covered_percent);
    }
  });

  it("moves no count of what a drill would serve when attempts and games are recorded", async () => {
    const counts = (body: Awaited<ReturnType<typeof bodyOf>>) => ({
      variations: body.repertoires.map((entry) => entry.moves),
      groups: body.groups?.map((group) => group.moves),
      sides: body.sides,
      found: body.found,
    });
    const before = counts(await bodyOf());

    addFirstAttempts();
    addReviewedGames();

    expect(counts(await bodyOf())).toEqual(before);
  });
});
