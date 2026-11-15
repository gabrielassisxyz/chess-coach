import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpeningPuzzlesResponseSchema,
  PuzzleRatingHistoryResponseSchema,
} from "@chess-coach/shared";
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

describe("GET /api/puzzles/openings", () => {
  let tmp: string;
  let db: Database;
  const now = new Date("2026-03-31T12:00:00.000Z");
  const fixedClock: Clock = { now: () => now };
  const daysAgo = (days: number, ms = 0): string =>
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000 - ms).toISOString();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cc-puzzle-openings-http-"));
    db = openDatabase(tmp);
  });
  afterEach(() => {
    if (db.open) db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // An imported puzzle filed under each tag of `openingTags`, as the import files it.
  function addTagged(id: string, rating: number, openingTags: string): void {
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation,
                            difficulty_rating, opening_tags)
       VALUES (?, 'lichess-db', 'tactics', 'intermediate', 'x', '[]', '[]', 'why', ?, ?)`,
    ).run(id, rating, openingTags);
    for (const tag of openingTags.split(" ")) {
      db.prepare("INSERT INTO puzzle_openings (opening, rating, puzzle_id) VALUES (?, ?, ?)").run(
        tag,
        rating,
        id,
      );
    }
  }

  function addAttempt(puzzleId: string, firstTry: boolean, at: string): void {
    db.prepare(
      `INSERT INTO puzzle_attempts (puzzle_id, attempted_at, solved, answered_uci, failed_ply, first_try)
       VALUES (?, ?, ?, '[]', NULL, ?)`,
    ).run(puzzleId, at, firstTry ? 1 : 0, firstTry ? 1 : 0);
  }

  async function ask(names: readonly string[] | string) {
    const query =
      typeof names === "string" ? names : `names=${names.map(encodeURIComponent).join(",")}`;
    const app = Fastify();
    registerPuzzleRoutes(app, db, fixedClock);
    try {
      return await app.inject({ method: "GET", url: `/api/puzzles/openings?${query}` });
    } finally {
      await app.close();
    }
  }

  it("answers each name in the order asked with its tag, its puzzles and the last 30 days", async () => {
    addTagged("it1", 1200, "Italian_Game Italian_Game_Classical_Variation");
    addTagged("it2", 1500, "Italian_Game Italian_Game_Giuoco_Pianissimo");
    addTagged("it3", 1900, "Italian_Game Italian_Game_Classical_Variation");
    addTagged("sc1", 1100, "Scandinavian_Defense Scandinavian_Defense_Main_Line");
    addTagged("qgd", 1300, "Queens_Gambit_Declined Queens_Gambit_Declined_Exchange_Variation");
    addAttempt("it1", true, daysAgo(1));
    addAttempt("it1", false, daysAgo(2));
    addAttempt("it2", true, daysAgo(30));
    addAttempt("it3", true, daysAgo(30, 1));
    addAttempt("sc1", false, daysAgo(3));
    const response = await ask([
      "Scandinavian Defense",
      "Italian Game",
      "Italian Game: Classical Variation",
      "Queen's Gambit Declined",
      "Grünfeld Defense",
    ]);
    expect(response.statusCode).toBe(200);
    expect(OpeningPuzzlesResponseSchema.parse(response.json())).toEqual({
      entries: [
        {
          name: "Scandinavian Defense",
          tag: "Scandinavian_Defense",
          puzzles: 1,
          played_30d: 1,
          first_try_30d: 0,
        },
        { name: "Italian Game", tag: "Italian_Game", puzzles: 3, played_30d: 3, first_try_30d: 2 },
        {
          name: "Italian Game: Classical Variation",
          tag: "Italian_Game_Classical_Variation",
          puzzles: 2,
          played_30d: 2,
          first_try_30d: 1,
        },
        {
          name: "Queen's Gambit Declined",
          tag: "Queens_Gambit_Declined",
          puzzles: 1,
          played_30d: 0,
          first_try_30d: 0,
        },
        {
          name: "Grünfeld Defense",
          tag: "Grunfeld_Defense",
          puzzles: 0,
          played_30d: 0,
          first_try_30d: 0,
        },
      ],
    });
  });

  it("keeps a name with a comma inside whole, and answers a name asked twice twice", async () => {
    addTagged("naj", 1500, "Sicilian_Defense Sicilian_Defense_Najdorf_Variation");
    const response = await ask([
      "Sicilian Defense: Najdorf Variation, English Attack",
      "Sicilian Defense",
      "Sicilian Defense",
    ]);
    const body = OpeningPuzzlesResponseSchema.parse(response.json());
    expect(body.entries.map(({ name, tag, puzzles }) => ({ name, tag, puzzles }))).toEqual([
      {
        name: "Sicilian Defense: Najdorf Variation, English Attack",
        tag: "Sicilian_Defense_Najdorf_Variation_English_Attack",
        puzzles: 0,
      },
      { name: "Sicilian Defense", tag: "Sicilian_Defense", puzzles: 1 },
      { name: "Sicilian Defense", tag: "Sicilian_Defense", puzzles: 1 },
    ]);
  });

  it("takes up to 40 names", async () => {
    const names = Array.from({ length: 40 }, (_, i) => `Opening ${i}`);
    const response = await ask(names);
    expect(response.statusCode).toBe(200);
    expect(OpeningPuzzlesResponseSchema.parse(response.json()).entries).toHaveLength(40);
  });

  it("answers 400 and reads nothing for a list it cannot take", async () => {
    // Closing the database guarantees any query attempt throws 500 instead of returning 400.
    db.close();
    for (const query of [
      "",
      "names=",
      `names=${Array.from({ length: 41 }, (_, i) => `Opening${i}`).join(",")}`,
      "names=Italian%20Game,,French%20Defense",
      "names=Italian%20Game,",
      `names=${"x".repeat(121)}`,
      "names=Italian%20Game&names=French%20Defense",
    ]) {
      const response = await ask(query);
      expect(response.statusCode, query).toBe(400);
      expect(response.json()).toMatchObject({ error: "bad_query" });
    }
  });

  it("turns text meant for the query into a tag of letters, digits, underscores and hyphens", async () => {
    addTagged("it1", 1200, "Italian_Game Italian_Game_Classical_Variation");
    const response = await ask(["Italian Game' OR '1'='1", "Italian_Game%"]);
    expect(OpeningPuzzlesResponseSchema.parse(response.json()).entries).toEqual([
      {
        name: "Italian Game' OR '1'='1",
        tag: "Italian_Game_OR_11",
        puzzles: 0,
        played_30d: 0,
        first_try_30d: 0,
      },
      { name: "Italian_Game%", tag: "Italian_Game", puzzles: 1, played_30d: 0, first_try_30d: 0 },
    ]);
  });
});
