import type {
  PuzzleRatingHistoryResponse,
  PuzzleRatingPoint,
  PuzzleRatingWindow,
} from "@chess-coach/shared";
import { type Clock, systemClock } from "../clock.js";
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

interface RatedAttemptRow {
  attempted_at: string;
  first_try: number;
  rating: number;
}

// CROSS JOIN keeps the attempts as the outer loop, as in the progress route's per-motif count, so a
// new index or a bigger puzzle table never turns this into a walk of every puzzle.
export const READ_RATED_ATTEMPTS_SQL = `
  SELECT a.attempted_at, a.first_try, p.difficulty_rating AS rating
  FROM puzzle_attempts a CROSS JOIN puzzles p ON p.id = a.puzzle_id
  WHERE p.difficulty_rating IS NOT NULL
  ORDER BY a.attempted_at, a.id`;

function readRatedAttempts(db: Database): RatedAttemptRow[] {
  return db.prepare(READ_RATED_ATTEMPTS_SQL).all() as RatedAttemptRow[];
}

export interface RatingReplay {
  rating: number;
  /** How many stored attempts the number was built from; 0 when it already existed. */
  replayed: number;
}

export function ensurePuzzleRating(db: Database, clock: Clock): RatingReplay {
  const existing = readPuzzleRating(db);
  if (existing !== null) return { rating: existing, replayed: 0 };
  const rows = readRatedAttempts(db);
  let rating = INITIAL_PUZZLE_RATING;
  for (const row of rows) rating = ratingAfter(rating, row.rating, row.first_try === 1);
  setPuzzleRating(db, rating, clock.now().toISOString());
  return { rating, replayed: rows.length };
}

function localDay(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Anchored at local noon so stepping by calendar day never skips or repeats a date across DST.
function localNoon(year: number, monthIndex: number, day: number): Date {
  return new Date(year, monthIndex, day, 12);
}

function parseLocalNoon(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return localNoon(year as number, (month as number) - 1, date as number);
}

function calendarDaysBetween(startDay: string, endDay: string): string[] {
  const days: string[] = [];
  const cursor = parseLocalNoon(startDay);
  for (;;) {
    const key = localDay(cursor);
    if (key > endDay) break;
    days.push(key);
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function windowStartDay(
  window: PuzzleRatingWindow,
  now: Date,
  todayDay: string,
  firstAttemptDay: string | undefined,
): string {
  if (window === "all") return firstAttemptDay ?? todayDay;
  const count = Number(window);
  return localDay(localNoon(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1)));
}

/**
 * Replays rated attempts into one closing Elo rating per local calendar day of the requested
 * window. Days without a rated attempt carry the previous day's rating; days before the first
 * rated attempt hold the initial 1200. `current` still reads the stored setting so a screen's
 * heading and chart never disagree if the setting was adjusted separately.
 */
export function puzzleRatingHistory(
  db: Database,
  window: PuzzleRatingWindow,
  clock: Clock = systemClock,
): PuzzleRatingHistoryResponse {
  const now = clock.now();
  const todayDay = localDay(now);
  const attempts = readRatedAttempts(db)
    .map((row) => ({ ...row, day: localDay(new Date(row.attempted_at)) }))
    .filter((row) => row.day <= todayDay);
  const startDay = windowStartDay(window, now, todayDay, attempts[0]?.day);
  const days = calendarDaysBetween(startDay, todayDay);

  let rating = INITIAL_PUZZLE_RATING;
  let initialForWindow = INITIAL_PUZZLE_RATING;
  const endOfDay = new Map<string, number>();
  for (const attempt of attempts) {
    rating = ratingAfter(rating, attempt.rating, attempt.first_try === 1);
    if (attempt.day < startDay) initialForWindow = rating;
    else endOfDay.set(attempt.day, rating);
  }

  let carried = initialForWindow;
  const points: PuzzleRatingPoint[] = days.map((day) => {
    carried = endOfDay.get(day) ?? carried;
    return { day, rating: carried };
  });

  const first = points[0]?.rating ?? INITIAL_PUZZLE_RATING;
  const last = points.at(-1)?.rating ?? INITIAL_PUZZLE_RATING;
  let low = first;
  let high = first;
  for (const point of points) {
    if (point.rating < low) low = point.rating;
    if (point.rating > high) high = point.rating;
  }

  return {
    current: currentPuzzleRating(db),
    points,
    low,
    high,
    change: last - first,
  };
}
