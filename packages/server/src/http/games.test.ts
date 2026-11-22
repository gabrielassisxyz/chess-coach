import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GameDetailResponseSchema,
  GameDetailSchema,
  GameListResponseSchema,
  GameSummarySchema,
} from "@chess-coach/shared";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertGradedGame, START_FEN } from "../../test/fixture-game.js";
import { buildApp } from "../app.js";
import { type Database, openDatabase } from "../db/open.js";
import {
  createRepertoireVariation,
  insertRepertoireOwnMove,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { insertCard } from "../db/srs.js";
import { classifyCpLoss } from "../engine/evaluate.js";
import { loadOpeningNames } from "../openings/names.js";
import { contentDir } from "../paths.js";

const openingNames = loadOpeningNames(contentDir());

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-games-http-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function get(url: string, withNames = true) {
  const app = buildApp(withNames ? { db, openingNames } : { db });
  const response = await app.inject({ method: "GET", url });
  await app.close();
  return response;
}

describe("GET /api/games", () => {
  it("lists finished games newest first with the summary fields", async () => {
    const first = insertGradedGame(db);
    const second = insertGradedGame(db);
    insertGradedGame(db, false);
    const response = await get("/api/games");
    expect(response.statusCode).toBe(200);
    const { games } = response.json() as { games: Record<string, unknown>[] };
    expect(games.map((game) => game.id)).toEqual([second, first]);
    expect(games[0]).toEqual({
      id: second,
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T01:00:00.000Z",
      player_color: "white",
      target_elo: 1200,
      result: "0-1",
      termination: "resign",
      move_count: 12,
      accuracy: 1 / 6,
      worst_moment: { ply: 11, san: "e4", cp_loss: 420, classification: "blunder" },
      cards_count: 0,
      mistakes_count: 1,
      opening: null,
      source: "coach",
      source_url: null,
      opponent: null,
      student_rating: null,
      opponent_rating: null,
      time_control: null,
      played_at: null,
      grading: "done",
      practice: false,
    });
  });

  it("carries practice as a boolean on the list and detail routes", async () => {
    const regular = insertGradedGame(db);
    const practice = insertGradedGame(db);
    db.prepare("UPDATE games SET practice = 1 WHERE id = ?").run(practice);

    const list = GameListResponseSchema.parse((await get("/api/games")).json()).games;
    expect(list.find((entry) => entry.id === regular)?.practice).toBe(false);
    expect(list.find((entry) => entry.id === practice)?.practice).toBe(true);

    const regularDetail = GameDetailResponseSchema.parse(
      (await get(`/api/games/${regular}`)).json(),
    ).game;
    const practiceDetail = GameDetailResponseSchema.parse(
      (await get(`/api/games/${practice}`)).json(),
    ).game;
    expect(regularDetail.practice).toBe(false);
    expect(practiceDetail.practice).toBe(true);
  });

  it("has a null accuracy when no student move was graded", async () => {
    const empty = db
      .prepare(
        `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase, result, termination)
         VALUES ('t', 't2', 'white', 800, ?, 'finished', NULL, 'abort') RETURNING id`,
      )
      .get(START_FEN) as { id: number };
    const { games } = (await get("/api/games")).json() as { games: Record<string, unknown>[] };
    expect(games).toEqual([
      expect.objectContaining({ id: empty.id, move_count: 0, accuracy: null }),
    ]);
  });

  it("honours the limit and refuses one outside 1 to 500", async () => {
    insertGradedGame(db);
    insertGradedGame(db);
    const one = (await get("/api/games?limit=1")).json() as { games: unknown[] };
    expect(one.games).toHaveLength(1);
    for (const bad of ["0", "501", "abc"]) {
      expect((await get(`/api/games?limit=${bad}`)).statusCode).toBe(400);
    }
    expect((await get("/api/games?limit=500")).statusCode).toBe(200);
  });
});

function insertMovesWithLosses(losses: [number, number][]): number {
  const game = db
    .prepare(
      `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase, result, termination)
       VALUES ('t', 't2', 'white', 800, ?, 'finished', '0-1', 'resign') RETURNING id`,
    )
    .get(START_FEN) as { id: number };
  const insert = db.prepare(
    `INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after, is_player, cp_loss, classification)
     VALUES (?, ?, 'e4', 'e2e4', 'a', 'b', 1, ?, ?)`,
  );
  for (const [ply, loss] of losses) {
    insert.run(game.id, ply, loss, classifyCpLoss(loss));
  }
  return game.id;
}

function cardFor(gameId: number): void {
  insertCard(db, {
    sourceKind: "teaching",
    sourceGameId: gameId,
    sourceMoveId: null,
    promptFen: START_FEN,
    studentColor: "white",
    playedUci: null,
    expectedUci: "e2e4",
    cpLoss: null,
    classification: null,
    explanation: null,
    createdAt: "t",
    puzzleId: `p${Math.random()}`,
  });
}

const TIED_LOSSES: [number, number][] = [
  [2, 10],
  [6, 250],
  [10, 90],
  [12, 250],
];

describe("worst moment, cards and mistakes", () => {
  it("picks the earliest of two equal worst plies and counts cards and mistakes", async () => {
    const id = insertMovesWithLosses(TIED_LOSSES);
    cardFor(id);
    cardFor(id);
    cardFor(insertMovesWithLosses([]));
    const { games } = (await get("/api/games")).json() as { games: Record<string, unknown>[] };
    expect(games.find((game) => game.id === id)).toMatchObject({
      worst_moment: { ply: 6, san: "e4", cp_loss: 250, classification: "mistake" },
      cards_count: 2,
      mistakes_count: 2,
    });
  });

  it("has a null worst moment and zero counts while nothing is graded", async () => {
    const id = insertMovesWithLosses([]);
    db.prepare(
      `INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after, is_player)
       VALUES (?, 1, 'e4', 'e2e4', 'a', 'b', 1)`,
    ).run(id);
    const { games } = (await get("/api/games")).json() as { games: Record<string, unknown>[] };
    expect(games[0]).toMatchObject({ worst_moment: null, cards_count: 0, mistakes_count: 0 });
  });

  it("ignores the engine's plies", async () => {
    const id = insertMovesWithLosses([[1, 30]]);
    db.prepare(
      `INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after, is_player, cp_loss, classification)
       VALUES (?, 2, 'e5', 'e7e5', 'a', 'b', 0, 900, 'blunder')`,
    ).run(id);
    const { games } = (await get("/api/games")).json() as { games: Record<string, unknown>[] };
    expect(games[0]).toMatchObject({ worst_moment: { ply: 1 }, mistakes_count: 0 });
  });

  it("carries the same three fields on the detail route", async () => {
    const id = insertMovesWithLosses(TIED_LOSSES);
    cardFor(id);
    cardFor(id);
    const { game } = (await get(`/api/games/${id}`)).json() as { game: Record<string, unknown> };
    expect(game).toMatchObject({
      worst_moment: { ply: 6, cp_loss: 250 },
      cards_count: 2,
      mistakes_count: 2,
    });
  });
});

describe("GET /api/games/:id", () => {
  it("returns the game with every move, its position after and its grade", async () => {
    const id = insertGradedGame(db);
    const response = await get(`/api/games/${id}`);
    expect(response.statusCode).toBe(200);
    const { game } = response.json() as { game: { moves: Record<string, unknown>[] } };
    expect(game).toMatchObject({ id, initial_fen: START_FEN, termination: "resign" });
    expect(game.moves).toHaveLength(12);
    expect(game.moves[0]).toEqual({
      ply: 1,
      san: "e4",
      uci: "e2e4",
      is_player: true,
      eval_before_cp: 0,
      eval_after_cp: 0,
      cp_loss: 0,
      classification: "best",
      best_move_san: "d4",
      fen_after: "after",
    });
    expect(game.moves[1]).toMatchObject({
      ply: 2,
      is_player: false,
      cp_loss: null,
      fen_after: "next",
    });
  });

  it("answers 404 for an unknown or malformed id", async () => {
    for (const id of ["999", "0", "abc", "-1"]) {
      const response = await get(`/api/games/${id}`);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "game_not_found" });
    }
  });
});

// A finished game whose moves carry the real position after each ply, which is what names it.
function insertPlayedGame(sans: string[]): number {
  const game = db
    .prepare(
      `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase, result, termination)
       VALUES ('t', 't2', 'white', 800, ?, 'finished', '1-0', 'checkmate') RETURNING id`,
    )
    .get(START_FEN) as { id: number };
  const insert = db.prepare(
    `INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after, is_player)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const chess = new Chess();
  sans.forEach((san, index) => {
    const fenBefore = chess.fen();
    const move = chess.move(san);
    const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
    insert.run(game.id, index + 1, move.san, uci, fenBefore, chess.fen(), index % 2 === 0 ? 1 : 0);
  });
  return game.id;
}

const ITALIAN_BY_TRANSPOSITION = ["Nf3", "Nc6", "e4", "e5", "Bc4"];
const SCANDINAVIAN_PAST_THEORY = ["e4", "d5", "exd5", "Qxd5", "Nc3", "Qa5", "d4", "c6", "Nf3"];

describe("the opening of a game", () => {
  it("names each listed game by the last named position of its moves", async () => {
    const italian = insertPlayedGame(ITALIAN_BY_TRANSPOSITION);
    const scandinavian = insertPlayedGame(SCANDINAVIAN_PAST_THEORY);
    const { games } = (await get("/api/games")).json() as {
      games: { id: number; opening: unknown }[];
    };
    expect(games.find((game) => game.id === italian)?.opening).toEqual({
      eco: "C50",
      name: "Italian Game",
    });
    expect(games.find((game) => game.id === scandinavian)?.opening).toEqual({
      eco: "B01",
      name: "Scandinavian Defense: Main Line",
    });
  });

  it("is null when no position of the game is named", async () => {
    const id = insertGradedGame(db);
    const list = (await get("/api/games")).json() as { games: { opening: unknown }[] };
    expect(list.games[0]?.opening).toBeNull();
    const detail = (await get(`/api/games/${id}`)).json() as { game: { opening: unknown } };
    expect(detail.game.opening).toBeNull();
  });

  it("names the game on the detail route as on the list", async () => {
    const id = insertPlayedGame(ITALIAN_BY_TRANSPOSITION);
    const { game } = (await get(`/api/games/${id}`)).json() as { game: { opening: unknown } };
    expect(game.opening).toEqual({ eco: "C50", name: "Italian Game" });
  });

  // The browser reads both routes through these schemas, and a schema drops any key it does not
  // name, so a field missing from the shared type would reach the screen as no opening at all.
  it("survives the shared schemas the browser reads both routes through", async () => {
    const id = insertPlayedGame(ITALIAN_BY_TRANSPOSITION);
    const [listed] = GameListResponseSchema.parse((await get("/api/games")).json()).games;
    const italian = { eco: "C50", name: "Italian Game" };
    expect(listed?.opening).toEqual(italian);
    const detail = GameDetailResponseSchema.parse((await get(`/api/games/${id}`)).json());
    expect(detail.game.opening).toEqual(italian);
    const { opening, ...sentBeforeTheField } = listed as NonNullable<typeof listed>;
    expect(opening).not.toBeNull();
    expect(GameSummarySchema.parse(sentBeforeTheField).opening).toBeNull();
  });

  it("leaves every game unnamed when the server holds no table", async () => {
    const id = insertPlayedGame(ITALIAN_BY_TRANSPOSITION);
    const list = (await get("/api/games", false)).json() as { games: { opening: unknown }[] };
    expect(list.games[0]?.opening).toBeNull();
    const detail = (await get(`/api/games/${id}`, false)).json() as {
      game: { opening: unknown };
    };
    expect(detail.game.opening).toBeNull();
  });
});

function insertReviewRow(
  gameId: number,
  repertoireId: number,
  fields: {
    outcome:
      | "in_book"
      | "departed"
      | "reply_added"
      | "reply_not_stored"
      | "not_reached"
      | "other_side";
    followedPlies: number;
    leftPly?: number | null;
    leftPositionKey?: string | null;
    leftSan?: string | null;
    leftUci?: string | null;
    expectedSan?: string | null;
    expectedUci?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO repertoire_game_reviews
       (game_id, repertoire_id, reviewed_at, outcome, followed_plies, passed_moves, left_ply,
        left_position_key, left_san, left_uci, expected_san, expected_uci)
     VALUES (?, ?, '2026-01-01T02:00:00.000Z', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  ).run(
    gameId,
    repertoireId,
    fields.outcome,
    fields.followedPlies,
    fields.leftPly ?? null,
    fields.leftPositionKey ?? null,
    fields.leftSan ?? null,
    fields.leftUci ?? null,
    fields.expectedSan ?? null,
    fields.expectedUci ?? null,
  );
}

describe("repertoire_review on GET /api/games/:id", () => {
  it("is null when the game has no review row, or for not_reached and other_side", async () => {
    const unit = createRepertoireVariation(db, {
      side: "white",
      groupName: "London System",
      variationName: "Main lines",
    });
    const unreviewed = insertGradedGame(db);
    const notReached = insertGradedGame(db);
    const otherSide = insertGradedGame(db);
    insertReviewRow(notReached, unit.id, {
      outcome: "not_reached",
      followedPlies: 2,
      leftPly: 3,
      leftPositionKey: "pos-nr",
      leftSan: "Nc3",
      leftUci: "b1c3",
    });
    insertReviewRow(otherSide, unit.id, { outcome: "other_side", followedPlies: 0 });

    for (const id of [unreviewed, notReached, otherSide]) {
      const parsed = GameDetailResponseSchema.parse((await get(`/api/games/${id}`)).json());
      expect(parsed.game.repertoire_review).toBeNull();
    }
  });

  it("returns the unit and followed_plies with left null for in_book", async () => {
    const unit = createRepertoireVariation(db, {
      side: "white",
      groupName: "London System",
      variationName: "Main lines",
    });
    const id = insertGradedGame(db);
    insertReviewRow(id, unit.id, { outcome: "in_book", followedPlies: 12 });

    const parsed = GameDetailResponseSchema.parse((await get(`/api/games/${id}`)).json());
    expect(parsed.game.repertoire_review).toEqual({
      repertoire_id: unit.id,
      group_name: "London System",
      variation_name: "Main lines",
      outcome: "in_book",
      followed_plies: 12,
      left: null,
    });
  });

  it("returns student departure details, trimmed note, null for blank or missing note, and empty stored_replies", async () => {
    const unit = createRepertoireVariation(db, {
      side: "white",
      groupName: "London System",
      variationName: "Main lines",
    });
    insertRepertoireOwnMove(db, {
      repertoireId: unit.id,
      positionKey: "pos-with-note",
      ply: 13,
      line: ["d4"],
      uci: "f1d3",
      san: "Bd3",
      share: null,
      reach: 1,
      openingName: null,
      source: "pgn",
      cpLoss: null,
      evalCp: null,
      results: null,
    });
    db.prepare(
      "UPDATE repertoire_positions SET idea = ? WHERE repertoire_id = ? AND position_key = ?",
    ).run("  Develops the bishop to the active diagonal. \n", unit.id, "pos-with-note");
    // A reply row at the same key must still leave stored_replies empty on a student departure.
    upsertRepertoireReply(db, {
      repertoireId: unit.id,
      positionKey: "pos-with-note",
      ply: 13,
      line: ["d4"],
      uci: "c7c5",
      san: "c5",
      share: null,
      reach: 1,
      openingName: null,
      source: "pgn",
    });

    insertRepertoireOwnMove(db, {
      repertoireId: unit.id,
      positionKey: "pos-blank-note",
      ply: 7,
      line: ["d4"],
      uci: "c2c3",
      san: "c3",
      share: null,
      reach: 1,
      openingName: null,
      source: "pgn",
      cpLoss: null,
      evalCp: null,
      results: null,
    });
    db.prepare(
      "UPDATE repertoire_positions SET idea = ? WHERE repertoire_id = ? AND position_key = ?",
    ).run("   \t  ", unit.id, "pos-blank-note");

    const withNote = insertGradedGame(db);
    insertReviewRow(withNote, unit.id, {
      outcome: "departed",
      followedPlies: 12,
      leftPly: 13,
      leftPositionKey: "pos-with-note",
      leftSan: "c3",
      leftUci: "c2c3",
      expectedSan: "Bd3",
      expectedUci: "f1d3",
    });

    const withBlankNote = insertGradedGame(db);
    insertReviewRow(withBlankNote, unit.id, {
      outcome: "departed",
      followedPlies: 6,
      leftPly: 7,
      leftPositionKey: "pos-blank-note",
      leftSan: "e3",
      leftUci: "e2e3",
      expectedSan: "c3",
      expectedUci: "c2c3",
    });

    const withNoRow = insertGradedGame(db);
    insertReviewRow(withNoRow, unit.id, {
      outcome: "departed",
      followedPlies: 4,
      leftPly: 5,
      leftPositionKey: "pos-missing",
      leftSan: "Nc3",
      leftUci: "b1c3",
      expectedSan: "Nf3",
      expectedUci: "g1f3",
    });

    const first = GameDetailResponseSchema.parse((await get(`/api/games/${withNote}`)).json());
    expect(first.game.repertoire_review).toEqual({
      repertoire_id: unit.id,
      group_name: "London System",
      variation_name: "Main lines",
      outcome: "departed",
      followed_plies: 12,
      left: {
        ply: 13,
        by: "student",
        played_san: "c3",
        line_san: "Bd3",
        line_note: "Develops the bishop to the active diagonal.",
        stored_replies: [],
      },
    });

    const second = GameDetailResponseSchema.parse(
      (await get(`/api/games/${withBlankNote}`)).json(),
    );
    expect(second.game.repertoire_review?.left?.line_note).toBeNull();

    const third = GameDetailResponseSchema.parse((await get(`/api/games/${withNoRow}`)).json());
    expect(third.game.repertoire_review?.left?.line_note).toBeNull();
  });

  it("reads the note from the unit the game was reviewed against when two units store the same move", async () => {
    const first = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "Classical Variation (4.c3)",
    });
    const second = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "Giuoco Pianissimo (4.d3)",
    });
    for (const [unit, idea] of [
      [first, "Prepares d4 to take the centre."],
      [second, "Keeps the tension and the bishop pair."],
    ] as const) {
      insertRepertoireOwnMove(db, {
        repertoireId: unit.id,
        positionKey: "pos-shared",
        ply: 7,
        line: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"],
        uci: "c2c3",
        san: "c3",
        share: null,
        reach: 1,
        openingName: null,
        source: "pgn",
        cpLoss: null,
        evalCp: null,
        results: null,
      });
      db.prepare(
        "UPDATE repertoire_positions SET idea = ? WHERE repertoire_id = ? AND position_key = ?",
      ).run(idea, unit.id, "pos-shared");
    }

    const notes: Array<string | null | undefined> = [];
    for (const unit of [first, second]) {
      const gameId = insertGradedGame(db);
      insertReviewRow(gameId, unit.id, {
        outcome: "departed",
        followedPlies: 6,
        leftPly: 7,
        leftPositionKey: "pos-shared",
        leftSan: "d3",
        leftUci: "d2d3",
        expectedSan: "c3",
        expectedUci: "c2c3",
      });
      const parsed = GameDetailResponseSchema.parse((await get(`/api/games/${gameId}`)).json());
      notes.push(parsed.game.repertoire_review?.left?.line_note);
    }
    expect(notes).toEqual([
      "Prepares d4 to take the centre.",
      "Keeps the tension and the bishop pair.",
    ]);
  });

  it("returns sorted stored_replies and null line_san/line_note for reply_not_stored and reply_added", async () => {
    const unit = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "Classical Variation (4.c3)",
    });
    const otherUnit = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "Giuoco Pianissimo (4.d3)",
    });
    for (const [uci, san] of [
      ["g8f6", "Nf6"],
      ["f8c5", "Bc5"],
      ["d7d6", "d6"],
    ] as const) {
      upsertRepertoireReply(db, {
        repertoireId: unit.id,
        positionKey: "pos-replies",
        ply: 8,
        line: ["e4", "e5", "Nf3", "Nc6", "Bc4"],
        uci,
        san,
        share: 0.2,
        reach: 0.2,
        openingName: null,
        source: "explorer",
      });
    }
    // A reply in another unit at the same position must not leak into this unit's list.
    upsertRepertoireReply(db, {
      repertoireId: otherUnit.id,
      positionKey: "pos-replies",
      ply: 8,
      line: ["e4", "e5", "Nf3", "Nc6", "Bc4"],
      uci: "a7a6",
      san: "a6",
      share: 0.1,
      reach: 0.1,
      openingName: null,
      source: "explorer",
    });

    const notStored = insertGradedGame(db);
    insertReviewRow(notStored, unit.id, {
      outcome: "reply_not_stored",
      followedPlies: 7,
      leftPly: 8,
      leftPositionKey: "pos-replies",
      leftSan: "h6",
      leftUci: "h7h6",
    });

    const added = insertGradedGame(db);
    insertReviewRow(added, unit.id, {
      outcome: "reply_added",
      followedPlies: 7,
      leftPly: 8,
      leftPositionKey: "pos-replies",
      leftSan: "g6",
      leftUci: "g7g6",
    });

    const noReplies = insertGradedGame(db);
    insertReviewRow(noReplies, unit.id, {
      outcome: "reply_not_stored",
      followedPlies: 7,
      leftPly: 8,
      leftPositionKey: "pos-empty",
      leftSan: "h5",
      leftUci: "h7h5",
    });

    const notStoredParsed = GameDetailResponseSchema.parse(
      (await get(`/api/games/${notStored}`)).json(),
    );
    expect(notStoredParsed.game.repertoire_review).toEqual({
      repertoire_id: unit.id,
      group_name: "Italian Game",
      variation_name: "Classical Variation (4.c3)",
      outcome: "reply_not_stored",
      followed_plies: 7,
      left: {
        ply: 8,
        by: "opponent",
        played_san: "h6",
        line_san: null,
        line_note: null,
        stored_replies: ["Bc5", "Nf6", "d6"],
      },
    });

    const addedParsed = GameDetailResponseSchema.parse((await get(`/api/games/${added}`)).json());
    expect(addedParsed.game.repertoire_review).toEqual({
      repertoire_id: unit.id,
      group_name: "Italian Game",
      variation_name: "Classical Variation (4.c3)",
      outcome: "reply_added",
      followed_plies: 7,
      left: {
        ply: 8,
        by: "opponent",
        played_san: "g6",
        line_san: null,
        line_note: null,
        stored_replies: ["Bc5", "Nf6", "d6"],
      },
    });

    const emptyParsed = GameDetailResponseSchema.parse(
      (await get(`/api/games/${noReplies}`)).json(),
    );
    expect(emptyParsed.game.repertoire_review?.left?.stored_replies).toEqual([]);
  });

  it("leaves the move the opponent played out of stored_replies when the review stored it as a reply", async () => {
    const unit = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "Classical Variation (4.c3)",
    });
    for (const [uci, san] of [
      ["g8f6", "Nf6"],
      ["f8c5", "Bc5"],
      ["d7d6", "d6"],
      ["g7g6", "g6"],
    ] as const) {
      upsertRepertoireReply(db, {
        repertoireId: unit.id,
        positionKey: "pos-added",
        ply: 8,
        line: ["e4", "e5", "Nf3", "Nc6", "Bc4"],
        uci,
        san,
        share: 0.2,
        reach: 0.2,
        openingName: null,
        source: uci === "g7g6" ? "game" : "explorer",
      });
    }
    const added = insertGradedGame(db);
    insertReviewRow(added, unit.id, {
      outcome: "reply_added",
      followedPlies: 7,
      leftPly: 8,
      leftPositionKey: "pos-added",
      leftSan: "g6",
      leftUci: "g7g6",
    });

    const parsed = GameDetailResponseSchema.parse((await get(`/api/games/${added}`)).json());
    expect(parsed.game.repertoire_review?.left?.played_san).toBe("g6");
    expect(parsed.game.repertoire_review?.left?.stored_replies).toEqual(["Bc5", "Nf6", "d6"]);
  });

  it("parses a game detail fixture that omits repertoire_review as null", async () => {
    const id = insertGradedGame(db);
    const raw = (await get(`/api/games/${id}`)).json() as { game: Record<string, unknown> };
    const { repertoire_review: _dropped, ...withoutReview } = raw.game;
    expect(GameDetailSchema.parse(withoutReview).repertoire_review).toBeNull();
  });
});
