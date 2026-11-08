import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../db/open.js";
import { contentDir } from "../paths.js";
import { seedPuzzles } from "./seed.js";

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-seed-"));
  db = openDatabase(join(tmp, "data"));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const count = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM puzzles").get() as { n: number }).n;

function copyOfContent(): string {
  const root = join(tmp, "content");
  mkdirSync(root);
  cpSync(join(contentDir(), "puzzles"), join(root, "puzzles"), { recursive: true });
  return root;
}

const good = {
  fen: "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1",
  solution_moves: ["a1a8"],
  solution_san: ["Ra8#"],
  motif: "back_rank_mate",
  difficulty: "beginner",
  explanation: "mate",
  source: "test",
};

describe("seedPuzzles", () => {
  it("inserts every entry, then touches nothing on a second boot", () => {
    expect(seedPuzzles(db, contentDir())).toEqual({ inserted: 238, updated: 0, unchanged: 0 });
    expect(count()).toBe(238);
    expect(seedPuzzles(db, contentDir())).toEqual({ inserted: 0, updated: 0, unchanged: 238 });
  });

  it("gives rows the stable id <file stem>:<index> and the solution as JSON text", () => {
    seedPuzzles(db, contentDir());
    const row = db.prepare("SELECT * FROM puzzles WHERE id = 'forks:0'").get() as {
      solution_uci: string;
    };
    expect(JSON.parse(row.solution_uci)).toEqual(["b5c7", "e8f8", "a1c1"]);
  });

  it("updates exactly the edited row and keeps its attempts attached", () => {
    const root = copyOfContent();
    seedPuzzles(db, root);
    db.prepare(
      "INSERT INTO puzzle_attempts (puzzle_id, attempted_at, solved, answered_uci) VALUES ('forks:3', 'x', 1, '[]')",
    ).run();
    const file = join(root, "puzzles", "forks.json");
    const entries = JSON.parse(readFileSync(file, "utf8")) as { explanation: string }[];
    (entries[3] as { explanation: string }).explanation = "edited";
    writeFileSync(file, JSON.stringify(entries));

    expect(seedPuzzles(db, root)).toEqual({ inserted: 0, updated: 1, unchanged: 237 });
    const row = db.prepare("SELECT explanation FROM puzzles WHERE id = 'forks:3'").get();
    expect(row).toEqual({ explanation: "edited" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM puzzle_attempts").get()).toEqual({ n: 1 });
  });

  it("fails on an illegal solution line naming file and index, and writes nothing", () => {
    const root = join(tmp, "bad");
    mkdirSync(join(root, "puzzles"), { recursive: true });
    writeFileSync(join(root, "puzzles", "a-good.json"), JSON.stringify([good, good]));
    const illegal = { ...good, solution_moves: ["a1a8", "h7h5", "a8a8"] };
    writeFileSync(join(root, "puzzles", "b-bad.json"), JSON.stringify([good, illegal]));
    expect(() => seedPuzzles(db, root)).toThrow(/b-bad\.json:1/);
    expect(count()).toBe(0);
  });

  it("fails on an unparseable FEN and on a missing key", () => {
    const root = join(tmp, "bad2");
    mkdirSync(join(root, "puzzles"), { recursive: true });
    writeFileSync(join(root, "puzzles", "x.json"), JSON.stringify([{ ...good, fen: "nonsense" }]));
    expect(() => seedPuzzles(db, root)).toThrow(/x\.json:0/);
    const { explanation: _omitted, ...incomplete } = good;
    writeFileSync(join(root, "puzzles", "x.json"), JSON.stringify([good, incomplete]));
    expect(() => seedPuzzles(db, root)).toThrow(/x\.json:1.*explanation/);
    expect(count()).toBe(0);
  });

  it("seeds 238 rows well inside the time ceiling", () => {
    const started = performance.now();
    seedPuzzles(db, contentDir());
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("seedPuzzles and puzzle_themes", () => {
  const themeRows = (): { theme: string; rating: number; puzzle_id: string }[] =>
    db
      .prepare("SELECT theme, rating, puzzle_id FROM puzzle_themes ORDER BY puzzle_id, theme")
      .all() as { theme: string; rating: number; puzzle_id: string }[];

  function seedOne(entry: Record<string, unknown>): string {
    const root = join(tmp, "one");
    mkdirSync(join(root, "puzzles"), { recursive: true });
    writeFileSync(join(root, "puzzles", "one.json"), JSON.stringify([entry]));
    seedPuzzles(db, root);
    return root;
  }

  it("gives every rated fork, pin and skewer of the library one row", () => {
    seedPuzzles(db, contentDir());
    const expected = db
      .prepare(
        `SELECT motif AS theme, difficulty_rating AS rating, id AS puzzle_id FROM puzzles
         WHERE motif IN ('fork', 'pin', 'skewer') AND difficulty_rating IS NOT NULL
         ORDER BY puzzle_id, theme`,
      )
      .all();
    expect(expected.length).toBeGreaterThan(80);
    expect(themeRows()).toEqual(expected);
  });

  it.each(["fork", "pin", "skewer"])("indexes a rated %s", (motif) => {
    seedOne({ ...good, motif, difficulty_rating: 1200 });
    expect(themeRows()).toEqual([{ theme: motif, rating: 1200, puzzle_id: "one:0" }]);
  });

  it("indexes neither an unrated fork nor a rated puzzle of another motif", () => {
    seedOne({ ...good, motif: "fork" });
    expect(themeRows()).toEqual([]);
    seedOne({ ...good, motif: "endgame", difficulty_rating: 1200 });
    expect(themeRows()).toEqual([]);
  });

  it("writes nothing new on a second boot", () => {
    seedPuzzles(db, contentDir());
    const before = themeRows();
    seedPuzzles(db, contentDir());
    expect(themeRows()).toEqual(before);
  });

  it("fills the table on a database that already holds the puzzles", () => {
    seedPuzzles(db, contentDir());
    const before = themeRows();
    db.prepare("DELETE FROM puzzle_themes").run();
    expect(seedPuzzles(db, contentDir())).toEqual({ inserted: 0, updated: 0, unchanged: 238 });
    expect(themeRows()).toEqual(before);
  });

  it("keeps the row when an edit leaves the rating and the motif alone", () => {
    const entry = { ...good, motif: "fork", difficulty_rating: 1200 };
    seedOne(entry);
    seedOne({ ...entry, explanation: "edited" });
    expect(themeRows()).toEqual([{ theme: "fork", rating: 1200, puzzle_id: "one:0" }]);
  });

  it("moves the row when a puzzle's rating or motif changes, and drops it when it stops qualifying", () => {
    const entry = { ...good, motif: "fork", difficulty_rating: 1200 };
    seedOne(entry);
    seedOne({ ...entry, difficulty_rating: 1300 });
    expect(themeRows()).toEqual([{ theme: "fork", rating: 1300, puzzle_id: "one:0" }]);
    seedOne({ ...entry, motif: "pin", difficulty_rating: 1300 });
    expect(themeRows()).toEqual([{ theme: "pin", rating: 1300, puzzle_id: "one:0" }]);
    seedOne({ ...entry, motif: "pin", difficulty_rating: undefined });
    expect(themeRows()).toEqual([]);
  });
});
