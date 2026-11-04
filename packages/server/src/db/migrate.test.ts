import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
