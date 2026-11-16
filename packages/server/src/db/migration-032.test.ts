import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "./migrate.js";

let tmp: string;
let db: BetterSqlite3.Database;

// A database as it stands at 031, opened the way the server opens it.
function databaseAt031(): BetterSqlite3.Database {
  const dir = join(tmp, "at-031");
  mkdirSync(dir);
  for (const name of readdirSync(defaultMigrationsDir)) {
    if (name < "032") cpSync(join(defaultMigrationsDir, name), join(dir, name));
  }
  const opened = new BetterSqlite3(join(tmp, "a.db"));
  opened.pragma("foreign_keys = ON");
  runMigrations(opened, dir);
  return opened;
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const columns = (): ColumnInfo[] =>
  (db.pragma("table_info(eval_queue)") as ColumnInfo[]).map(
    ({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }),
  );

const insert = (key: string, fen = "x"): void => {
  db.prepare("INSERT INTO eval_queue (key, fen, enqueued_at) VALUES (?, ?, 't')").run(
    Buffer.from(key),
    fen,
  );
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-mig032-"));
  db = databaseAt031();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("032_eval_queue", () => {
  it("creates eval_queue with a key, a fen and the time it was queued", () => {
    expect(db.pragma("table_info(eval_queue)")).toEqual([]);

    expect(runMigrations(db, defaultMigrationsDir)).toContain("032_eval_queue.sql");

    expect(columns()).toEqual([
      { name: "key", type: "BLOB", notnull: 1, dflt_value: null, pk: 0 },
      { name: "fen", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "enqueued_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    ]);
  });

  it("holds a position once: the key is unique", () => {
    runMigrations(db, defaultMigrationsDir);
    insert("a");
    insert("b");

    expect(() => insert("a", "another fen")).toThrow(/UNIQUE/);

    expect(db.prepare("SELECT COUNT(*) AS n FROM eval_queue").get()).toEqual({ n: 2 });
  });

  it("leaves what the earlier migrations hold untouched", () => {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('kept', 'yes', 't')").run();
    const settingsBefore = db.prepare("SELECT * FROM settings ORDER BY key").all();

    runMigrations(db, defaultMigrationsDir);

    expect(db.prepare("SELECT * FROM settings ORDER BY key").all()).toEqual(settingsBefore);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
