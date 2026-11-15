import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProgressResponseSchema } from "@chess-coach/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { type Database, openDatabase } from "../db/open.js";
import { INITIAL_PUZZLE_RATING, setPuzzleRating } from "../puzzles/rating.js";

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-progress-http-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/progress", () => {
  it("returns the six sections with one rating point per imported rated game", async () => {
    for (const [day, rating] of [
      [1, 412],
      [2, 425],
    ] as const) {
      db.prepare(
        `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase,
           pgn, source, source_id, student_rating, played_at)
         VALUES (?, ?, 'white', 1200, 'f', 'finished', '', 'chesscom', ?, ?, ?)`,
      ).run(
        `2026-06-0${day}T10:00:00Z`,
        `2026-06-0${day}T11:00:00Z`,
        `u${day}`,
        rating,
        `2026-06-0${day}T10:00:00Z`,
      );
    }
    const app = buildApp({ db });
    const response = await app.inject({ method: "GET", url: "/api/progress" });
    await app.close();
    expect(response.statusCode).toBe(200);
    const body = ProgressResponseSchema.parse(response.json());
    expect(body.rating_history.map((p) => p.rating)).toEqual([412, 425]);
    expect(body.games).toHaveLength(2);
  });

  it("serves the current puzzle rating", async () => {
    const app = buildApp({ db });
    const initial = ProgressResponseSchema.parse(
      (await app.inject({ method: "GET", url: "/api/progress" })).json(),
    );
    expect(initial.puzzle_rating).toBe(INITIAL_PUZZLE_RATING);
    setPuzzleRating(db, 1337, "2026-06-02T11:00:00Z");
    const updated = ProgressResponseSchema.parse(
      (await app.inject({ method: "GET", url: "/api/progress" })).json(),
    );
    await app.close();
    expect(updated.puzzle_rating).toBe(1337);
  });

  it("is rejected by the schema without an integer puzzle rating", async () => {
    const app = buildApp({ db });
    const answer = (await app.inject({ method: "GET", url: "/api/progress" })).json();
    await app.close();
    const { puzzle_rating: _dropped, ...withoutRating } = answer;
    expect(ProgressResponseSchema.safeParse(answer).success).toBe(true);
    expect(ProgressResponseSchema.safeParse(withoutRating).success).toBe(false);
    expect(ProgressResponseSchema.safeParse({ ...answer, puzzle_rating: 1200.5 }).success).toBe(
      false,
    );
  });
});
