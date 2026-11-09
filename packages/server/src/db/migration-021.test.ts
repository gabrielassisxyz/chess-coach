import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "./migrate.js";

let tmp: string;
let db: BetterSqlite3.Database;

// A database as it stands at 020, opened the way the server opens it: with foreign keys enforced,
// which is what makes a careless rebuild of training_runs fail or lose the rows pointing at it.
function databaseAt020(): BetterSqlite3.Database {
  const dir = join(tmp, "at-020");
  mkdirSync(dir);
  for (const name of readdirSync(defaultMigrationsDir)) {
    if (name < "021") cpSync(join(defaultMigrationsDir, name), join(dir, name));
  }
  const opened = new BetterSqlite3(join(tmp, "a.db"));
  opened.pragma("foreign_keys = ON");
  runMigrations(opened, dir);
  return opened;
}

// Explicit ids with gaps, so a copy that lets SQLite number the rows again is caught.
function insertRun(id: number, mode: string, ended: boolean): void {
  db.prepare(
    `INSERT INTO training_runs (id, mode, motif, color, size, items_json, position, solved, failed,
       current_json, started_at, updated_at, ended_at, ended_reason, outcomes_json)
     VALUES (?, ?, 'fork', 'white', 2, '[{"kind":"puzzle","id":"p1"}]', 1, 1, 0, '{"item_id":1}',
       '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z', ?, ?, '["solved"]')`,
  ).run(id, mode, ended ? "2026-10-01T00:02:00.000Z" : null, ended ? "finished" : null);
}

function insertItem(id: number, kind: string, runId: number | null): void {
  db.prepare(
    `INSERT INTO training_items (id, kind, card_id, puzzle_id, exposure_id, served_at, answered_at,
       answer_uci, correct, run_id, hinted)
     VALUES (?, ?, ?, ?, NULL, '2026-10-01T00:00:00.000Z', NULL, NULL, NULL, ?, 1)`,
  ).run(id, kind, kind === "card" ? 4 : null, kind === "puzzle" ? "p1" : null, runId);
  db.prepare(
    `INSERT INTO training_tries (item_id, seq, at_ms, ply, uci, correct)
     VALUES (?, 1, 900, 0, 'e2e4', 1)`,
  ).run(id);
}

const runs = (): unknown[] => db.prepare("SELECT * FROM training_runs ORDER BY id").all();
const items = (): unknown[] => db.prepare("SELECT * FROM training_items ORDER BY id").all();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-mig021-"));
  db = databaseAt020();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("021_repertoire_drill", () => {
  it("keeps every training run with its id, and every item still points at its run", () => {
    insertRun(3, "srs", true);
    insertRun(7, "puzzles", false);
    insertRun(12, "openings", true);
    insertItem(5, "card", 3);
    insertItem(9, "puzzle", 7);
    insertItem(10, "puzzle", 12);
    insertItem(11, "puzzle", null);
    const runsBefore = runs();
    const itemsBefore = items();

    expect(runMigrations(db, defaultMigrationsDir)).toContain("021_repertoire_drill.sql");

    expect(runs()).toEqual(runsBefore);
    expect(items()).toEqual(itemsBefore);
    const resolved = db
      .prepare(
        `SELECT i.id AS item_id, r.id AS run_id FROM training_items i
         JOIN training_runs r ON r.id = i.run_id ORDER BY i.id`,
      )
      .all();
    expect(resolved).toEqual([
      { item_id: 5, run_id: 3 },
      { item_id: 9, run_id: 7 },
      { item_id: 10, run_id: 12 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM training_tries").get()).toEqual({ n: 4 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("accepts a repertoire run and a repertoire item, and still refuses an unknown one", () => {
    runMigrations(db, defaultMigrationsDir);
    expect(() => insertRun(20, "repertoire", false)).not.toThrow();
    expect(() => insertItem(30, "repertoire", 20)).not.toThrow();
    expect(() => insertRun(21, "bogus", false)).toThrow(/CHECK/);
    expect(() => insertItem(31, "bogus", 20)).toThrow(/CHECK/);
  });

  it("keeps one card per position and move", () => {
    runMigrations(db, defaultMigrationsDir);
    const insertCard = (): unknown =>
      db
        .prepare(
          `INSERT INTO repertoire_cards (position_key, move_uci, introduced_at, next_review_at)
           VALUES ('k', 'e2e4', 't', 't')`,
        )
        .run();
    insertCard();
    expect(
      db
        .prepare("SELECT interval_hours, ease_factor, repetitions, reviews FROM repertoire_cards")
        .get(),
    ).toEqual({ interval_hours: 0, ease_factor: 2.5, repetitions: 0, reviews: 0 });
    expect(insertCard).toThrow(/UNIQUE/);
  });
});
