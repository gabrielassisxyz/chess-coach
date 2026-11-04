import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "./migrate.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-mig008-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("008_game_sources", () => {
  it("gives games that already exist the coach source and finished grading", () => {
    const early = join(tmp, "early");
    for (const name of ["001_coach_sessions.sql", "002_games.sql"]) {
      cpSync(join(defaultMigrationsDir, name), join(early, name));
    }
    const db = new BetterSqlite3(join(tmp, "a.db"));
    runMigrations(db, early);
    db.prepare(
      `INSERT INTO games (started_at, player_color, target_elo, initial_fen, phase)
       VALUES ('2026-01-01T00:00:00.000Z', 'white', 1200, 'start', 'player_turn')`,
    ).run();
    expect(runMigrations(db, defaultMigrationsDir)).toContain("008_game_sources.sql");
    expect(db.prepare("SELECT source, grading, source_id FROM games").get()).toEqual({
      source: "coach",
      grading: "done",
      source_id: null,
    });
  });

  it("applies with a gap in the numbering and keeps source ids unique", () => {
    const dir = join(tmp, "gap");
    for (const name of ["001_coach_sessions.sql", "002_games.sql", "008_game_sources.sql"]) {
      cpSync(join(defaultMigrationsDir, name), join(dir, name));
    }
    const db = new BetterSqlite3(join(tmp, "b.db"));
    expect(runMigrations(db, dir)).toHaveLength(3);
    const insert = db.prepare(
      `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase, source, source_id)
       VALUES ('t', 't', 'white', 1200, 'start', 'finished', 'pgn', ?)`,
    );
    insert.run("same");
    expect(() => insert.run("same")).toThrow(/UNIQUE/);
    expect(() => insert.run(null)).not.toThrow();
    expect(() => insert.run(null)).not.toThrow();
  });
});
