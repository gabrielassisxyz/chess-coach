import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentDir } from "../paths.js";
import { seedPuzzles } from "../puzzles/seed.js";
import { type Database, openDatabase } from "./open.js";
import { getPuzzle, listPuzzles, recordPuzzleAttempt } from "./puzzles.js";

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-puzzles-"));
  db = openDatabase(tmp);
  seedPuzzles(db, contentDir());
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const attempt = (puzzleId: string, solved: boolean) =>
  recordPuzzleAttempt(db, {
    puzzleId,
    attemptedAt: "2026-01-01T00:00:00.000Z",
    solved,
    answered: ["a1a2"],
    failedPly: solved ? null : 0,
    firstTry: solved,
    tries: solved ? 0 : 1,
    gaveUp: !solved,
  });

// Deterministic source for the shuffle, so the order is stable in tests.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("listPuzzles", () => {
  it("orders by attempts, then id, so unseen puzzles come first", () => {
    attempt("forks:0", false);
    attempt("forks:0", true);
    attempt("forks:1", true);
    const all = listPuzzles(db, { motif: "fork", limit: 50 }, seededRandom(7)).puzzles;
    expect(all.at(-1)?.id).toBe("forks:0");
    expect(all.at(-2)?.id).toBe("forks:1");
    expect(all.at(-1)).toMatchObject({ attempts: 2, solved: 1 });
  });

  it("shuffles within equal attempt counts, stably for one seed", () => {
    const first = listPuzzles(db, { motif: "pin", limit: 28 }, seededRandom(11)).puzzles.map(
      (p) => p.id,
    );
    const second = listPuzzles(db, { motif: "pin", limit: 28 }, seededRandom(11)).puzzles.map(
      (p) => p.id,
    );
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(28);
  });

  it("gives different orders for different seeds over unseen puzzles", () => {
    const first = listPuzzles(
      db,
      { motif: "back_rank_mate", limit: 30 },
      seededRandom(1),
    ).puzzles.map((p) => p.id);
    const second = listPuzzles(
      db,
      { motif: "back_rank_mate", limit: 30 },
      seededRandom(2),
    ).puzzles.map((p) => p.id);
    expect(first).not.toEqual(second);
    expect([...first].sort()).toEqual([...second].sort());
  });

  it("defaults to 10, caps at 50 and floors at 1", () => {
    expect(listPuzzles(db).puzzles).toHaveLength(10);
    expect(listPuzzles(db, { limit: 500 }).puzzles).toHaveLength(50);
    expect(listPuzzles(db, { limit: 0 }).puzzles).toHaveLength(1);
  });

  it("returns an empty list with a zero total for an empty motif", () => {
    expect(listPuzzles(db, { motif: "nope" })).toEqual({ total: 0, puzzles: [] });
  });

  it("reports the whole matching inventory as total", () => {
    expect(listPuzzles(db, { motif: "pin", limit: 3 }).total).toBe(28);
  });

  it("never selects the solution columns", () => {
    const first = listPuzzles(db).puzzles[0] as object;
    expect(Object.keys(first).sort()).toEqual(
      ["attempts", "difficulty", "explanation", "fen", "id", "motif", "solved"].sort(),
    );
  });
});

describe("getPuzzle and recordPuzzleAttempt", () => {
  it("reads the solution back as a list", () => {
    expect(getPuzzle(db, "forks:0")?.solution).toEqual(["b5c7", "e8f8", "a1c1"]);
    expect(getPuzzle(db, "missing:0")).toBeNull();
  });

  it("refuses an attempt for an unknown puzzle", () => {
    expect(() => attempt("missing:0", true)).toThrow(/FOREIGN KEY/);
  });
});
