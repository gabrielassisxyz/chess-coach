import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PuzzleRatingWindow,
  type ThemeStatsEntry,
  type ThemeStatsResponse,
  ThemeStatsResponseSchema,
} from "@chess-coach/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../clock.js";
import { type Database, openDatabase } from "../db/open.js";
import { computeThemeStats } from "./theme-stats.js";

const NOW = new Date("2026-06-30T12:00:00.000Z");
const clock: Clock = { now: () => NOW };
const DAY_MS = 24 * 60 * 60 * 1000;

let tmp: string;
let db: Database;
let puzzleCount = 0;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-theme-stats-"));
  db = openDatabase(tmp);
  puzzleCount = 0;
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface AttemptFixture {
  /** `difficulty_rating`; null for an unrated puzzle. */
  rating?: number | null;
  /** `puzzles.themes`; null for a library puzzle, which has only its motif. */
  themes?: string | null;
  motif?: string;
  firstTry?: boolean;
  daysAgo?: number;
}

// One puzzle of its own per attempt, so every attempt carries exactly the themes it is given.
function addAttempt(fixture: AttemptFixture = {}): void {
  puzzleCount += 1;
  const id = `test:${puzzleCount}`;
  const firstTry = fixture.firstTry ?? true;
  db.prepare(
    `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation,
       difficulty_rating, themes)
     VALUES (?, 'test', ?, 'easy', 'fen', 'e2e4', 'e4', 'why', ?, ?)`,
  ).run(
    id,
    fixture.motif ?? "fork",
    fixture.rating === undefined ? 1500 : fixture.rating,
    fixture.themes === undefined ? "fork" : fixture.themes,
  );
  db.prepare(
    `INSERT INTO puzzle_attempts (puzzle_id, attempted_at, solved, answered_uci, first_try)
     VALUES (?, ?, ?, '[]', ?)`,
  ).run(
    id,
    new Date(NOW.getTime() - (fixture.daysAgo ?? 1) * DAY_MS).toISOString(),
    firstTry ? 1 : 0,
    firstTry ? 1 : 0,
  );
}

// `firstTry` of `played` attempts on puzzles of one theme and one rating.
function addThemeAttempts(theme: string, played: number, firstTry: number, rating: number): void {
  for (let index = 0; index < played; index += 1) {
    addAttempt({ themes: theme, rating, firstTry: index < firstTry });
  }
}

function stats(days: PuzzleRatingWindow): ThemeStatsResponse {
  return ThemeStatsResponseSchema.parse(computeThemeStats(db, days, clock));
}

function themeOf(answer: ThemeStatsResponse, key: string): ThemeStatsEntry | undefined {
  return answer.themes.find((entry) => entry.theme === key);
}

describe("computeThemeStats counting", () => {
  it("rates a theme by the dashboard's performance: average rating - 500 + 1000 x first-try share", () => {
    for (const [rating, firstTry, themes] of [
      [1251, true, "crushing endgame fork short"],
      [1135, true, "crushing endgame fork short"],
      [1058, false, "advantage fork long middlegame"],
      [1368, true, "advantage endgame exposedKing fork long"],
      [1087, true, "endgame equality fork short"],
    ] as const) {
      addAttempt({ rating, firstTry, themes });
    }
    expect(themeOf(stats("30"), "fork")).toEqual({
      theme: "fork",
      played: 5,
      first_try: 4,
      rating_avg: 1180,
      performance: 1480,
      ranked: false,
    });
  });

  it("counts an attempt once overall and once under each theme of its puzzle", () => {
    addAttempt({ themes: "fork pin" });
    const before = stats("30");
    addAttempt({ themes: "fork endgame short" });
    const after = stats("30");
    const played = (answer: ThemeStatsResponse, key: string) => themeOf(answer, key)?.played ?? 0;
    expect(after.overall.played - before.overall.played).toBe(1);
    for (const key of ["fork", "endgame", "short"]) {
      expect(played(after, key) - played(before, key)).toBe(1);
    }
    expect(played(after, "pin")).toBe(played(before, "pin"));
  });

  it("changes nothing for an attempt on an unrated puzzle", () => {
    addAttempt({ themes: "fork short", rating: 1400, firstTry: false });
    addAttempt({ themes: "fork short", rating: 1300 });
    const before = { month: stats("30"), all: stats("all") };
    addAttempt({ themes: "fork short", rating: null });
    addAttempt({ themes: null, motif: "opening-white", rating: null });
    expect({ month: stats("30"), all: stats("all") }).toEqual(before);
  });

  it("answers nothing played and empty lists when the window holds no rated attempt", () => {
    expect(stats("30")).toEqual({
      days: "30",
      overall: { played: 0, first_try: 0, rating_avg: null, performance: null },
      overall_previous: { played: 0, first_try: 0, rating_avg: null, performance: null },
      themes: [],
      improvement_areas: [],
      strengths: [],
      unranked: 0,
    });
    addAttempt({ daysAgo: 40 });
    addAttempt({ rating: null });
    const empty = stats("30");
    expect(empty.overall.played).toBe(0);
    expect(empty.overall.performance).toBeNull();
    expect(empty.themes).toEqual([]);
    expect(empty.improvement_areas).toEqual([]);
    expect(empty.strengths).toEqual([]);
  });
});

describe("computeThemeStats windows", () => {
  it("leaves an attempt 31 days old out of 30 days and counts it in 90 days and all time", () => {
    addAttempt({ daysAgo: 29 });
    addAttempt({ daysAgo: 31 });
    expect(stats("30").overall.played).toBe(1);
    expect(stats("90").overall.played).toBe(2);
    expect(stats("all").overall.played).toBe(2);
  });

  it("answers the window before beside the asked one, and none for all time", () => {
    for (const daysAgo of [1, 2, 3, 4]) addAttempt({ daysAgo });
    for (const daysAgo of [31, 35, 40, 45, 50, 59]) addAttempt({ daysAgo });
    // Older than the window before: it must not leak into it.
    addAttempt({ daysAgo: 61 });
    const month = stats("30");
    expect(month.days).toBe("30");
    expect(month.overall.played).toBe(4);
    expect(month.overall_previous?.played).toBe(6);
    const week = stats("7");
    expect(week.overall_previous?.played).toBe(0);
    expect(week.overall_previous?.performance).toBeNull();
    expect(stats("all").overall_previous).toBeNull();
  });

  it("counts an attempt made exactly one window ago in the asked window only", () => {
    addAttempt({ daysAgo: 30 });
    const month = stats("30");
    expect(month.overall.played).toBe(1);
    expect(month.overall_previous?.played).toBe(0);
  });
});

describe("computeThemeStats themes", () => {
  it("reads a library puzzle's theme from its motif the way the themed queue does", () => {
    addAttempt({ themes: null, motif: "back_rank_mate" });
    addAttempt({ themes: null, motif: "checkmate" });
    addAttempt({ themes: null, motif: "fork" });
    expect(
      stats("30")
        .themes.map((entry) => entry.theme)
        .sort(),
    ).toEqual(["backRankMate", "fork", "mate"]);
  });

  it("never reports the origin themes master, masterVsMaster and superGM", () => {
    // Weak and strong enough that each origin theme would enter a list if it were counted.
    addThemeAttempts("masterVsMaster superGM pin", 8, 0, 1000);
    addThemeAttempts("master fork", 8, 8, 2000);
    const answer = stats("30");
    const reported = [
      ...answer.themes.map((entry) => entry.theme),
      ...answer.improvement_areas,
      ...answer.strengths,
    ];
    for (const origin of ["master", "masterVsMaster", "superGM"]) {
      expect(reported).not.toContain(origin);
    }
    expect(answer.improvement_areas).toEqual(["pin"]);
    expect(answer.strengths).toEqual(["fork"]);
  });
});

describe("computeThemeStats ranking", () => {
  it("lists a theme with 8 attempts, a performance below the overall one and a miss", () => {
    addThemeAttempts("pin", 8, 7, 1000);
    addThemeAttempts("fork", 8, 8, 2000);
    const answer = stats("30");
    expect(themeOf(answer, "pin")).toMatchObject({ played: 8, performance: 1375, ranked: true });
    expect(answer.overall.performance).toBe(1938);
    expect(answer.improvement_areas).toEqual(["pin"]);
    expect(answer.unranked).toBe(0);
  });

  it("leaves a theme with 7 attempts unranked and counts it in unranked", () => {
    addThemeAttempts("pin", 7, 6, 1000);
    addThemeAttempts("fork", 8, 8, 2000);
    const answer = stats("30");
    const pin = themeOf(answer, "pin");
    expect(pin).toMatchObject({ played: 7, ranked: false });
    expect(pin?.performance).toBeLessThan(answer.overall.performance ?? 0);
    expect(answer.improvement_areas).not.toContain("pin");
    expect(answer.unranked).toBe(1);
  });

  it("never ranks short, even with 20 attempts", () => {
    addThemeAttempts("short", 20, 10, 1000);
    addThemeAttempts("fork", 8, 8, 2000);
    const answer = stats("30");
    const short = themeOf(answer, "short");
    expect(short).toMatchObject({ played: 20, first_try: 10, performance: 1000, ranked: false });
    expect(short?.performance).toBeLessThan(answer.overall.performance ?? 0);
    expect(answer.improvement_areas).not.toContain("short");
    expect(answer.strengths).not.toContain("short");
    expect(answer.strengths).toEqual(["fork"]);
    expect(answer.unranked).toBe(0);
  });

  it("never lists a theme solved first try every time as an improvement area", () => {
    addThemeAttempts("pin", 8, 8, 600);
    addThemeAttempts("fork", 8, 4, 2000);
    const answer = stats("30");
    const pin = themeOf(answer, "pin");
    expect(pin).toMatchObject({ played: 8, first_try: 8, ranked: true });
    expect(pin?.performance).toBeLessThan(answer.overall.performance ?? 0);
    expect(answer.improvement_areas).toEqual([]);
  });

  it("keeps the eight weakest and the eight strongest of ten, a tie to the theme with more attempts", () => {
    // Half solved first try, so each theme's performance is its puzzles' rating.
    const weak: [string, number, number][] = [
      ["w1", 8, 700],
      ["w2", 8, 710],
      ["tieFewer", 8, 720],
      ["tieMore", 10, 720],
      ["w5", 8, 740],
      ["w6", 8, 750],
      ["w7", 8, 760],
      ["w8", 8, 770],
      ["w9", 8, 780],
      ["w10", 8, 790],
    ];
    const strong: [string, number, number][] = [
      ["s1", 8, 2700],
      ["s2", 8, 2690],
      ["strongTieFewer", 8, 2680],
      ["strongTieMore", 10, 2680],
      ["s5", 8, 2660],
      ["s6", 8, 2650],
      ["s7", 8, 2640],
      ["s8", 8, 2630],
      ["s9", 8, 2620],
      ["s10", 8, 2610],
    ];
    for (const [theme, played, rating] of [...weak, ...strong]) {
      addThemeAttempts(theme, played, played / 2, rating);
    }
    const answer = stats("30");
    expect(themeOf(answer, "tieMore")?.performance).toBe(themeOf(answer, "tieFewer")?.performance);
    expect(answer.improvement_areas).toEqual([
      "w1",
      "w2",
      "tieMore",
      "tieFewer",
      "w5",
      "w6",
      "w7",
      "w8",
    ]);
    expect(answer.strengths).toEqual([
      "s1",
      "s2",
      "strongTieMore",
      "strongTieFewer",
      "s5",
      "s6",
      "s7",
      "s8",
    ]);
  });
});
