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

function addCard(line: string[], san: string, nextReviewAt: string): void {
  const place = placeOf(line, san);
  db.prepare(
    `INSERT INTO repertoire_cards (position_key, move_uci, introduced_at, next_review_at)
     VALUES (?, ?, ?, ?)`,
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
    expect(RepertoiresResponseSchema.parse(response.json())).toEqual({ repertoires: [], met: [] });
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

// The classical line and a second branch, with Black's 4...d6 stored and no White move after it.
function addVariationWithGap(): number {
  const id = addVariation("Classical Variation (4.c3)", [
    ["Bc5", "c3", "Nf6", "d4"],
    ["Nf6", "d3"],
  ]);
  const line = [...SETUP, "Bc5", "c3"];
  upsertRepertoireReply(db, {
    repertoireId: id,
    ...placeOf(line, "d6"),
    ply: line.length + 1,
    line,
    reach: 0.3,
    openingName: null,
    san: "d6",
    share: 0.3,
    source: "explorer",
  });
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
