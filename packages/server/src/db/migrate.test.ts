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

describe("013_training_tries", () => {
  it("adds training_tries and backfills first_try from solved on a database at 012", () => {
    const db = new BetterSqlite3(":memory:");
    const all = listMigrations(defaultMigrationsDir);
    const upTo012 = migrationsDir(
      Object.fromEntries(
        all
          .filter((name) => name < "013")
          .map((name) => [name, readFileSync(join(defaultMigrationsDir, name), "utf8")]),
      ),
    );
    runMigrations(db, upTo012);
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
       VALUES ('p1', 'test', 'fork', 'easy', 'x', '[]', '[]', 'why')`,
    ).run();
    const attempt = db.prepare(
      `INSERT INTO puzzle_attempts (puzzle_id, attempted_at, solved, answered_uci, failed_ply)
       VALUES ('p1', 'x', ?, '[]', NULL)`,
    );
    attempt.run(1);
    attempt.run(0);
    expect(runMigrations(db, defaultMigrationsDir)).toContain("013_training_tries.sql");
    expect(
      db.prepare("SELECT solved, first_try, tries, gave_up FROM puzzle_attempts ORDER BY id").all(),
    ).toEqual([
      { solved: 1, first_try: 1, tries: 0, gave_up: 0 },
      { solved: 0, first_try: 0, tries: 0, gave_up: 0 },
    ]);
    expect(count(db, "training_tries")).toBe(0);
  });
});

describe("015_coach_session_tabs", () => {
  it("tags every existing session and message as play and accepts only the three tabs", () => {
    const db = new BetterSqlite3(":memory:");
    const all = listMigrations(defaultMigrationsDir);
    const before015 = migrationsDir(
      Object.fromEntries(
        all
          .filter((name) => name < "015")
          .map((name) => [name, readFileSync(join(defaultMigrationsDir, name), "utf8")]),
      ),
    );
    runMigrations(db, before015);
    db.prepare(
      "INSERT INTO coach_sessions (id, started_at, prompt_version) VALUES (1, 'x', 'v')",
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (coach_session_id, seq, role, kind, content_json, created_at)
       VALUES (1, 1, 'user', 'text', '{}', 'x')`,
    ).run();
    expect(runMigrations(db, defaultMigrationsDir)).toContain("015_coach_session_tabs.sql");
    expect(db.prepare("SELECT tab FROM coach_sessions").all()).toEqual([{ tab: "play" }]);
    expect(db.prepare("SELECT tab FROM chat_messages").all()).toEqual([{ tab: "play" }]);
    const insert = (tab: string) =>
      db
        .prepare(
          "INSERT INTO coach_sessions (started_at, prompt_version, tab) VALUES ('x', 'v', ?)",
        )
        .run(tab);
    for (const tab of ["play", "games", "practice"]) expect(() => insert(tab)).not.toThrow();
    expect(() => insert("routine")).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          `INSERT INTO chat_messages (coach_session_id, seq, role, kind, content_json, created_at, tab)
           VALUES (1, 2, 'user', 'text', '{}', 'x', 'nope')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});

describe("014_training_hints", () => {
  it("adds a defaulted hinted column to training_items and puzzle_attempts at 013", () => {
    const db = new BetterSqlite3(":memory:");
    const all = listMigrations(defaultMigrationsDir);
    const upTo013 = migrationsDir(
      Object.fromEntries(
        all
          .filter((name) => name < "014")
          .map((name) => [name, readFileSync(join(defaultMigrationsDir, name), "utf8")]),
      ),
    );
    runMigrations(db, upTo013);
    db.prepare(
      `INSERT INTO training_items (kind, puzzle_id, served_at)
       VALUES ('puzzle', 'p1', '2026-11-06T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
       VALUES ('p1', 'test', 'fork', 'easy', 'x', '[]', '[]', 'why')`,
    ).run();
    db.prepare(
      `INSERT INTO puzzle_attempts (puzzle_id, attempted_at, solved, answered_uci, failed_ply)
       VALUES ('p1', 'x', 1, '[]', NULL)`,
    ).run();
    expect(runMigrations(db, defaultMigrationsDir)).toContain("014_training_hints.sql");
    expect(db.prepare("SELECT hinted FROM training_items").get()).toEqual({ hinted: 0 });
    expect(db.prepare("SELECT hinted FROM puzzle_attempts").get()).toEqual({ hinted: 0 });
  });
});

describe("016_training_run_outcomes", () => {
  it("adds outcomes_json to training_runs with an empty list for the runs already there", () => {
    const db = new BetterSqlite3(":memory:");
    const all = listMigrations(defaultMigrationsDir);
    const upTo015 = migrationsDir(
      Object.fromEntries(
        all
          .filter((name) => name < "016")
          .map((name) => [name, readFileSync(join(defaultMigrationsDir, name), "utf8")]),
      ),
    );
    runMigrations(db, upTo015);
    db.prepare(
      `INSERT INTO training_runs (mode, motif, color, size, items_json, position, solved, failed,
         current_json, started_at, updated_at)
       VALUES ('puzzles', 'fork', NULL, 2, '[]', 1, 1, 0, '{}', 'x', 'x')`,
    ).run();
    expect(runMigrations(db, defaultMigrationsDir)).toContain("016_training_run_outcomes.sql");
    expect(db.prepare("SELECT outcomes_json FROM training_runs").all()).toEqual([
      { outcomes_json: "[]" },
    ]);
  });
});

describe("030_puzzle_openings", () => {
  function databaseAt029(): BetterSqlite3.Database {
    const all = listMigrations(defaultMigrationsDir);
    const upTo029 = migrationsDir(
      Object.fromEntries(
        all
          .filter((name) => name < "030")
          .map((name) => [name, readFileSync(join(defaultMigrationsDir, name), "utf8")]),
      ),
    );
    const db = new BetterSqlite3(join(tmp, "at-029.db"));
    db.pragma("foreign_keys = ON");
    runMigrations(db, upTo029);
    return db;
  }

  function insertStored(
    db: BetterSqlite3.Database,
    id: string,
    rating: number | null,
    openingTags: string | null,
  ): void {
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san,
         explanation, difficulty_rating, opening_tags)
       VALUES (?, 'lichess-db', 'tactics', 'intermediate', 'x', '[]', '[]', 'why', ?, ?)`,
    ).run(id, rating, openingTags);
  }

  const rows = (db: BetterSqlite3.Database): unknown[] =>
    db
      .prepare("SELECT opening, rating, puzzle_id FROM puzzle_openings ORDER BY puzzle_id, opening")
      .all();

  it("files every rated puzzle under each of its tags, and a puzzle with none under nothing", () => {
    const db = databaseAt029();
    insertStored(db, "two", 1498, "Italian_Game Italian_Game_Classical_Variation");
    insertStored(db, "one", 1032, "French_Defense");
    insertStored(db, "none", 1433, "");
    insertStored(db, "null", 1819, null);
    insertStored(db, "unrated", null, "Caro-Kann_Defense Caro-Kann_Defense_Advance_Variation");
    insertStored(db, "spaced", 1200, " Scandinavian_Defense  Scandinavian_Defense_Main_Line ");
    const puzzlesBefore = db.prepare("SELECT * FROM puzzles ORDER BY id").all();

    expect(runMigrations(db, defaultMigrationsDir)).toContain("030_puzzle_openings.sql");

    expect(rows(db)).toEqual([
      { opening: "French_Defense", rating: 1032, puzzle_id: "one" },
      { opening: "Scandinavian_Defense", rating: 1200, puzzle_id: "spaced" },
      { opening: "Scandinavian_Defense_Main_Line", rating: 1200, puzzle_id: "spaced" },
      { opening: "Italian_Game", rating: 1498, puzzle_id: "two" },
      { opening: "Italian_Game_Classical_Variation", rating: 1498, puzzle_id: "two" },
    ]);
    expect(db.prepare("SELECT * FROM puzzles ORDER BY id").all()).toEqual(puzzlesBefore);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("writes one row for a tag a puzzle carries twice", () => {
    const db = databaseAt029();
    insertStored(db, "twice", 1500, "Italian_Game Italian_Game");
    runMigrations(db, defaultMigrationsDir);
    expect(rows(db)).toEqual([{ opening: "Italian_Game", rating: 1500, puzzle_id: "twice" }]);
    db.close();
  });

  it("creates the table empty on a new database, keyed by tag, rating and id", () => {
    const db = new BetterSqlite3(join(tmp, "new.db"));
    runMigrations(db, defaultMigrationsDir);
    expect(count(db, "puzzle_openings")).toBe(0);
    const insert = db.prepare(
      "INSERT INTO puzzle_openings (opening, rating, puzzle_id) VALUES ('Italian_Game', 1500, 'p')",
    );
    insert.run();
    expect(() => insert.run()).toThrow(/UNIQUE/);
    db.close();
  });
});

describe("026_training_run_left", () => {
  const REASONS = ["finished", "ended", "discarded", "replaced", "left"];

  // Opened as the server opens it, with foreign keys enforced: training_items.run_id points at
  // training_runs, so a rebuild of that table would fail or lose the rows pointing at it.
  function databaseAt025(): BetterSqlite3.Database {
    const all = listMigrations(defaultMigrationsDir);
    const upTo025 = migrationsDir(
      Object.fromEntries(
        all
          .filter((name) => name < "026")
          .map((name) => [name, readFileSync(join(defaultMigrationsDir, name), "utf8")]),
      ),
    );
    const db = new BetterSqlite3(join(tmp, "at-025.db"));
    db.pragma("foreign_keys = ON");
    runMigrations(db, upTo025);
    return db;
  }

  function emptyDatabase(): BetterSqlite3.Database {
    const db = new BetterSqlite3(join(tmp, "empty.db"));
    db.pragma("foreign_keys = ON");
    runMigrations(db, defaultMigrationsDir);
    return db;
  }

  // Explicit ids with gaps, so a copy that lets SQLite number the rows again is caught.
  function insertRun(db: BetterSqlite3.Database, id: number, reason: string | null): void {
    db.prepare(
      `INSERT INTO training_runs (id, mode, motif, color, size, items_json, position, solved, failed,
         current_json, started_at, updated_at, ended_at, ended_reason, outcomes_json)
       VALUES (?, 'puzzles', 'fork', NULL, 2, '[{"kind":"puzzle","id":"p1"}]', 1, 1, 0,
         '{"item_id":1}', '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z', ?, ?, '["solved"]')`,
    ).run(id, reason === null ? null : "2026-10-01T00:02:00.000Z", reason);
  }

  const runs = (db: BetterSqlite3.Database): unknown[] =>
    db.prepare("SELECT * FROM training_runs ORDER BY id").all();

  it("keeps every stored run with its id and reason, and every item still points at its run", () => {
    const db = databaseAt025();
    insertRun(db, 3, "finished");
    insertRun(db, 7, null);
    insertRun(db, 12, "ended");
    insertRun(db, 15, "discarded");
    insertRun(db, 20, "replaced");
    for (const [itemId, runId] of [
      [5, 3],
      [9, 7],
      [10, 20],
    ]) {
      db.prepare(
        `INSERT INTO training_items (id, kind, puzzle_id, served_at, run_id)
         VALUES (?, 'puzzle', 'p1', '2026-10-01T00:00:00.000Z', ?)`,
      ).run(itemId, runId);
    }
    const runsBefore = runs(db);
    const itemsBefore = db.prepare("SELECT * FROM training_items ORDER BY id").all();

    expect(runMigrations(db, defaultMigrationsDir)).toContain("026_training_run_left.sql");

    expect(runs(db)).toEqual(runsBefore);
    expect(db.prepare("SELECT * FROM training_items ORDER BY id").all()).toEqual(itemsBefore);
    expect(db.prepare("SELECT id, ended_reason FROM training_runs ORDER BY id").all()).toEqual([
      { id: 3, ended_reason: "finished" },
      { id: 7, ended_reason: null },
      { id: 12, ended_reason: "ended" },
      { id: 15, ended_reason: "discarded" },
      { id: 20, ended_reason: "replaced" },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it.each([
    ["a database at 025", databaseAt025],
    ["an empty database", emptyDatabase],
  ])("accepts left on %s, with every older reason, and refuses an unknown one", (_name, open) => {
    const db = open();
    runMigrations(db, defaultMigrationsDir);
    REASONS.forEach((reason, index) => {
      expect(() => insertRun(db, index + 1, reason)).not.toThrow();
    });
    expect(() => insertRun(db, 99, "abandoned")).toThrow(/CHECK/);
    expect(db.prepare("SELECT ended_reason FROM training_runs ORDER BY id").all()).toEqual(
      REASONS.map((ended_reason) => ({ ended_reason })),
    );
    db.close();
  });
});
