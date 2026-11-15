import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "./migrate.js";

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
});
afterEach(() => {
  db.close();
});

const COLUMNS: Array<[name: string, type: string]> = [
  ["id", "TEXT"],
  ["fen", "TEXT"],
  ["color", "TEXT"],
  ["phase", "TEXT"],
  ["from_mistake", "INTEGER"],
  ["from_repeat", "INTEGER"],
  ["from_departure", "INTEGER"],
  ["accepted_uci", "TEXT"],
  ["listed", "INTEGER"],
  ["reached_games", "INTEGER"],
  ["best_games", "INTEGER"],
  ["last_reached_at", "TEXT"],
  ["game_id", "INTEGER"],
  ["ply", "INTEGER"],
  ["first_found_at", "TEXT"],
  // Added by 031_found_notes.sql, after the table was created.
  ["note", "TEXT"],
];

// The key reports no NOT NULL (see below), and the note is the one column a row may leave empty.
const MAY_BE_NULL = new Set(["id", "note"]);

const ROW = {
  id: "own:0123456789abcdef",
  fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
  color: "white",
  phase: "opening",
  from_mistake: 1,
  from_repeat: 0,
  from_departure: 1,
  accepted_uci: '["g1f3","b1c3"]',
  listed: 1,
  reached_games: 2,
  best_games: 0,
  last_reached_at: "2026-11-15T12:00:00.000Z",
  game_id: 33,
  ply: 3,
  first_found_at: "2026-11-15T12:30:00.000Z",
};

function insert(row: Record<string, unknown>): void {
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO found_positions (${names.join(", ")}) VALUES (${names.map((name) => `@${name}`).join(", ")})`,
  ).run(row);
}

describe("028_found_positions", () => {
  it("applies on an empty database with the migrations before it", () => {
    expect(runMigrations(db, defaultMigrationsDir)).toContain("028_found_positions.sql");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  // The key reads `id TEXT PRIMARY KEY`, as in puzzles, so SQLite reports no NOT NULL on it.
  it("creates every column as text or integer, not null but the note, keyed by the own: id", () => {
    runMigrations(db, defaultMigrationsDir);
    const columns = db.pragma("table_info(found_positions)") as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    expect(columns.map(({ name, type, notnull, pk }) => [name, type, notnull, pk])).toEqual(
      COLUMNS.map(([name, type]) => [
        name,
        type,
        MAY_BE_NULL.has(name) ? 0 : 1,
        name === "id" ? 1 : 0,
      ]),
    );
    expect(db.pragma("foreign_key_list(found_positions)")).toEqual([]);
  });

  it("stores a row, and refuses a second one for the same position", () => {
    runMigrations(db, defaultMigrationsDir);
    insert(ROW);
    expect(db.prepare("SELECT * FROM found_positions").all()).toEqual([{ ...ROW, note: null }]);
    expect(() => insert(ROW)).toThrow(/UNIQUE/);
  });

  it.each([
    ["color", "red"],
    ["phase", "late"],
    ["from_mistake", 2],
    ["from_repeat", -1],
    ["from_departure", 2],
    ["listed", 3],
  ])("refuses %s = %s", (column, value) => {
    runMigrations(db, defaultMigrationsDir);
    expect(() => insert({ ...ROW, [column]: value })).toThrow(/CHECK/);
  });

  it("names a game that no longer exists without a foreign key error", () => {
    runMigrations(db, defaultMigrationsDir);
    insert({ ...ROW, game_id: 9999 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
