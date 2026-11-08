import type { Clock } from "../clock.js";
import type { Database } from "../db/open.js";

/**
 * The student's puzzle rating: plain Elo against the library's difficulty ratings. A first-try
 * solve is a win, anything else (a wrong try, a hint, the solution) a loss; a puzzle without a
 * rating moves nothing. It lives in `settings` and is written once from the stored attempts, so
 * the number starts from the history rather than from the default.
 */
export const INITIAL_PUZZLE_RATING = 1200;
export const PUZZLE_RATING_K = 32;
const KEY = "puzzle_rating";

export function ratingAfter(
  student: number,
  puzzle: number,
  won: boolean,
  k: number = PUZZLE_RATING_K,
): number {
  const expected = 1 / (1 + 10 ** ((puzzle - student) / 400));
  return Math.round(student + k * ((won ? 1 : 0) - expected));
}

export function readPuzzleRating(db: Database): number | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : null;
}

export function currentPuzzleRating(db: Database): number {
  return readPuzzleRating(db) ?? INITIAL_PUZZLE_RATING;
}

export function setPuzzleRating(db: Database, value: number, updatedAt: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(KEY, String(value), updatedAt);
}

export interface RatingReplay {
  rating: number;
  /** How many stored attempts the number was built from; 0 when it already existed. */
  replayed: number;
}

export function ensurePuzzleRating(db: Database, clock: Clock): RatingReplay {
  const existing = readPuzzleRating(db);
  if (existing !== null) return { rating: existing, replayed: 0 };
  const rows = db
    .prepare(
      `SELECT a.first_try, p.difficulty_rating AS rating
       FROM puzzle_attempts a JOIN puzzles p ON p.id = a.puzzle_id
       WHERE p.difficulty_rating IS NOT NULL
       ORDER BY a.attempted_at, a.id`,
    )
    .all() as { first_try: number; rating: number }[];
  let rating = INITIAL_PUZZLE_RATING;
  for (const row of rows) rating = ratingAfter(rating, row.rating, row.first_try === 1);
  setPuzzleRating(db, rating, clock.now().toISOString());
  return { rating, replayed: rows.length };
}
