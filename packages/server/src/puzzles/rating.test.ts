import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectAttemptsLeadThePuzzleJoin } from "../../test/support/query-plan.js";
import type { Clock } from "../clock.js";
import { type Database, openDatabase } from "../db/open.js";
import {
  currentPuzzleRating,
  ensurePuzzleRating,
  INITIAL_PUZZLE_RATING,
  puzzleRatingHistory,
  READ_RATED_ATTEMPTS_SQL,
  ratingAfter,
  readPuzzleRating,
  setPuzzleRating,
} from "./rating.js";

const T0 = new Date("2026-03-01T00:00:00.000Z");
const clock: Clock = { now: () => T0 };

// Local noon of a June 2026 day so calendar-day tests stay independent of the runner's timezone.
const at = (day: number, hour = 12, minute = 0): string =>
  new Date(2026, 5, day, hour, minute).toISOString();
const clockOn = (day: number): Clock => ({ now: () => new Date(2026, 5, day, 12) });

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

function addAttempt(puzzleId: string, firstTry: boolean, at: string, solved = firstTry): void {
  db.prepare(
    `INSERT INTO puzzle_attempts (puzzle_id, attempted_at, solved, answered_uci, failed_ply, first_try)
     VALUES (?, ?, ?, '[]', NULL, ?)`,
  ).run(puzzleId, at, solved ? 1 : 0, firstTry ? 1 : 0);
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

describe("puzzleRatingHistory", () => {
  it("answers today at 1200 for all time and a flat 1200 window when no rated attempt exists", () => {
    expect(puzzleRatingHistory(db, "all", clockOn(10))).toEqual({
      current: 1200,
      points: [{ day: "2026-06-10", rating: 1200 }],
      low: 1200,
      high: 1200,
      change: 0,
    });

    const week = puzzleRatingHistory(db, "7", clockOn(10));
    expect(week).toEqual({
      current: 1200,
      points: [
        { day: "2026-06-04", rating: 1200 },
        { day: "2026-06-05", rating: 1200 },
        { day: "2026-06-06", rating: 1200 },
        { day: "2026-06-07", rating: 1200 },
        { day: "2026-06-08", rating: 1200 },
        { day: "2026-06-09", rating: 1200 },
        { day: "2026-06-10", rating: 1200 },
      ],
      low: 1200,
      high: 1200,
      change: 0,
    });
    expect(puzzleRatingHistory(db, "30", clockOn(10)).points).toHaveLength(30);
    expect(puzzleRatingHistory(db, "90", clockOn(10)).points).toHaveLength(90);
  });

  it("folds attempts in order by local day, carrying values across quiet days and across window starts", () => {
    addPuzzle("p1", 1400);
    addPuzzle("p2", 1200);
    addPuzzle("p3", 1000);

    // Day 2 (before the 7-day window starting on Day 4): 1200 -> 1224.
    addAttempt("p1", true, at(2));
    // Day 6: win p1 (1224 -> 1247), then solved p3 after a wrong try (1247 -> 1221).
    // Intraday high was 1247, but the day closes at 1221.
    addAttempt("p1", true, at(6, 10));
    addAttempt("p3", false, at(6, 15), true);
    // Day 8: miss p2 (1221 -> 1204).
    addAttempt("p2", false, at(8));

    const week = puzzleRatingHistory(db, "7", clockOn(10));
    expect(week.points).toEqual([
      { day: "2026-06-04", rating: 1224 },
      { day: "2026-06-05", rating: 1224 },
      { day: "2026-06-06", rating: 1221 },
      { day: "2026-06-07", rating: 1221 },
      { day: "2026-06-08", rating: 1204 },
      { day: "2026-06-09", rating: 1204 },
      { day: "2026-06-10", rating: 1204 },
    ]);
    expect(week.low).toBe(1204);
    expect(week.high).toBe(1224);
    expect(week.change).toBe(-20);

    // All time starts on Day 2 (first rated attempt), not before.
    const all = puzzleRatingHistory(db, "all", clockOn(10));
    expect(all.points[0]).toEqual({ day: "2026-06-02", rating: 1224 });
    expect(all.points.at(-1)).toEqual({ day: "2026-06-10", rating: 1204 });
    expect(all.points).toHaveLength(9);
    expect(all.low).toBe(1204);
    expect(all.high).toBe(1224);
    expect(all.change).toBe(-20);

    // A 30-day window starts with 1200 before the first attempt.
    const month = puzzleRatingHistory(db, "30", clockOn(10));
    expect(month.points).toHaveLength(30);
    expect(month.points[0]).toEqual({ day: "2026-05-12", rating: 1200 });
    expect(month.low).toBe(1200);
    expect(month.high).toBe(1224);
    expect(month.change).toBe(4);
  });

  it("assigns attempts to their local calendar day around midnight", () => {
    addPuzzle("p1", 1200);
    addAttempt("p1", true, at(5, 23, 50));
    addAttempt("p1", true, at(6, 0, 10));

    const history = puzzleRatingHistory(db, "7", clockOn(7));
    expect(history.points.slice(3)).toEqual([
      { day: "2026-06-04", rating: 1200 },
      { day: "2026-06-05", rating: 1216 },
      { day: "2026-06-06", rating: 1231 },
      { day: "2026-06-07", rating: 1231 },
    ]);
  });

  it("ignores attempts on unrated puzzles in both ratings and the all-time start day", () => {
    addPuzzle("opening", null);
    addPuzzle("rated", 1400);

    addAttempt("opening", true, at(1));
    expect(puzzleRatingHistory(db, "all", clockOn(10))).toEqual({
      current: 1200,
      points: [{ day: "2026-06-10", rating: 1200 }],
      low: 1200,
      high: 1200,
      change: 0,
    });

    addAttempt("rated", true, at(8));
    addAttempt("opening", false, at(9));
    const all = puzzleRatingHistory(db, "all", clockOn(10));
    expect(all.points).toEqual([
      { day: "2026-06-08", rating: 1224 },
      { day: "2026-06-09", rating: 1224 },
      { day: "2026-06-10", rating: 1224 },
    ]);
    expect(all.low).toBe(1224);
    expect(all.high).toBe(1224);
    expect(all.change).toBe(0);
  });

  it("agrees with ensurePuzzleRating on the five-attempt one-day replay", () => {
    const day = at(10);
    for (const [id, rating, firstTry] of [
      ["r1", 1251, true],
      ["r2", 1135, true],
      ["r3", 1368, true],
      ["r4", 1087, true],
      ["r5", 1058, false],
    ] as const) {
      addPuzzle(id, rating);
      addAttempt(id, firstTry, day);
    }

    const replayed = ensurePuzzleRating(db, clockOn(10));
    const history = puzzleRatingHistory(db, "30", clockOn(10));
    expect(history.points.at(-1)?.rating).toBe(replayed.rating);
    expect(history.current).toBe(replayed.rating);
  });

  it("returns currentPuzzleRating(db) for current even when settings differ from the fold", () => {
    addPuzzle("p1", 1400);
    addAttempt("p1", true, at(10));
    setPuzzleRating(db, 1500, at(10));

    const history = puzzleRatingHistory(db, "7", clockOn(10));
    expect(history.current).toBe(1500);
    expect(history.points.at(-1)?.rating).toBe(1224);
  });
});

// The boot replay and the rating chart both read the attempts through this query, so it must cost
// what the attempts cost and not what the puzzle table does.
describe("rated attempt read query plan", () => {
  it("starts from the attempts and reaches a puzzle only by its primary key", () => {
    expectAttemptsLeadThePuzzleJoin(db, READ_RATED_ATTEMPTS_SQL);
  });
});
