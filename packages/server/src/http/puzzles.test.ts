import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PuzzleRatingHistoryResponseSchema } from "@chess-coach/shared";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { Clock } from "../clock.js";
import { type Database, openDatabase } from "../db/open.js";
import { contentDir } from "../paths.js";
import { ensurePuzzleRating } from "../puzzles/rating.js";
import { seedPuzzles } from "../puzzles/seed.js";
import { registerPuzzleRoutes } from "./puzzles.js";

async function get(url: string) {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "puzzle-route-")));
  seedPuzzles(db, contentDir());
  const app = buildApp({ db });
  const response = await app.inject({ method: "GET", url });
  await app.close();
  return response;
}

describe("GET /api/puzzles", () => {
  it("returns ten fork puzzles with attempt counts and no solution", async () => {
    const response = await get("/api/puzzles?motif=fork&limit=10");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { total: number; puzzles: Record<string, unknown>[] };
    expect(body.puzzles).toHaveLength(10);
    expect(body.total).toBeGreaterThanOrEqual(28);
    expect(Object.keys(body.puzzles[0] as object).sort()).toEqual(
      ["attempts", "difficulty", "explanation", "fen", "id", "motif", "solved"].sort(),
    );
  });

  it("answers an empty list for a motif with no puzzles", async () => {
    const response = await get("/api/puzzles?motif=nope");
    expect(response.json()).toEqual({ total: 0, puzzles: [] });
  });

  it("caps the limit at 50 and rejects a non-numeric one", async () => {
    const big = await get("/api/puzzles?limit=500");
    expect((big.json() as { puzzles: unknown[] }).puzzles).toHaveLength(50);
    expect((await get("/api/puzzles?limit=abc")).statusCode).toBe(400);
  });
});

describe("GET /api/puzzles/rating/history", () => {
  let tmp: string;
  let db: Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cc-puzzle-history-http-"));
    db = openDatabase(tmp);
  });
  afterEach(() => {
    if (db.open) db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function insertRatedPuzzle(id: string, rating: number): void {
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation, difficulty_rating)
       VALUES (?, 'test', 'fork', 'easy', 'x', '[]', '[]', 'why', ?)`,
    ).run(id, rating);
  }

  function insertAttempt(puzzleId: string, firstTry: boolean, at: string): void {
    db.prepare(
      `INSERT INTO puzzle_attempts (puzzle_id, attempted_at, solved, answered_uci, failed_ply, first_try)
       VALUES (?, ?, ?, '[]', NULL, ?)`,
    ).run(puzzleId, at, firstTry ? 1 : 0, firstTry ? 1 : 0);
  }

  it("answers all four windows and defaults absent days to 30 through buildApp", async () => {
    const now = new Date();
    const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    const fiveDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 5, 12);
    insertRatedPuzzle("p1", 1400);
    insertRatedPuzzle("p2", 1200);
    insertAttempt("p1", true, fiveDaysAgo.toISOString());
    insertAttempt("p2", false, todayNoon.toISOString());
    const replayed = ensurePuzzleRating(db, { now: () => todayNoon });

    const app = buildApp({ db });
    try {
      const def = await app.inject({ method: "GET", url: "/api/puzzles/rating/history" });
      expect(def.statusCode).toBe(200);
      const parsedDefault = PuzzleRatingHistoryResponseSchema.parse(def.json());
      expect(parsedDefault.points).toHaveLength(30);
      expect(parsedDefault.current).toBe(replayed.rating);
      expect(parsedDefault.points.at(-1)?.rating).toBe(replayed.rating);

      const explicit30 = PuzzleRatingHistoryResponseSchema.parse(
        (await app.inject({ method: "GET", url: "/api/puzzles/rating/history?days=30" })).json(),
      );
      expect(explicit30).toEqual(parsedDefault);

      const week = PuzzleRatingHistoryResponseSchema.parse(
        (await app.inject({ method: "GET", url: "/api/puzzles/rating/history?days=7" })).json(),
      );
      expect(week.points).toHaveLength(7);

      const ninety = PuzzleRatingHistoryResponseSchema.parse(
        (await app.inject({ method: "GET", url: "/api/puzzles/rating/history?days=90" })).json(),
      );
      expect(ninety.points).toHaveLength(90);

      const all = PuzzleRatingHistoryResponseSchema.parse(
        (await app.inject({ method: "GET", url: "/api/puzzles/rating/history?days=all" })).json(),
      );
      expect(all.points).toHaveLength(6);
      expect(all.low).toBe(replayed.rating);
      expect(all.high).toBe(1224);
      expect(all.change).toBe(replayed.rating - 1224);
    } finally {
      await app.close();
    }
  });

  it("answers exact local calendar days and metrics on a fixed clock", async () => {
    const fixedNow = new Date(2026, 5, 10, 12);
    const fixedClock: Clock = { now: () => fixedNow };
    const day = (d: number) => new Date(2026, 5, d, 12).toISOString();

    insertRatedPuzzle("p1", 1400);
    insertAttempt("p1", true, day(8));
    ensurePuzzleRating(db, fixedClock);

    const app = Fastify();
    registerPuzzleRoutes(app, db, fixedClock);
    try {
      const week = PuzzleRatingHistoryResponseSchema.parse(
        (await app.inject({ method: "GET", url: "/api/puzzles/rating/history?days=7" })).json(),
      );
      expect(week).toEqual({
        current: 1224,
        points: [
          { day: "2026-06-04", rating: 1200 },
          { day: "2026-06-05", rating: 1200 },
          { day: "2026-06-06", rating: 1200 },
          { day: "2026-06-07", rating: 1200 },
          { day: "2026-06-08", rating: 1224 },
          { day: "2026-06-09", rating: 1224 },
          { day: "2026-06-10", rating: 1224 },
        ],
        low: 1200,
        high: 1224,
        change: 24,
      });

      const all = PuzzleRatingHistoryResponseSchema.parse(
        (await app.inject({ method: "GET", url: "/api/puzzles/rating/history?days=all" })).json(),
      );
      expect(all).toEqual({
        current: 1224,
        points: [
          { day: "2026-06-08", rating: 1224 },
          { day: "2026-06-09", rating: 1224 },
          { day: "2026-06-10", rating: 1224 },
        ],
        low: 1224,
        high: 1224,
        change: 0,
      });
    } finally {
      await app.close();
    }
  });

  it("answers 400 and reads nothing for any other days value", async () => {
    // Closing the database guarantees any query attempt throws 500 instead of returning 400.
    db.close();
    const app = buildApp({ db });
    try {
      for (const query of ["?days=14", "?days=abc", "?days=", "?days=7&days=30"]) {
        const response = await app.inject({
          method: "GET",
          url: `/api/puzzles/rating/history${query}`,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: "bad_query" });
      }
    } finally {
      await app.close();
    }
  });
});
