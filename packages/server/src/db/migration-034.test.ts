import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerFoundPositionRoutes } from "../http/found-positions.js";
import { defaultMigrationsDir, runMigrations } from "./migrate.js";

const MIGRATION = "034_remove_own_position_cards.sql";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
// The first is listed by From my games and holds a card there; no rule finds the second any more;
// the third is a puzzle of the old drill that was never served, so nothing else points at it.
const OWN_LISTED = "own:1111111111111111";
const OWN_UNFOUND = "own:2222222222222222";
const OWN_NEVER_SERVED = "own:3333333333333333";
const LICHESS = "lichess-db:00sHx";
// The ids are interleaved, so the cards that go are not a range of them.
const CARD = { ownListed: 3, lichess: 4, ownUnfound: 5, coach: 7 };
const NOW = new Date("2026-11-18T12:00:00.000Z");

let tmp: string;
let db: BetterSqlite3.Database;

// A database as it stands at 033, opened the way the server opens it: with foreign keys enforced,
// which is what takes a deleted card's reviews with it.
function databaseAt033(): BetterSqlite3.Database {
  const dir = join(tmp, "at-033");
  mkdirSync(dir);
  for (const name of readdirSync(defaultMigrationsDir)) {
    if (name < "034") cpSync(join(defaultMigrationsDir, name), join(dir, name));
  }
  const opened = new BetterSqlite3(join(tmp, "a.db"));
  opened.pragma("foreign_keys = ON");
  runMigrations(opened, dir);
  return opened;
}

// Applies 034 and nothing after it, so that a later migration that adds a column cannot change
// what a row is compared with.
function apply034(): string[] {
  const dir = join(tmp, "at-034");
  mkdirSync(dir);
  for (const name of readdirSync(defaultMigrationsDir)) {
    if (name < "035") cpSync(join(defaultMigrationsDir, name), join(dir, name));
  }
  return runMigrations(db, dir);
}

interface CardSeed {
  id: number;
  puzzleId: string | null;
  due: string;
  state: number;
  stability: number | null;
  difficulty: number | null;
}

// A card a missed puzzle leaves has no played move's grading; a card the coach makes has one.
function insertCard(card: CardSeed): void {
  const coach = card.puzzleId === null;
  db.prepare(
    `INSERT INTO srs_cards (id, source_kind, prompt_fen, student_color, played_uci, expected_uci,
       cp_loss, classification, explanation, created_at, next_review_at, interval_hours, puzzle_id,
       fsrs_state, stability, difficulty, last_reviewed_at)
     VALUES (?, 'teaching', ?, 'black', ?, 'e7e5', ?, ?, 'why', '2026-11-01T00:00:00.000Z', ?, ?, ?,
       ?, ?, ?, ?)`,
  ).run(
    card.id,
    AFTER_E4,
    coach ? "d7d5" : null,
    coach ? 120 : null,
    coach ? "mistake" : null,
    card.due,
    card.stability === null ? 0 : card.stability * 24,
    card.puzzleId,
    card.state,
    card.stability,
    card.difficulty,
    card.stability === null ? null : "2026-11-10T08:00:00.000Z",
  );
}

function insertReview(id: number, cardId: number, grade: number): void {
  db.prepare(
    `INSERT INTO srs_reviews (id, card_id, reviewed_at, grade, answered_uci, correct)
     VALUES (?, ?, '2026-11-10T08:00:00.000Z', ?, 'e7e5', ?)`,
  ).run(id, cardId, grade, grade >= 3 ? 1 : 0);
}

function insertPuzzle(id: string, source: string): void {
  db.prepare(
    `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
     VALUES (?, ?, 'opening-black', 'beginner', ?, '["e7e5"]', '["e5"]', 'why')`,
  ).run(id, source, AFTER_E4);
}

function insertFoundPosition(id: string, listed: boolean): void {
  db.prepare(
    `INSERT INTO found_positions (id, fen, color, phase, from_mistake, from_repeat, from_departure,
       accepted_uci, listed, reached_games, best_games, last_reached_at, game_id, ply, first_found_at)
     VALUES (?, ?, 'black', 'opening', ?, 0, 0, '["e7e5"]', ?, 1, 0, '2026-11-02T00:00:00.000Z', 1, 2,
       '2026-11-02T00:00:00.000Z')`,
  ).run(id, AFTER_E4, listed ? 1 : 0, listed ? 1 : 0);
}

function insertAttempt(puzzleId: string, solved: boolean): void {
  db.prepare(
    `INSERT INTO puzzle_attempts (puzzle_id, attempted_at, solved, answered_uci, first_try)
     VALUES (?, '2026-11-05T00:00:00.000Z', ?, '["e7e5"]', ?)`,
  ).run(puzzleId, solved ? 1 : 0, solved ? 1 : 0);
}

function seed(): void {
  insertPuzzle(OWN_LISTED, "own-games");
  insertPuzzle(OWN_UNFOUND, "own-games");
  insertPuzzle(OWN_NEVER_SERVED, "own-games");
  insertPuzzle(LICHESS, "lichess-db");
  insertFoundPosition(OWN_LISTED, true);
  insertFoundPosition(OWN_UNFOUND, false);
  db.prepare(
    `INSERT INTO found_cards (position_id, interval_hours, fsrs_state, stability, difficulty,
       next_review_at, introduced_at, reviews, last_reviewed_at)
     VALUES (?, 24, 2, 1, 2.1181, '2026-11-19T00:00:00.000Z', '2026-11-03T00:00:00.000Z', 2,
       '2026-11-18T00:00:00.000Z')`,
  ).run(OWN_LISTED);
  insertAttempt(OWN_LISTED, false);
  insertAttempt(OWN_LISTED, true);
  insertAttempt(OWN_UNFOUND, false);
  insertAttempt(LICHESS, false);

  insertCard({
    id: CARD.ownListed,
    puzzleId: OWN_LISTED,
    due: "2026-11-19T10:00:00.000Z",
    state: 2,
    stability: 2,
    difficulty: 2.1181,
  });
  insertCard({
    id: CARD.lichess,
    puzzleId: LICHESS,
    due: "2026-11-21T09:30:15.123Z",
    state: 2,
    stability: 3.25,
    difficulty: 6.4133,
  });
  insertCard({
    id: CARD.ownUnfound,
    puzzleId: OWN_UNFOUND,
    due: "2026-11-01T00:00:00.000Z",
    state: 0,
    stability: null,
    difficulty: null,
  });
  insertCard({
    id: CARD.coach,
    puzzleId: null,
    due: "2026-11-18T22:45:59.999Z",
    state: 1,
    stability: 0.4,
    difficulty: 5.5,
  });
  insertReview(31, CARD.ownListed, 1);
  insertReview(41, CARD.lichess, 3);
  insertReview(32, CARD.ownListed, 3);
  insertReview(51, CARD.ownUnfound, 1);
  insertReview(42, CARD.lichess, 1);
  insertReview(71, CARD.coach, 3);
}

const rowsOf = (table: string, key: string): unknown[] =>
  db.prepare(`SELECT * FROM ${table} ORDER BY ${key}`).all();

const ownCards = (): unknown =>
  db.prepare("SELECT count(*) AS n FROM srs_cards WHERE puzzle_id LIKE 'own:%'").get();

// The answer of the route the From my games page reads, over this database.
async function foundPositionsAnswer(): Promise<{ positions: unknown[]; counts: unknown }> {
  const app = Fastify();
  registerFoundPositionRoutes(app, db, { now: () => NOW });
  await app.ready();
  const response = await app.inject({ method: "GET", url: "/api/found-positions" });
  await app.close();
  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-mig034-"));
  db = databaseAt033();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("034_remove_own_position_cards: the review desk", () => {
  it("deletes every card whose puzzle is a position from the student's games", () => {
    seed();
    expect(ownCards()).toEqual({ n: 2 });

    expect(apply034()).toEqual([MIGRATION]);

    expect(ownCards()).toEqual({ n: 0 });
    expect(db.prepare("SELECT id, puzzle_id FROM srs_cards ORDER BY id").all()).toEqual([
      { id: CARD.lichess, puzzle_id: LICHESS },
      { id: CARD.coach, puzzle_id: null },
    ]);
  });

  it("leaves the card of a Lichess puzzle and a card the coach made column for column", () => {
    seed();
    const kept = (): unknown[] =>
      db
        .prepare("SELECT * FROM srs_cards WHERE id IN (?, ?) ORDER BY id")
        .all(CARD.lichess, CARD.coach);
    const before = kept();

    apply034();

    expect(kept()).toEqual(before);
    expect(kept()).toMatchObject([
      {
        id: CARD.lichess,
        next_review_at: "2026-11-21T09:30:15.123Z",
        stability: 3.25,
        difficulty: 6.4133,
        fsrs_state: 2,
      },
      {
        id: CARD.coach,
        next_review_at: "2026-11-18T22:45:59.999Z",
        stability: 0.4,
        difficulty: 5.5,
        fsrs_state: 1,
      },
    ]);
  });

  it("takes the reviews of the deleted cards with them, and no other review", () => {
    seed();
    const before = rowsOf("srs_reviews", "id") as { id: number; card_id: number }[];
    const ofKeptCards = before.filter(
      (review) => review.card_id === CARD.lichess || review.card_id === CARD.coach,
    );

    apply034();

    const after = rowsOf("srs_reviews", "id") as { id: number }[];
    expect(after).toEqual(ofKeptCards);
    expect(after.map((review) => review.id)).toEqual([41, 42, 71]);
    expect(before).toHaveLength(6);
  });

  it("leaves no row that points at a missing one", () => {
    seed();
    apply034();

    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("034_remove_own_position_cards: the rest of the database", () => {
  const KEPT_TABLES = [
    ["puzzles", "id", 4],
    ["found_positions", "id", 2],
    ["found_cards", "position_id", 1],
    ["puzzle_attempts", "id", 4],
  ] as const;

  it.each(KEPT_TABLES)("keeps every row of %s as it was", (table, key, rows) => {
    seed();
    const before = rowsOf(table, key);
    expect(before).toHaveLength(rows);

    apply034();

    expect(rowsOf(table, key)).toEqual(before);
  });

  // The route's code reads the newest schema, so here every migration is applied.
  it("still answers the position that was listed on GET /api/found-positions", async () => {
    seed();
    expect(db.prepare("SELECT id FROM found_positions WHERE listed = 1").all()).toEqual([
      { id: OWN_LISTED },
    ]);

    runMigrations(db, defaultMigrationsDir);

    const answer = await foundPositionsAnswer();
    expect(answer.positions).toMatchObject([
      { id: OWN_LISTED, state: "scheduled", next_review_at: "2026-11-19T00:00:00.000Z" },
    ]);
    expect(answer.counts).toMatchObject({ total: 1, left_out: 1 });
  });

  it("changes no table, column or index", () => {
    const schema = (): unknown[] =>
      db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    const before = schema();

    apply034();

    expect(schema()).toEqual(before);
  });
});
