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
  });

describe("listPuzzles", () => {
  it("orders by attempts, then id, so unseen puzzles come first", () => {
    attempt("forks:0", false);
    attempt("forks:0", true);
    attempt("forks:1", true);
    const all = listPuzzles(db, { motif: "fork", limit: 50 }).puzzles;
    expect(all.at(-1)?.id).toBe("forks:0");
    expect(all.at(-2)?.id).toBe("forks:1");
    expect(all.at(-1)).toMatchObject({ attempts: 2, solved: 1 });
  });

  it("sorts equal attempt counts by id", () => {
    const ids = listPuzzles(db, { motif: "pin", limit: 3 }).puzzles.map((p) => p.id);
    expect(ids).toEqual(["pins:0", "pins:1", "pins:10"]);
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
