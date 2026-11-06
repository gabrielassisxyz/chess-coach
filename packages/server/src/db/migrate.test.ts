import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, listMigrations, runMigrations } from "./migrate.js";
import { openDatabase } from "./open.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-db-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function migrationsDir(files: Record<string, string>): string {
  const dir = join(tmp, "migrations");
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

function count(db: BetterSqlite3.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("openDatabase", () => {
  it("creates the directory, applies the migration, and a reboot applies nothing", () => {
    const dir = join(tmp, "nested", "data");
    const first = openDatabase(dir);
    expect(first.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(first.pragma("foreign_keys", { simple: true })).toBe(1);
    first.close();

    const second = openDatabase(dir);
    expect(count(second, "schema_migrations")).toBe(listMigrations(defaultMigrationsDir).length);
    second.close();
  });
});

describe("runMigrations", () => {
  it("applies pending files in filename order, then none on the second run", () => {
    const dir = migrationsDir({
      "002_b.sql": "CREATE TABLE b (x INTEGER);",
      "001_a.sql":
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);",
    });
    const db = new BetterSqlite3(":memory:");
    expect(runMigrations(db, dir)).toEqual(["001_a.sql", "002_b.sql"]);
    expect(runMigrations(db, dir)).toEqual([]);
    expect(count(db, "schema_migrations")).toBe(2);
  });

  it("applies a file numbered below one already applied, so a gap can be filled later", () => {
    const create =
      "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);";
    const db = new BetterSqlite3(":memory:");
    const first = migrationsDir({
      "001_a.sql": create,
      "003_c.sql": "CREATE TABLE c (x INTEGER);",
    });
    expect(runMigrations(db, first)).toEqual(["001_a.sql", "003_c.sql"]);
    const later = migrationsDir({
      "001_a.sql": create,
      "002_b.sql": "CREATE TABLE b (x INTEGER);",
      "003_c.sql": "CREATE TABLE c (x INTEGER);",
    });
    expect(runMigrations(db, later)).toEqual(["002_b.sql"]);
  });

  it("rolls a failing migration back and records nothing for it", () => {
    const dir = migrationsDir({
      "001_a.sql":
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);",
      "002_bad.sql": "CREATE TABLE half (x INTEGER); SELECT * FROM missing_table;",
    });
    const db = new BetterSqlite3(":memory:");
    expect(() => runMigrations(db, dir)).toThrow();
    expect(count(db, "schema_migrations")).toBe(1);
    const half = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half'").get();
    expect(half).toBeUndefined();
  });

  it("rejects a bad filename and names it", () => {
    const dir = migrationsDir({ "1_oops.sql": "SELECT 1;" });
    expect(() => runMigrations(new BetterSqlite3(":memory:"), dir)).toThrow("1_oops.sql");
  });

  it("rejects a duplicate number and names the offending file", () => {
    const dir = migrationsDir({ "001_a.sql": "SELECT 1;", "001_b.sql": "SELECT 1;" });
    expect(() => runMigrations(new BetterSqlite3(":memory:"), dir)).toThrow("001_b.sql");
  });
});

describe("011_move_times", () => {
  it("adds moves.created_at to a database at 010 and leaves earlier rows null", () => {
    const db = new BetterSqlite3(":memory:");
    const all = listMigrations(defaultMigrationsDir);
    const upTo010 = migrationsDir(
      Object.fromEntries(
        all
          .filter((name) => name < "011")
          .map((name) => [name, readFileSync(join(defaultMigrationsDir, name), "utf8")]),
      ),
    );
    runMigrations(db, upTo010);
    db.prepare(
      `INSERT INTO games (started_at, player_color, target_elo, initial_fen, phase)
       VALUES ('2026-11-04T00:00:00Z', 'white', 1200, 'x', 'player_turn')`,
    ).run();
    db.prepare(
      `INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after, is_player)
       VALUES (1, 1, 'e4', 'e2e4', 'a', 'b', 1)`,
    ).run();
    expect(runMigrations(db, defaultMigrationsDir)).toContain("011_move_times.sql");
    expect(db.prepare("SELECT created_at FROM moves").get()).toEqual({ created_at: null });
  });
});

describe("012_training_runs", () => {
  it("adds training_runs and a null run_id to a database at 011", () => {
    const db = new BetterSqlite3(":memory:");
    const all = listMigrations(defaultMigrationsDir);
    const upTo011 = migrationsDir(
      Object.fromEntries(
        all
          .filter((name) => name < "012")
          .map((name) => [name, readFileSync(join(defaultMigrationsDir, name), "utf8")]),
      ),
    );
    runMigrations(db, upTo011);
    db.prepare(
      `INSERT INTO training_items (kind, puzzle_id, served_at)
       VALUES ('puzzle', 'p1', '2026-11-06T00:00:00Z')`,
    ).run();
    expect(runMigrations(db, defaultMigrationsDir)).toContain("012_training_runs.sql");
    expect(db.prepare("SELECT run_id FROM training_items").get()).toEqual({ run_id: null });
    expect(count(db, "training_runs")).toBe(0);
    const insert = (reason: string) =>
      db
        .prepare(
          `INSERT INTO training_runs (mode, size, items_json, position, solved, failed,
             current_json, started_at, updated_at, ended_reason)
           VALUES ('puzzles', 1, '[]', 0, 0, 0, '{}', 'x', 'x', ?)`,
        )
        .run(reason);
    expect(() => insert("replaced")).not.toThrow();
    expect(() => insert("abandoned")).toThrow();
  });
});
