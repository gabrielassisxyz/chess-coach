import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertGradedGame, START_FEN } from "../../test/fixture-game.js";
import { buildApp } from "../app.js";
import { type Database, openDatabase } from "../db/open.js";
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
    });
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
