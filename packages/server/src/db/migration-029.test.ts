import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "./migrate.js";

let tmp: string;
let db: BetterSqlite3.Database;

// A database as it stands at 028, opened the way the server opens it: with foreign keys enforced,
// which is what makes a careless rebuild of training_runs fail or lose the rows pointing at it.
function databaseAt028(): BetterSqlite3.Database {
  const dir = join(tmp, "at-028");
  mkdirSync(dir);
  for (const name of readdirSync(defaultMigrationsDir)) {
    if (name < "029") cpSync(join(defaultMigrationsDir, name), join(dir, name));
  }
  const opened = new BetterSqlite3(join(tmp, "a.db"));
  opened.pragma("foreign_keys = ON");
  runMigrations(opened, dir);
  return opened;
}

// Explicit ids with gaps, so a copy that lets SQLite number the rows again is caught.
function insertRun(id: number, mode: string, reason: string | null): void {
  db.prepare(
    `INSERT INTO training_runs (id, mode, motif, color, size, items_json, position, solved, failed,
       current_json, started_at, updated_at, ended_at, ended_reason, outcomes_json)
     VALUES (?, ?, NULL, 'white', 2, '[{"kind":"puzzle","id":"p1"}]', 1, 1, 0, '{"item_id":1}',
       '2026-11-01T00:00:00.000Z', '2026-11-01T00:01:00.000Z', ?, ?, '["solved"]')`,
  ).run(id, mode, reason === null ? null : "2026-11-01T00:02:00.000Z", reason);
}

function insertItem(id: number, runId: number): void {
  db.prepare(
    `INSERT INTO training_items (id, kind, puzzle_id, served_at, run_id)
     VALUES (?, 'puzzle', 'p1', '2026-11-01T00:00:00.000Z', ?)`,
  ).run(id, runId);
}

function insertPosition(id: string): void {
  db.prepare(
    `INSERT INTO found_positions (id, fen, color, phase, from_mistake, from_repeat, from_departure,
       accepted_uci, listed, reached_games, best_games, last_reached_at, game_id, ply, first_found_at)
     VALUES (?, 'fen', 'white', 'opening', 1, 0, 0, '["e2e4"]', 1, 1, 0, 't', 1, 2, 't')`,
  ).run(id);
}

function insertCard(positionId: string): void {
  db.prepare(
    "INSERT INTO found_cards (position_id, next_review_at, introduced_at) VALUES (?, 't', 't')",
  ).run(positionId);
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const columns = (table: string): ColumnInfo[] =>
  (db.pragma(`table_info(${table})`) as ColumnInfo[]).map(
    ({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }),
  );

const runs = (): unknown[] => db.prepare("SELECT * FROM training_runs ORDER BY id").all();
const items = (): unknown[] => db.prepare("SELECT * FROM training_items ORDER BY id").all();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-mig029-"));
  db = databaseAt028();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("029_found_cards", () => {
  it("applies on an empty database with the migrations before it", () => {
    const empty = new BetterSqlite3(":memory:");
    empty.pragma("foreign_keys = ON");
    expect(runMigrations(empty, defaultMigrationsDir)).toContain("029_found_cards.sql");
    expect(empty.pragma("foreign_key_check")).toEqual([]);
    empty.close();
  });

  it("gives found_cards the schedule columns of repertoire_cards, keyed by the position's id", () => {
    runMigrations(db, defaultMigrationsDir);
    const schedule = [
      "interval_hours",
      "next_review_at",
      "introduced_at",
      "reviews",
      "last_reviewed_at",
      "fsrs_state",
      "stability",
      "difficulty",
      "learning_step",
      "lapses",
    ];
    const repertoire = new Map(columns("repertoire_cards").map((column) => [column.name, column]));
    expect(columns("found_cards")).toEqual([
      { name: "position_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      ...schedule.map((name) => repertoire.get(name)).map((column) => ({ ...column, pk: 0 })),
    ]);
    expect(db.pragma("foreign_key_list(found_cards)")).toMatchObject([
      { table: "found_positions", from: "position_id", to: "id", on_delete: "CASCADE" },
    ]);
  });

  it("keeps every training run with its id, mode and reason, and every item still points at its run", () => {
    insertRun(3, "srs", "finished");
    insertRun(7, "puzzles", null);
    insertRun(12, "openings", "left");
    insertRun(15, "repertoire", "replaced");
    insertItem(5, 3);
    insertItem(9, 7);
    insertItem(10, 15);
    const runsBefore = runs();
    const itemsBefore = items();

    expect(runMigrations(db, defaultMigrationsDir)).toContain("029_found_cards.sql");

    expect(runs()).toEqual(runsBefore);
    expect(items()).toEqual(itemsBefore);
    expect(db.prepare("SELECT id, mode FROM training_runs ORDER BY id").all()).toEqual([
      { id: 3, mode: "srs" },
      { id: 7, mode: "puzzles" },
      { id: 12, mode: "openings" },
      { id: 15, mode: "repertoire" },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("accepts a found run, and still refuses an unknown mode", () => {
    runMigrations(db, defaultMigrationsDir);
    expect(() => insertRun(20, "found", null)).not.toThrow();
    expect(() => insertItem(30, 20)).not.toThrow();
    expect(() => insertRun(21, "bogus", null)).toThrow(/CHECK/);
  });

  it("keeps one card per position, and none for a position that is not stored", () => {
    runMigrations(db, defaultMigrationsDir);
    insertPosition("own:a");
    insertCard("own:a");
    expect(
      db
        .prepare(
          "SELECT interval_hours, fsrs_state, learning_step, lapses, reviews FROM found_cards",
        )
        .get(),
    ).toEqual({ interval_hours: 0, fsrs_state: 0, learning_step: 0, lapses: 0, reviews: 0 });
    expect(() => insertCard("own:a")).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => insertCard("own:missing")).toThrow(/FOREIGN KEY/);
  });
});
