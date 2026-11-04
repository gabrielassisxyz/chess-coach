import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertGradedGame, START_FEN } from "../../test/fixture-game.js";
import { buildApp } from "../app.js";
import { type Database, openDatabase } from "../db/open.js";

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

async function get(url: string) {
  const app = buildApp({ db });
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
