import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../clock.js";
import { type Database, openDatabase } from "../db/open.js";
import {
  currentPuzzleRating,
  ensurePuzzleRating,
  INITIAL_PUZZLE_RATING,
  ratingAfter,
  readPuzzleRating,
  setPuzzleRating,
} from "./rating.js";

const T0 = new Date("2026-03-01T00:00:00.000Z");
const clock: Clock = { now: () => T0 };

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-rating-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function addPuzzle(id: string, rating: number | null): void {
  db.prepare(
    `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation, difficulty_rating)
     VALUES (?, 'test', 'fork', 'easy', 'x', '[]', '[]', 'why', ?)`,
  ).run(id, rating);
}

function addAttempt(puzzleId: string, firstTry: boolean, at: string): void {
  db.prepare(
    `INSERT INTO puzzle_attempts (puzzle_id, attempted_at, solved, answered_uci, failed_ply, first_try)
     VALUES (?, ?, ?, '[]', NULL, ?)`,
  ).run(puzzleId, at, firstTry ? 1 : 0, firstTry ? 1 : 0);
}

describe("ratingAfter", () => {
  it("gains more against a stronger puzzle and loses more against a weaker one", () => {
    expect(ratingAfter(1200, 1400, true)).toBe(1224);
    expect(ratingAfter(1200, 1400, false)).toBe(1192);
    expect(ratingAfter(1200, 1000, true)).toBe(1208);
    expect(ratingAfter(1200, 1000, false)).toBe(1176);
  });

  it("moves by half the factor against an equal puzzle", () => {
    expect(ratingAfter(1500, 1500, true)).toBe(1516);
    expect(ratingAfter(1500, 1500, false)).toBe(1484);
  });
});

describe("ensurePuzzleRating", () => {
  it("starts from the default when nothing was ever attempted", () => {
    expect(readPuzzleRating(db)).toBeNull();
    expect(currentPuzzleRating(db)).toBe(INITIAL_PUZZLE_RATING);
    expect(ensurePuzzleRating(db, clock)).toEqual({ rating: 1200, replayed: 0 });
    expect(readPuzzleRating(db)).toBe(1200);
  });

  it("replays the stored attempts in order, skipping puzzles without a rating", () => {
    addPuzzle("hard", 1400);
    addPuzzle("easy", 1000);
    addPuzzle("opening", null);
    addAttempt("easy", false, "2026-01-02T00:00:00.000Z");
    addAttempt("hard", true, "2026-01-01T00:00:00.000Z");
    addAttempt("opening", true, "2026-01-03T00:00:00.000Z");
    // hard first (1200 -> 1224), then easy lost (1224 -> 1224 - 32 * 0.78 = 1199).
    expect(ensurePuzzleRating(db, clock)).toEqual({ rating: 1199, replayed: 2 });
  });

  it("changes nothing once the rating exists", () => {
    setPuzzleRating(db, 1337, T0.toISOString());
    addPuzzle("hard", 1400);
    addAttempt("hard", true, "2026-01-01T00:00:00.000Z");
    expect(ensurePuzzleRating(db, clock)).toEqual({ rating: 1337, replayed: 0 });
    expect(currentPuzzleRating(db)).toBe(1337);
  });
});
