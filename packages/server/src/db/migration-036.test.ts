import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "./migrate.js";

let tmp: string;
let db: BetterSqlite3.Database;

function databaseAt035(): BetterSqlite3.Database {
  const dir = join(tmp, "at-035");
  mkdirSync(dir);
  for (const name of readdirSync(defaultMigrationsDir)) {
    if (name < "036") cpSync(join(defaultMigrationsDir, name), join(dir, name));
  }
  const opened = new BetterSqlite3(join(tmp, "a.db"));
  opened.pragma("foreign_keys = ON");
  runMigrations(opened, dir);
  return opened;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-mig036-"));
  db = databaseAt035();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("036_practice_games", () => {
  it("adds games.practice defaulting to 0 and keeps every game stored before it at 0", () => {
    const insert = db.prepare(
      `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase,
         result, source, source_id)
       VALUES ('2026-11-01T00:00:00.000Z', '2026-11-01T00:05:00.000Z', 'white', 1200, 'start',
         'finished', '1-0', ?, ?)`,
    );
    insert.run("coach", null);
    insert.run("chesscom", "cc-1");
    insert.run("lichess", "li-1");
    insert.run("pgn", "pgn-1");
    const columnsAt035 = `id, coach_session_id, started_at, finished_at, player_color, target_elo,
      initial_fen, phase, result, termination, pgn, source, source_id, source_url, opponent,
      student_rating, opponent_rating, time_control, played_at, grading`;
    const before = db.prepare(`SELECT ${columnsAt035} FROM games ORDER BY id`).all();

    expect(runMigrations(db, defaultMigrationsDir)).toContain("036_practice_games.sql");

    expect(db.prepare(`SELECT ${columnsAt035}, practice FROM games ORDER BY id`).all()).toEqual(
      before.map((row) => ({ ...(row as object), practice: 0 })),
    );
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("defaults new rows to 0, accepts 1 and refuses any other value or null", () => {
    runMigrations(db, defaultMigrationsDir);
    db.prepare(
      `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase,
         result, source, source_id)
       VALUES ('t', 't', 'white', 1200, 'start', 'finished', '1-0', 'pgn', 'default-0')`,
    ).run();
    db.prepare(
      `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase,
         result, source, source_id, practice)
       VALUES ('t', 't', 'white', 1200, 'start', 'finished', '0-1', 'pgn', 'marked-1', 1)`,
    ).run();
    expect(db.prepare("SELECT source_id, practice FROM games ORDER BY id").all()).toEqual([
      { source_id: "default-0", practice: 0 },
      { source_id: "marked-1", practice: 1 },
    ]);
    expect(() =>
      db
        .prepare(
          `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase,
             result, source, source_id, practice)
           VALUES ('t', 't', 'white', 1200, 'start', 'finished', '0-1', 'pgn', 'bad-2', 2)`,
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase,
             result, source, source_id, practice)
           VALUES ('t', 't', 'white', 1200, 'start', 'finished', '0-1', 'pgn', 'bad-null', NULL)`,
        )
        .run(),
    ).toThrow(/NOT NULL/);
  });
});
