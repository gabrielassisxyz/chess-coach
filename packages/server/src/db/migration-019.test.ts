import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "./migrate.js";

let tmp: string;
let db: BetterSqlite3.Database;

// A database as it stands at 018, opened the way the server opens it: with foreign keys enforced,
// which is what makes a careless rebuild of games delete rows from the tables that point at it.
function databaseAt018(): BetterSqlite3.Database {
  const dir = join(tmp, "at-018");
  mkdirSync(dir);
  for (const name of readdirSync(defaultMigrationsDir)) {
    if (name < "019") cpSync(join(defaultMigrationsDir, name), join(dir, name));
  }
  const opened = new BetterSqlite3(join(tmp, "a.db"));
  opened.pragma("foreign_keys = ON");
  runMigrations(opened, dir);
  return opened;
}

const insertGame = (source: string, sourceId: string | null, finished = true): number =>
  Number(
    db
      .prepare(
        `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase,
           result, pgn, source, source_id, source_url, opponent, student_rating, opponent_rating,
           time_control, played_at, grading)
         VALUES ('2026-10-01T00:00:00.000Z', ?, 'black', 1350, 'start', ?, '0-1', '1. e4 e5',
           ?, ?, 'https://example.test/g', 'rival', 1400, 1500, '300+3', '2026-10-01T00:05:00.000Z', 'done')`,
      )
      .run(
        finished ? "2026-10-01T00:05:00.000Z" : null,
        finished ? "finished" : "player_turn",
        source,
        sourceId,
      ).lastInsertRowid,
  );

const snapshotOfGames = (): unknown[] => db.prepare("SELECT * FROM games ORDER BY id").all();
const indexesOfGames = (): unknown[] =>
  db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'games' ORDER BY name",
    )
    .all();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-mig019-"));
  db = databaseAt018();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("019_lichess_game_source", () => {
  it("keeps every game row and both indexes", () => {
    insertGame("chesscom", "cc-1");
    insertGame("pgn", "pgn:abc");
    insertGame("coach", null, false);
    const rows = snapshotOfGames();
    const indexes = indexesOfGames();
    expect(indexes).toHaveLength(2);

    expect(runMigrations(db, defaultMigrationsDir)).toContain("019_lichess_game_source.sql");

    expect(snapshotOfGames()).toEqual(rows);
    expect(indexesOfGames()).toEqual(indexes);
  });

  it("keeps the rows that point at games: moves, review cards and difficulty changes", () => {
    const gameId = insertGame("chesscom", "cc-1");
    const moveId = Number(
      db
        .prepare(
          `INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after, is_player)
           VALUES (?, 1, 'e4', 'e2e4', 'a', 'b', 1)`,
        )
        .run(gameId).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO srs_cards (source_kind, source_game_id, source_move_id, prompt_fen, student_color,
         expected_uci, created_at, next_review_at)
       VALUES ('game_move', ?, ?, 'f', 'white', 'e2e4', 't', 't')`,
    ).run(gameId, moveId);
    db.prepare(
      `INSERT INTO difficulty_changes (changed_at, from_elo, to_elo, reason, game_id)
       VALUES ('t', 1200, 1300, 'coach', ?)`,
    ).run(gameId);

    runMigrations(db, defaultMigrationsDir);

    expect(db.prepare("SELECT game_id FROM moves").all()).toEqual([{ game_id: gameId }]);
    expect(db.prepare("SELECT source_game_id, source_move_id FROM srs_cards").all()).toEqual([
      { source_game_id: gameId, source_move_id: moveId },
    ]);
    expect(db.prepare("SELECT game_id FROM difficulty_changes").all()).toEqual([
      { game_id: gameId },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("accepts lichess, still refuses an unknown source and a repeated source id", () => {
    runMigrations(db, defaultMigrationsDir);
    expect(() => insertGame("lichess", "AbCd1234")).not.toThrow();
    expect(() => insertGame("lichess", "AbCd1234")).toThrow(/UNIQUE/);
    expect(() => insertGame("bogus", "x")).toThrow(/CHECK/);
    for (const source of ["coach", "chesscom", "pgn"]) {
      expect(() => insertGame(source, `${source}-after`)).not.toThrow();
    }
  });

  it("keeps the coach default and the one-unfinished-game rule", () => {
    runMigrations(db, defaultMigrationsDir);
    const insertBare = (): unknown =>
      db
        .prepare(
          `INSERT INTO games (started_at, player_color, target_elo, initial_fen, phase)
           VALUES ('t', 'white', 1200, 'start', 'player_turn')`,
        )
        .run();
    insertBare();
    expect(db.prepare("SELECT source FROM games").get()).toEqual({ source: "coach" });
    expect(insertBare).toThrow(/UNIQUE/);
  });
});
