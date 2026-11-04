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
