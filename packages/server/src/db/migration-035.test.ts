import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "./migrate.js";

let tmp: string;
let db: BetterSqlite3.Database;

// A database as it stands at 034, opened the way the server opens it: with foreign keys enforced,
// which is what makes dropping repertoire_positions clear the two ids a game review holds.
function databaseAt034(): BetterSqlite3.Database {
  const dir = join(tmp, "at-034");
  mkdirSync(dir);
  for (const name of readdirSync(defaultMigrationsDir)) {
    if (name < "035") cpSync(join(defaultMigrationsDir, name), join(dir, name));
  }
  const opened = new BetterSqlite3(join(tmp, "a.db"));
  opened.pragma("foreign_keys = ON");
  runMigrations(opened, dir);
  return opened;
}

const SOURCES = ["setup", "explorer", "engine", "mainline", "game"];

// Explicit ids with gaps, so a copy that lets SQLite number the rows again is caught.
const POSITIONS_AT_034: Array<{ id: number; unit: number; kind: "own" | "reply" }> = [
  { id: 7, unit: 4, kind: "own" },
  { id: 11, unit: 4, kind: "reply" },
  { id: 12, unit: 4, kind: "own" },
  { id: 20, unit: 9, kind: "own" },
  { id: 21, unit: 9, kind: "reply" },
  { id: 25, unit: 9, kind: "own" },
];

function storeUnitsAt034(): void {
  const insert = db.prepare(
    `INSERT INTO repertoires (id, side, group_name, variation_name, points_effectiveness,
       points_soundness, points_learnability, branch_san)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(4, "white", "Italian Game", "Classical Variation (4.c3)", 3, 2, 1, '["e4","e5"]');
  insert.run(9, "black", "Caro-Kann Defense", "Main Line", null, null, null, null);
}

// Every column of every row holds a value no other row or column shares, a reply's figures
// included, so a copy that swaps two columns or leaves one out cannot pass.
function storePositionsAt034(): void {
  const insert = db.prepare(
    `INSERT INTO repertoire_positions (id, repertoire_id, kind, position_key, ply, line_san,
       move_uci, move_san, share, reach, opening_name, idea, source, cp_loss, eval_cp, wins, draws,
       losses, eval_depth)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  POSITIONS_AT_034.forEach(({ id, unit, kind }, index) => {
    insert.run(
      id,
      unit,
      kind,
      `position ${id}`,
      id + 100,
      JSON.stringify([`line${id}`]),
      `uci${id}`,
      `san${id}`,
      id / 100,
      id / 50,
      `Opening ${id}`,
      `Idea ${id}.`,
      SOURCES[index % SOURCES.length],
      id * 3,
      id * 7 - 40,
      id + 1,
      id + 2,
      id + 3,
      id + 10,
    );
  });
}

// Three finished games, each reviewed against a unit: the first names a reply and an answer, the
// second names none and the third names only a reply.
function storeReviewsAt034(): void {
  const insertGame = db.prepare(
    `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase)
     VALUES ('2026-10-01T00:00:00.000Z', '2026-10-01T00:05:00.000Z', 'white', 1200, 'start',
       'finished')`,
  );
  const insertReview = db.prepare(
    `INSERT INTO repertoire_game_reviews (game_id, repertoire_id, reviewed_at, outcome,
       followed_plies, passed_moves, left_ply, left_position_key, left_san, left_uci, expected_san,
       expected_uci, opening_name, added_reply_id, added_answer_id)
     VALUES (?, ?, '2026-10-02T00:00:00.000Z', ?, 9, 3, 10, 'left key', 'Nf6', 'g8f6', 'd3',
       'd2d3', 'Italian Game', ?, ?)`,
  );
  const [first, second, third] = [1, 2, 3].map((): number =>
    Number(insertGame.run().lastInsertRowid),
  );
  insertReview.run(first, 4, "reply_added", 11, 12);
  insertReview.run(second, 4, "in_book", null, null);
  insertReview.run(third, 9, "reply_added", 21, null);
}

function storeDrillHistoryAt034(): void {
  const attempt = db.prepare(
    `INSERT INTO repertoire_first_attempts (id, position_key, move_uci, repertoire_id, attempted_at,
       correct)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  attempt.run(3, "position 7", "uci7", 4, "2026-10-03T00:00:00.000Z", 1);
  attempt.run(8, "position 20", "uci20", 9, "2026-10-04T00:00:00.000Z", 0);
  db.prepare(
    `INSERT INTO repertoire_cards (id, position_key, move_uci, introduced_at, next_review_at,
       interval_hours, reviews, last_reviewed_at, fsrs_state, stability, difficulty, learning_step,
       lapses)
     VALUES (5, 'position 7', 'uci7', '2026-10-03T00:00:00.000Z', '2026-10-06T00:00:00.000Z', 72,
       3, '2026-10-03T00:00:00.000Z', 2, 11.5, 4.25, 0, 1)`,
  ).run();
}

const rowsOf = (table: string): unknown[] => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();

const indexesOfPositions = (): unknown[] =>
  db
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'repertoire_positions' ORDER BY name`,
    )
    .all();

function storeEverythingAt034(): void {
  storeUnitsAt034();
  storePositionsAt034();
  storeReviewsAt034();
  storeDrillHistoryAt034();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-mig035-"));
  db = databaseAt034();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("035_repertoire_origin: the rebuild of repertoire_positions", () => {
  it("keeps every row equal column by column, its id included", () => {
    storeEverythingAt034();
    const before = rowsOf("repertoire_positions");
    expect(before).toHaveLength(POSITIONS_AT_034.length);

    expect(runMigrations(db, defaultMigrationsDir)).toContain("035_repertoire_origin.sql");

    expect(rowsOf("repertoire_positions")).toEqual(before);
    expect(db.prepare("SELECT id FROM repertoire_positions ORDER BY id").all()).toEqual(
      POSITIONS_AT_034.map(({ id }) => ({ id })),
    );
  });

  it("gives the two ids a game review holds back to the rows they named", () => {
    storeEverythingAt034();
    const before = rowsOf("repertoire_game_reviews");

    runMigrations(db, defaultMigrationsDir);

    expect(rowsOf("repertoire_game_reviews")).toEqual(before);
    expect(
      db
        .prepare(
          "SELECT game_id, added_reply_id, added_answer_id FROM repertoire_game_reviews ORDER BY game_id",
        )
        .all(),
    ).toEqual([
      { game_id: 1, added_reply_id: 11, added_answer_id: 12 },
      { game_id: 2, added_reply_id: null, added_answer_id: null },
      { game_id: 3, added_reply_id: 21, added_answer_id: null },
    ]);
  });

  it("leaves the units' other columns, the first attempts and the cards as they were", () => {
    storeEverythingAt034();
    const unitsBefore = rowsOf("repertoires");
    const attemptsBefore = rowsOf("repertoire_first_attempts");
    const cardsBefore = rowsOf("repertoire_cards");
    expect(attemptsBefore).toHaveLength(2);
    expect(cardsBefore).toHaveLength(1);

    runMigrations(db, defaultMigrationsDir);

    expect(rowsOf("repertoires")).toEqual(
      unitsBefore.map((unit) => ({ ...(unit as object), origin: "generated" })),
    );
    expect(rowsOf("repertoire_first_attempts")).toEqual(attemptsBefore);
    expect(rowsOf("repertoire_cards")).toEqual(cardsBefore);
  });

  it("leaves no foreign key broken", () => {
    storeEverythingAt034();
    runMigrations(db, defaultMigrationsDir);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps the two indexes it had, under the same names", () => {
    const before = indexesOfPositions();
    expect(before.map((index) => (index as { name: string }).name)).toEqual([
      "repertoire_positions_one_own_move",
      "repertoire_positions_one_reply",
    ]);

    runMigrations(db, defaultMigrationsDir);

    expect(indexesOfPositions()).toEqual(before);
  });

  it("keeps the review's reference to the table, so a deleted row still empties its id", () => {
    storeEverythingAt034();
    runMigrations(db, defaultMigrationsDir);

    db.prepare("DELETE FROM repertoire_positions WHERE id = 11").run();

    expect(
      db
        .prepare(
          "SELECT added_reply_id, added_answer_id FROM repertoire_game_reviews WHERE game_id = 1",
        )
        .get(),
    ).toEqual({ added_reply_id: null, added_answer_id: 12 });
  });

  it("keeps the cascade from a unit to its rows", () => {
    storeEverythingAt034();
    runMigrations(db, defaultMigrationsDir);

    db.prepare("DELETE FROM repertoires WHERE id = 4").run();

    expect(db.prepare("SELECT DISTINCT repertoire_id FROM repertoire_positions").all()).toEqual([
      { repertoire_id: 9 },
    ]);
  });
});

const insertUnit = (id: number, origin?: string): unknown =>
  origin === undefined
    ? db
        .prepare(
          "INSERT INTO repertoires (id, side, group_name, variation_name) VALUES (?, 'white', 'London System', ?)",
        )
        .run(id, `Variation ${id}`)
    : db
        .prepare(
          "INSERT INTO repertoires (id, side, group_name, variation_name, origin) VALUES (?, 'white', 'London System', ?, ?)",
        )
        .run(id, `Variation ${id}`, origin);

describe("035_repertoire_origin: origin", () => {
  it("reads generated on every unit stored before it", () => {
    storeUnitsAt034();

    runMigrations(db, defaultMigrationsDir);

    expect(db.prepare("SELECT id, origin FROM repertoires ORDER BY id").all()).toEqual([
      { id: 4, origin: "generated" },
      { id: 9, origin: "generated" },
    ]);
  });

  it("defaults a unit stored later to generated, and accepts pgn", () => {
    runMigrations(db, defaultMigrationsDir);

    insertUnit(1);
    insertUnit(2, "pgn");

    expect(db.prepare("SELECT id, origin FROM repertoires ORDER BY id").all()).toEqual([
      { id: 1, origin: "generated" },
      { id: 2, origin: "pgn" },
    ]);
  });

  it("refuses any other origin, and none at all", () => {
    runMigrations(db, defaultMigrationsDir);
    expect(() => insertUnit(1, "imported")).toThrow(/CHECK/);
    expect(() => insertUnit(1, "")).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO repertoires (id, side, group_name, variation_name, origin) VALUES (3, 'white', 'g', 'v', NULL)",
        )
        .run(),
    ).toThrow(/NOT NULL/);
  });
});

function insertPosition(
  unit: number,
  kind: string,
  position: string,
  uci: string,
  figures: { cpLoss: number | null; evalCp: number | null } = { cpLoss: null, evalCp: null },
): unknown {
  return db
    .prepare(
      `INSERT INTO repertoire_positions (repertoire_id, kind, position_key, ply, line_san,
         move_uci, move_san, reach, source, cp_loss, eval_cp)
       VALUES (?, ?, ?, 1, '[]', ?, 'x', 1, 'pgn', ?, ?)`,
    )
    .run(unit, kind, position, uci, figures.cpLoss, figures.evalCp);
}

describe("035_repertoire_origin: what the table still refuses and now accepts", () => {
  beforeEach(() => {
    runMigrations(db, defaultMigrationsDir);
    insertUnit(1, "pgn");
    insertUnit(2);
  });

  it("stores an own move with no centipawn loss and no evaluation", () => {
    insertPosition(1, "own", "start", "d2d4");

    expect(db.prepare("SELECT kind, cp_loss, eval_cp FROM repertoire_positions").all()).toEqual([
      { kind: "own", cp_loss: null, eval_cp: null },
    ]);
  });

  it("stores an own move with figures, and one with only one of them", () => {
    insertPosition(1, "own", "a", "d2d4", { cpLoss: 12, evalCp: -30 });
    insertPosition(1, "own", "b", "g1f3", { cpLoss: null, evalCp: 25 });
    insertPosition(1, "own", "c", "c1f4", { cpLoss: 0, evalCp: null });

    expect(
      db.prepare("SELECT cp_loss, eval_cp FROM repertoire_positions ORDER BY id").all(),
    ).toEqual([
      { cp_loss: 12, eval_cp: -30 },
      { cp_loss: null, eval_cp: 25 },
      { cp_loss: 0, eval_cp: null },
    ]);
  });

  it("refuses a kind other than own or reply", () => {
    expect(() => insertPosition(1, "setup", "start", "d2d4")).toThrow(/CHECK/);
    expect(() => insertPosition(1, "", "start", "d2d4")).toThrow(/CHECK/);
  });

  it("refuses a second own move for one position of one unit, and takes it in another unit", () => {
    insertPosition(1, "own", "start", "d2d4");

    expect(() => insertPosition(1, "own", "start", "e2e4")).toThrow(/UNIQUE/);
    expect(() => insertPosition(2, "own", "start", "e2e4")).not.toThrow();
  });

  it("refuses a second reply for one position and move of one unit, and takes another move", () => {
    insertPosition(1, "reply", "after d4", "d7d5");

    expect(() => insertPosition(1, "reply", "after d4", "d7d5")).toThrow(/UNIQUE/);
    expect(() => insertPosition(1, "reply", "after d4", "g8f6")).not.toThrow();
    expect(() => insertPosition(2, "reply", "after d4", "d7d5")).not.toThrow();
  });

  it("takes an own move and a reply at one position of one unit", () => {
    insertPosition(1, "own", "start", "d2d4");
    expect(() => insertPosition(1, "reply", "start", "d7d5")).not.toThrow();
  });
});
