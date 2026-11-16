import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "./migrate.js";

let tmp: string;
let db: BetterSqlite3.Database;

// A database as it stands at 032, opened the way the server opens it: with foreign keys enforced,
// which is what makes a careless rebuild of a table that others point at fail.
function databaseAt032(): BetterSqlite3.Database {
  const dir = join(tmp, "at-032");
  mkdirSync(dir);
  for (const name of readdirSync(defaultMigrationsDir)) {
    if (name < "033") cpSync(join(defaultMigrationsDir, name), join(dir, name));
  }
  const opened = new BetterSqlite3(join(tmp, "a.db"));
  opened.pragma("foreign_keys = ON");
  runMigrations(opened, dir);
  return opened;
}

// Due dates with milliseconds and a time of day, so a migration that rewrites one is caught.
const DUE = {
  newCard: "2026-11-10T08:00:00.000Z",
  passed: "2026-11-18T09:30:15.123Z",
  failed: "2026-11-12T22:45:59.999Z",
  pastLadder: "2027-01-02T00:00:00.001Z",
  imported: "2026-11-20T13:00:00.500Z",
};

interface SrsSeed {
  id: number;
  interval: number;
  ease: number;
  repetitions: number;
  due: string;
}

function insertSrsCard(card: SrsSeed): void {
  db.prepare(
    `INSERT INTO srs_cards (id, source_kind, prompt_fen, student_color, expected_uci, created_at,
       next_review_at, interval_hours, ease_factor, repetitions)
     VALUES (?, 'teaching', 'fen', 'white', 'e2e4', '2026-11-01T00:00:00.000Z', ?, ?, ?, ?)`,
  ).run(card.id, card.due, card.interval, card.ease, card.repetitions);
}

// One review of every quality, on explicit ids that do not follow the time order, so the latest
// review is told apart from the highest id.
function insertSrsReview(id: number, cardId: number, quality: number, at: string): void {
  db.prepare(
    `INSERT INTO srs_reviews (id, card_id, reviewed_at, quality, answered_uci, correct)
     VALUES (?, ?, ?, ?, 'e2e4', ?)`,
  ).run(id, cardId, at, quality, quality >= 3 ? 1 : 0);
}

interface DrillSeed {
  key: string;
  interval: number;
  ease: number;
  repetitions: number;
  reviews: number;
  due: string;
  last: string | null;
}

function insertRepertoireCard(card: DrillSeed): void {
  db.prepare(
    `INSERT INTO repertoire_cards (position_key, move_uci, introduced_at, next_review_at,
       interval_hours, ease_factor, repetitions, reviews, last_reviewed_at)
     VALUES (?, 'e2e4', '2026-11-01T00:00:00.000Z', ?, ?, ?, ?, ?, ?)`,
  ).run(card.key, card.due, card.interval, card.ease, card.repetitions, card.reviews, card.last);
}

function insertFoundCard(card: DrillSeed): void {
  db.prepare(
    `INSERT INTO found_positions (id, fen, color, phase, from_mistake, from_repeat, from_departure,
       accepted_uci, listed, reached_games, best_games, last_reached_at, game_id, ply, first_found_at)
     VALUES (?, 'fen', 'white', 'opening', 1, 0, 0, '["e2e4"]', 1, 1, 0, 't', 1, 2, 't')`,
  ).run(card.key);
  db.prepare(
    `INSERT INTO found_cards (position_id, next_review_at, introduced_at, interval_hours, ease_factor,
       repetitions, reviews, last_reviewed_at)
     VALUES (?, ?, '2026-11-01T00:00:00.000Z', ?, ?, ?, ?, ?)`,
  ).run(card.key, card.due, card.interval, card.ease, card.repetitions, card.reviews, card.last);
}

const DRILL_SEEDS: DrillSeed[] = [
  { key: "new", interval: 0, ease: 2.5, repetitions: 0, reviews: 0, due: DUE.newCard, last: null },
  {
    key: "passed",
    interval: 24,
    ease: 2.5,
    repetitions: 2,
    reviews: 2,
    due: DUE.passed,
    last: "2026-11-17T09:30:15.123Z",
  },
  {
    key: "failed",
    interval: 4,
    ease: 2.18,
    repetitions: 0,
    reviews: 3,
    due: DUE.failed,
    last: "2026-11-12T18:45:59.999Z",
  },
];

function seed(): void {
  insertSrsCard({ id: 1, interval: 0, ease: 2.5, repetitions: 0, due: DUE.newCard });
  insertSrsCard({ id: 2, interval: 72, ease: 2.5, repetitions: 3, due: DUE.passed });
  insertSrsCard({ id: 3, interval: 4, ease: 2.18, repetitions: 0, due: DUE.failed });
  insertSrsCard({ id: 4, interval: 1756.8, ease: 2.44, repetitions: 7, due: DUE.pastLadder });
  insertSrsCard({ id: 5, interval: 24, ease: 2.5, repetitions: 2, due: DUE.imported });
  // Card 2: its latest review is the one with the middle id.
  insertSrsReview(10, 2, 5, "2026-11-10T08:00:00.000Z");
  insertSrsReview(7, 2, 4, "2026-11-15T09:30:15.123Z");
  insertSrsReview(8, 2, 3, "2026-11-12T08:00:00.000Z");
  insertSrsReview(11, 3, 2, "2026-11-12T18:45:59.999Z");
  insertSrsReview(12, 3, 1, "2026-11-11T18:45:59.999Z");
  insertSrsReview(13, 3, 0, "2026-11-10T18:45:59.999Z");
  insertSrsReview(14, 4, 4, "2026-11-01T00:00:00.001Z");
  // Cards 1 and 5 have no review: 5 came in with its schedule from an import.
  for (const card of DRILL_SEEDS) {
    insertRepertoireCard(card);
    insertFoundCard(card);
  }
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

const columnNames = (table: string): string[] => columns(table).map((column) => column.name);

const dueDates = (table: string, key: string): string[] =>
  (
    db.prepare(`SELECT ${key} AS k, next_review_at AS d FROM ${table} ORDER BY k`).all() as {
      d: string;
    }[]
  ).map((row) => row.d);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-mig033-"));
  db = databaseAt032();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("033_fsrs_schedule: the card tables", () => {
  it("leaves every next_review_at byte for byte as it was", () => {
    seed();
    const before = {
      srs: dueDates("srs_cards", "id"),
      repertoire: dueDates("repertoire_cards", "position_key"),
      found: dueDates("found_cards", "position_id"),
    };

    expect(runMigrations(db, defaultMigrationsDir)).toContain("033_fsrs_schedule.sql");

    expect(dueDates("srs_cards", "id")).toEqual(before.srs);
    expect(dueDates("repertoire_cards", "position_key")).toEqual(before.repertoire);
    expect(dueDates("found_cards", "position_id")).toEqual(before.found);
    expect(before.srs).toContain(DUE.passed);
  });

  it("makes an unrated card New with no stability or difficulty, and a rated one Review", () => {
    seed();
    runMigrations(db, defaultMigrationsDir);

    expect(
      db
        .prepare(
          `SELECT id, fsrs_state, stability, difficulty, learning_step, lapses, interval_hours
           FROM srs_cards ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: 1,
        fsrs_state: 0,
        stability: null,
        difficulty: null,
        learning_step: 0,
        lapses: 0,
        interval_hours: 0,
      },
      {
        id: 2,
        fsrs_state: 2,
        stability: 3,
        difficulty: 2.1181,
        learning_step: 0,
        lapses: 0,
        interval_hours: 72,
      },
      {
        id: 3,
        fsrs_state: 2,
        stability: 4 / 24,
        difficulty: 6.4133,
        learning_step: 0,
        lapses: 0,
        interval_hours: 4,
      },
      {
        id: 4,
        fsrs_state: 2,
        stability: 1756.8 / 24,
        difficulty: 2.1181,
        learning_step: 0,
        lapses: 0,
        interval_hours: 1756.8,
      },
      {
        id: 5,
        fsrs_state: 2,
        stability: 1,
        difficulty: 2.1181,
        learning_step: 0,
        lapses: 0,
        interval_hours: 24,
      },
    ]);
  });

  it("converts the repertoire and found cards by the same rule", () => {
    seed();
    runMigrations(db, defaultMigrationsDir);

    const wanted = [
      { k: "failed", fsrs_state: 2, stability: 4 / 24, difficulty: 6.4133, interval_hours: 4 },
      { k: "new", fsrs_state: 0, stability: null, difficulty: null, interval_hours: 0 },
      { k: "passed", fsrs_state: 2, stability: 1, difficulty: 2.1181, interval_hours: 24 },
    ];
    expect(
      db
        .prepare(
          `SELECT position_key AS k, fsrs_state, stability, difficulty, interval_hours, learning_step,
             lapses, reviews, last_reviewed_at FROM repertoire_cards ORDER BY k`,
        )
        .all(),
    ).toEqual(
      wanted.map((row) => ({
        ...row,
        learning_step: 0,
        lapses: 0,
        reviews: DRILL_SEEDS.find((seeded) => seeded.key === row.k)?.reviews,
        last_reviewed_at: DRILL_SEEDS.find((seeded) => seeded.key === row.k)?.last,
      })),
    );
    expect(
      db
        .prepare(
          `SELECT position_id AS k, fsrs_state, stability, difficulty, interval_hours, learning_step,
             lapses, reviews, last_reviewed_at FROM found_cards ORDER BY k`,
        )
        .all(),
    ).toEqual(
      wanted.map((row) => ({
        ...row,
        learning_step: 0,
        lapses: 0,
        reviews: DRILL_SEEDS.find((seeded) => seeded.key === row.k)?.reviews,
        last_reviewed_at: DRILL_SEEDS.find((seeded) => seeded.key === row.k)?.last,
      })),
    );
  });

  it("drops ease_factor and repetitions from all three tables and adds the memory columns", () => {
    runMigrations(db, defaultMigrationsDir);
    const memory = ["fsrs_state", "stability", "difficulty", "learning_step", "lapses"];

    for (const table of ["srs_cards", "repertoire_cards", "found_cards"]) {
      expect(columnNames(table), table).not.toContain("ease_factor");
      expect(columnNames(table), table).not.toContain("repetitions");
      expect(columnNames(table), table).toEqual(
        expect.arrayContaining([...memory, "interval_hours"]),
      );
    }
    const state = columns("srs_cards").find((column) => column.name === "fsrs_state");
    expect(state).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "0" });
    const step = columns("found_cards").find((column) => column.name === "learning_step");
    expect(step).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "0" });
  });

  it("gives a card created after it the defaults of a New card", () => {
    runMigrations(db, defaultMigrationsDir);
    db.prepare(
      `INSERT INTO srs_cards (id, source_kind, prompt_fen, student_color, expected_uci, created_at,
         next_review_at) VALUES (9, 'teaching', 'fen', 'white', 'e2e4', 't', 't')`,
    ).run();

    expect(
      db
        .prepare(
          `SELECT fsrs_state, stability, difficulty, learning_step, lapses, interval_hours,
             last_reviewed_at FROM srs_cards WHERE id = 9`,
        )
        .get(),
    ).toEqual({
      fsrs_state: 0,
      stability: null,
      difficulty: null,
      learning_step: 0,
      lapses: 0,
      interval_hours: 0,
      last_reviewed_at: null,
    });
  });

  it("fills last_reviewed_at on srs_cards from the latest review, not the highest id", () => {
    seed();
    runMigrations(db, defaultMigrationsDir);

    expect(db.prepare("SELECT id, last_reviewed_at FROM srs_cards ORDER BY id").all()).toEqual([
      { id: 1, last_reviewed_at: null },
      { id: 2, last_reviewed_at: "2026-11-15T09:30:15.123Z" },
      { id: 3, last_reviewed_at: "2026-11-12T18:45:59.999Z" },
      { id: 4, last_reviewed_at: "2026-11-01T00:00:00.001Z" },
      { id: 5, last_reviewed_at: null },
    ]);
  });
});

describe("033_fsrs_schedule: srs_reviews", () => {
  it("keeps every row and its id, and grades it 3 for a quality of 3 to 5 and 1 for 0 to 2", () => {
    seed();
    const before = db.prepare("SELECT * FROM srs_reviews ORDER BY id").all() as {
      id: number;
      quality: number;
    }[];

    runMigrations(db, defaultMigrationsDir);

    const after = db.prepare("SELECT * FROM srs_reviews ORDER BY id").all();
    expect(after).toEqual(before.map((row) => ({ ...row, grade: row.quality >= 3 ? 3 : 1 })));
    expect(after.map((row) => (row as { quality: number }).quality).sort()).toEqual(
      [0, 1, 2, 3, 4, 5, 4].sort(),
    );
  });

  it("accepts a review with a grade and no quality, and refuses a grade outside 1 to 4", () => {
    seed();
    runMigrations(db, defaultMigrationsDir);
    const add = (grade: number | null, quality: number | null): void => {
      db.prepare(
        `INSERT INTO srs_reviews (card_id, reviewed_at, quality, grade, answered_uci, correct)
         VALUES (2, 't', ?, ?, 'e2e4', 1)`,
      ).run(quality, grade);
    };

    expect(() => add(3, null)).not.toThrow();
    expect(() => add(0, null)).toThrow(/CHECK/);
    expect(() => add(5, null)).toThrow(/CHECK/);
    expect(() => add(3, 6)).toThrow(/CHECK/);
  });

  it("still takes a row that carries only the old quality", () => {
    seed();
    runMigrations(db, defaultMigrationsDir);

    expect(() =>
      db
        .prepare(
          `INSERT INTO srs_reviews (card_id, reviewed_at, quality, answered_uci, correct)
           VALUES (2, 't', 4, 'e2e4', 1)`,
        )
        .run(),
    ).not.toThrow();
  });

  it("keeps the index on card_id and the cascade from the card", () => {
    seed();
    runMigrations(db, defaultMigrationsDir);

    expect(
      (db.pragma("index_list(srs_reviews)") as { name: string }[]).map((index) => index.name),
    ).toContain("srs_reviews_card");
    db.prepare("DELETE FROM srs_cards WHERE id = 2").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM srs_reviews WHERE card_id = 2").get()).toEqual({
      n: 0,
    });
  });
});

describe("033_fsrs_schedule: drill_reviews", () => {
  it("creates the log with no foreign key, so a deleted unit keeps its history", () => {
    runMigrations(db, defaultMigrationsDir);

    expect(columns("drill_reviews")).toEqual([
      { name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "card_kind", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "card_key", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "reviewed_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "grade", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    ]);
    expect(db.pragma("foreign_key_list(drill_reviews)")).toEqual([]);
  });

  it("takes a repertoire or a found card and a grade from 1 to 4, and nothing else", () => {
    runMigrations(db, defaultMigrationsDir);
    const add = (kind: string, grade: number): void => {
      db.prepare(
        "INSERT INTO drill_reviews (card_kind, card_key, reviewed_at, grade) VALUES (?, 'k', 't', ?)",
      ).run(kind, grade);
    };

    expect(() => add("repertoire", 1)).not.toThrow();
    expect(() => add("found", 4)).not.toThrow();
    expect(() => add("srs", 3)).toThrow(/CHECK/);
    expect(() => add("found", 0)).toThrow(/CHECK/);
    expect(() => add("found", 5)).toThrow(/CHECK/);
  });
});

describe("033_fsrs_schedule: the rest of the database", () => {
  it("leaves no row that points at a missing one", () => {
    seed();
    runMigrations(db, defaultMigrationsDir);

    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("leaves what the earlier migrations hold untouched", () => {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('kept', 'yes', 't')").run();
    const settingsBefore = db.prepare("SELECT * FROM settings ORDER BY key").all();

    runMigrations(db, defaultMigrationsDir);

    expect(db.prepare("SELECT * FROM settings ORDER BY key").all()).toEqual(settingsBefore);
  });
});
