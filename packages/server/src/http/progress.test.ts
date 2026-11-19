import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProgressResponseSchema, ThemeStatsResponseSchema } from "@chess-coach/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrainingRun } from "../activity/training.js";
import { buildApp } from "../app.js";
import { type Database, openDatabase } from "../db/open.js";
import { INITIAL_PUZZLE_RATING, setPuzzleRating } from "../puzzles/rating.js";
import { ReviewDesk } from "../srs/review.js";

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

  it("serves the streak, the weekly flags and the coming due counts with the schema", async () => {
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase,
         pgn, source)
       VALUES (?, ?, 'white', 1200, 'f', 'finished', '', 'coach')`,
    ).run(nowIso, nowIso);
    db.prepare(
      `INSERT INTO srs_cards (source_kind, prompt_fen, student_color, expected_uci, created_at, next_review_at)
       VALUES ('teaching', 'f', 'white', 'd2d4', 't', ?)`,
    ).run(nowIso);
    const app = buildApp({ db });
    const body = ProgressResponseSchema.parse(
      (await app.inject({ method: "GET", url: "/api/progress" })).json(),
    );
    await app.close();
    expect(body.streak_days).toBe(1);
    expect(body.streak_best).toBe(1);
    expect(body.activity_7d).toEqual([false, false, false, false, false, false, true]);
    expect(body.cards.due_next_7d).toEqual([1, 0, 0, 0, 0, 0, 0]);
    expect(body.cards.correct_rate_prev_30d).toBeNull();
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

describe("GET /api/puzzles/themes/stats", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  // The route reads the system clock, so the attempts are placed against the real now.
  function addRatedAttempt(id: string, daysAgo: number): void {
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation,
         difficulty_rating, themes)
       VALUES (?, 'test', 'fork', 'easy', 'fen', 'e2e4', 'e4', 'why', 1500, 'fork short')`,
    ).run(id);
    db.prepare(
      `INSERT INTO puzzle_attempts (puzzle_id, attempted_at, solved, answered_uci, first_try)
       VALUES (?, ?, 1, '[]', 1)`,
    ).run(id, new Date(Date.now() - daysAgo * DAY_MS).toISOString());
  }

  it("answers the shared schema over the last 30 days when no window is asked", async () => {
    addRatedAttempt("recent", 1);
    addRatedAttempt("older", 31);
    const app = buildApp({ db });
    const answers = new Map<string, { status: number; body: unknown }>();
    for (const url of ["", "?days=30", "?days=90", "?days=all"]) {
      const response = await app.inject({ method: "GET", url: `/api/puzzles/themes/stats${url}` });
      answers.set(url, { status: response.statusCode, body: response.json() });
    }
    await app.close();
    const byDefault = answers.get("");
    expect(byDefault?.status).toBe(200);
    expect(Object.keys(byDefault?.body as object).sort()).toEqual([
      "days",
      "improvement_areas",
      "overall",
      "overall_previous",
      "strengths",
      "themes",
      "unranked",
    ]);
    const parsed = (url: string) => ThemeStatsResponseSchema.parse(answers.get(url)?.body);
    expect(parsed("")).toEqual(parsed("?days=30"));
    expect(parsed("")).toMatchObject({ days: "30", overall: { played: 1 }, unranked: 2 });
    expect(parsed("?days=90")).toMatchObject({ days: "90", overall: { played: 2 } });
    expect(parsed("?days=all")).toMatchObject({
      days: "all",
      overall: { played: 2 },
      overall_previous: null,
    });
  });

  it("answers the same played and first-try counts before and after a retry of an ended puzzle", async () => {
    addRatedAttempt("earlier", 2);
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san,
         explanation, difficulty_rating, themes)
       VALUES ('played', 'test', 'skewer', 'easy', '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1',
         '["a1a8"]', '["Ra8#"]', 'why', 1500, 'fork short')`,
    ).run();
    const app = buildApp({ db });
    const overall = async (): Promise<unknown> =>
      ThemeStatsResponseSchema.parse(
        (await app.inject({ method: "GET", url: "/api/puzzles/themes/stats" })).json(),
      ).overall;
    // The only puzzle of its motif, so the queue holds it alone and not the attempt fixture.
    const run = TrainingRun.begin(
      { db, desk: new ReviewDesk({ db }) },
      { mode: "puzzles", motif: "skewer" },
    );
    expect(run.state(1).item).toMatchObject({ kind: "puzzle", puzzle_id: "played" });
    run.tryMove("a1a8");
    const before = await overall();
    expect(before).toMatchObject({ played: 2, first_try: 2 });
    run.retry();
    run.showSolution();
    const after = await overall();
    await app.close();
    expect(after).toMatchObject({ played: 2, first_try: 2 });
    expect(after).toEqual(before);
  });

  it("refuses a window it does not offer with bad_query", async () => {
    const app = buildApp({ db });
    const answers: { status: number; body: unknown }[] = [];
    for (const days of ["14", "abc"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/puzzles/themes/stats?days=${days}`,
      });
      answers.push({ status: response.statusCode, body: response.json() });
    }
    await app.close();
    for (const answer of answers) {
      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ error: "bad_query" });
    }
  });
});
