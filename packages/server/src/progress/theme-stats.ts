import type {
  PuzzleRatingWindow,
  ThemeStatsEntry,
  ThemeStatsOverall,
  ThemeStatsResponse,
} from "@chess-coach/shared";
import { THEME_OF_MOTIF } from "../activity/training.js";
import type { Clock } from "../clock.js";
import type { Database } from "../db/open.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Where a puzzle came from, not what it asks.
const ORIGIN_THEMES: ReadonlySet<string> = new Set(["master", "masterVsMaster", "superGM"]);
// On six puzzles in ten and nothing to train: they keep their figures but are never ranked.
const LENGTH_AND_GOAL_THEMES: ReadonlySet<string> = new Set([
  "oneMove",
  "short",
  "long",
  "veryLong",
  "equality",
  "advantage",
  "crushing",
]);
// Below this a theme's performance is noise: about 177 points of typical error at 8 attempts.
const RANKED_MIN_ATTEMPTS = 8;
const RANKED_LIST_MAX = 8;

interface ThemedAttempt {
  /** `attempted_at` in epoch milliseconds. */
  at: number;
  firstTry: boolean;
  rating: number;
  themes: ReadonlySet<string>;
}

interface AttemptTally {
  played: number;
  firstTry: number;
  ratingSum: number;
}

type AttemptFilter = (at: number) => boolean;

// A library puzzle has no themes, only a motif, read the way the themed practice queue reads it.
function themesOfPuzzle(themes: string | null, motif: string): ReadonlySet<string> {
  const keys = themes === null ? [THEME_OF_MOTIF[motif] ?? motif] : themes.split(" ");
  return new Set(keys.filter((key) => key !== "" && !ORIGIN_THEMES.has(key)));
}

function readThemedAttempts(db: Database): ThemedAttempt[] {
  const rows = db
    .prepare(
      `SELECT a.attempted_at, a.first_try, p.difficulty_rating AS rating, p.themes, p.motif
       FROM puzzle_attempts a JOIN puzzles p ON p.id = a.puzzle_id
       WHERE p.difficulty_rating IS NOT NULL`,
    )
    .all() as {
    attempted_at: string;
    first_try: number;
    rating: number;
    themes: string | null;
    motif: string;
  }[];
  return rows.map((row) => ({
    at: Date.parse(row.attempted_at),
    firstTry: row.first_try === 1,
    rating: row.rating,
    themes: themesOfPuzzle(row.themes, row.motif),
  }));
}

// The window before has the asked one's length and ends at its start, an instant the asked one keeps.
function windowFilters(
  days: PuzzleRatingWindow,
  now: Date,
): { current: AttemptFilter; previous: AttemptFilter | null } {
  if (days === "all") return { current: () => true, previous: null };
  const end = now.getTime();
  const length = Number(days) * DAY_MS;
  const start = end - length;
  return {
    current: (at) => at >= start && at <= end,
    previous: (at) => at >= start - length && at < start,
  };
}

function emptyTally(): AttemptTally {
  return { played: 0, firstTry: 0, ratingSum: 0 };
}

function addAttempt(tally: AttemptTally, attempt: ThemedAttempt): void {
  tally.played += 1;
  tally.firstTry += attempt.firstTry ? 1 : 0;
  tally.ratingSum += attempt.rating;
}

// The Lichess puzzle dashboard's performance (PuzzleDashboard.scala in lichess-org/lila).
function ratingFigures(tally: AttemptTally): { rating_avg: number; performance: number } {
  const ratingAvg = tally.ratingSum / tally.played;
  return {
    rating_avg: Math.round(ratingAvg),
    performance: Math.round(ratingAvg - 500 + (1000 * tally.firstTry) / tally.played),
  };
}

function overallOf(attempts: readonly ThemedAttempt[]): ThemeStatsOverall {
  const tally = emptyTally();
  for (const attempt of attempts) addAttempt(tally, attempt);
  const counts = { played: tally.played, first_try: tally.firstTry };
  if (tally.played === 0) return { ...counts, rating_avg: null, performance: null };
  return { ...counts, ...ratingFigures(tally) };
}

function themeEntries(attempts: readonly ThemedAttempt[]): ThemeStatsEntry[] {
  const tallies = new Map<string, AttemptTally>();
  for (const attempt of attempts) {
    for (const theme of attempt.themes) {
      const tally = tallies.get(theme) ?? emptyTally();
      addAttempt(tally, attempt);
      tallies.set(theme, tally);
    }
  }
  return [...tallies]
    .map(([theme, tally]) => ({
      theme,
      played: tally.played,
      first_try: tally.firstTry,
      ...ratingFigures(tally),
      ranked: tally.played >= RANKED_MIN_ATTEMPTS && !LENGTH_AND_GOAL_THEMES.has(theme),
    }))
    .sort((a, b) => b.played - a.played || a.theme.localeCompare(b.theme));
}

function topRanked(
  themes: readonly ThemeStatsEntry[],
  qualifies: (entry: ThemeStatsEntry) => boolean,
  byPerformance: (a: ThemeStatsEntry, b: ThemeStatsEntry) => number,
): string[] {
  return (
    themes
      .filter((entry) => entry.ranked && qualifies(entry))
      // At equal performance the theme with more attempts, whose figure is better measured, leads.
      .sort((a, b) => byPerformance(a, b) || b.played - a.played || a.theme.localeCompare(b.theme))
      .slice(0, RANKED_LIST_MAX)
      .map((entry) => entry.theme)
  );
}

// A theme solved first try every time has nothing to improve, whatever its performance.
function improvementAreas(themes: readonly ThemeStatsEntry[], overall: number): string[] {
  return topRanked(
    themes,
    (entry) => entry.performance < overall && entry.first_try < entry.played,
    (a, b) => a.performance - b.performance,
  );
}

function strengths(themes: readonly ThemeStatsEntry[], overall: number): string[] {
  return topRanked(
    themes,
    (entry) => entry.performance > overall && entry.first_try > 0,
    (a, b) => b.performance - a.performance,
  );
}

/**
 * The student's rated puzzle attempts of one window, overall and per theme, computed at request
 * time. A theme is ranked against the overall performance of the same window, not against the Elo
 * puzzle rating: the two are on different scales and, with few attempts, far apart.
 */
export function computeThemeStats(
  db: Database,
  days: PuzzleRatingWindow,
  clock: Clock,
): ThemeStatsResponse {
  const attempts = readThemedAttempts(db);
  const { current, previous } = windowFilters(days, clock.now());
  const inWindow = attempts.filter((attempt) => current(attempt.at));
  const overall = overallOf(inWindow);
  const themes = themeEntries(inWindow);
  const yardstick = overall.performance;
  return {
    days,
    overall,
    overall_previous:
      previous === null ? null : overallOf(attempts.filter((attempt) => previous(attempt.at))),
    themes,
    improvement_areas: yardstick === null ? [] : improvementAreas(themes, yardstick),
    strengths: yardstick === null ? [] : strengths(themes, yardstick),
    unranked: themes.filter((entry) => entry.played < RANKED_MIN_ATTEMPTS).length,
  };
}
