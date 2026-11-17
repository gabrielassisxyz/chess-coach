import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FoundCardSchedule, findFoundCard, rateFoundCard } from "./found-cards.js";
import { insertFoundPosition } from "./found-positions.js";
import { runMigrations } from "./migrate.js";

const T0 = new Date("2026-11-15T12:00:00.000Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const minutesAfter = (from: Date, minutes: number): Date =>
  new Date(from.getTime() + minutes * MINUTE_MS);
const hoursAfter = (from: Date, hours: number): Date => new Date(from.getTime() + hours * HOUR_MS);
const ID = "own:0123456789abcdef";

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  insertFoundPosition(db, {
    id: ID,
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
    color: "black",
    phase: "opening",
    fromMistake: true,
    fromRepeat: false,
    fromDeparture: false,
    listed: true,
    acceptedUci: ["e7e5", "c7c5"],
    reachedGames: 1,
    bestGames: 0,
    lastReachedAt: T0.toISOString(),
    gameId: 1,
    ply: 2,
    firstFoundAt: T0.toISOString(),
  });
});
afterEach(() => {
  db.close();
});

const card = (): FoundCardSchedule | undefined => findFoundCard(db, ID);

const loggedReviews = (): unknown[] =>
  db.prepare("SELECT card_kind, card_key, reviewed_at, grade FROM drill_reviews ORDER BY id").all();

describe("the schedule of a position from the student's games", () => {
  it("has no card until a drill rates the position", () => {
    expect(card()).toBeUndefined();
    expect(loggedReviews()).toEqual([]);
  });

  it("creates the card of a position solved first try as Good, back in 10 minutes", () => {
    rateFoundCard(db, ID, true, T0);
    expect(card()).toMatchObject({
      position_id: ID,
      fsrs_state: 1,
      learning_step: 1,
      lapses: 0,
      next_review_at: minutesAfter(T0, 10).toISOString(),
      introduced_at: T0.toISOString(),
      reviews: 1,
      last_reviewed_at: T0.toISOString(),
    });
    expect(card()?.interval_hours).toBeCloseTo(10 / 60, 9);
    expect(card()?.difficulty).toBeCloseTo(2.1181, 4);
  });

  it("creates the card of a position missed first as Again, back in a minute", () => {
    rateFoundCard(db, ID, false, T0);
    expect(card()).toMatchObject({
      fsrs_state: 1,
      learning_step: 0,
      next_review_at: minutesAfter(T0, 1).toISOString(),
      reviews: 1,
    });
    expect(card()?.difficulty).toBeCloseTo(6.4133, 4);
  });

  it("graduates a due card to a 2 day interval on a second right first try", () => {
    rateFoundCard(db, ID, true, T0);
    const due = minutesAfter(T0, 10);
    rateFoundCard(db, ID, true, due);
    expect(card()).toMatchObject({
      fsrs_state: 2,
      learning_step: 0,
      next_review_at: hoursAfter(due, 48).toISOString(),
      introduced_at: T0.toISOString(),
      reviews: 2,
      last_reviewed_at: due.toISOString(),
    });
    expect(card()?.interval_hours).toBeCloseTo(48, 9);
  });

  it("brings a graduated card back in 10 minutes on a miss, due or not", () => {
    rateFoundCard(db, ID, true, T0);
    rateFoundCard(db, ID, true, minutesAfter(T0, 10));
    const early = hoursAfter(T0, 6);
    rateFoundCard(db, ID, false, early);
    expect(card()).toMatchObject({
      fsrs_state: 3,
      lapses: 1,
      next_review_at: minutesAfter(early, 10).toISOString(),
      reviews: 3,
    });
  });

  it("keeps the whole schedule of a card not yet due on a right first try", () => {
    rateFoundCard(db, ID, true, T0);
    const before = card();
    rateFoundCard(db, ID, true, minutesAfter(T0, 5));
    expect(card()).toEqual(before);
  });

  it("rates a position rated right while due, whether new or already learning", () => {
    rateFoundCard(db, ID, false, T0);
    expect(card()?.next_review_at).toBe(minutesAfter(T0, 1).toISOString());
    rateFoundCard(db, ID, true, minutesAfter(T0, 1));
    expect(card()).toMatchObject({ fsrs_state: 1, learning_step: 1, reviews: 2 });
  });

  it("goes with its position", () => {
    rateFoundCard(db, ID, true, T0);
    db.prepare("DELETE FROM found_positions WHERE id = ?").run(ID);
    expect(card()).toBeUndefined();
  });
});

describe("the log of the position's ratings", () => {
  it("holds one row for each rating: Good for a right first try, Again for anything else", () => {
    rateFoundCard(db, ID, true, T0);
    const due = minutesAfter(T0, 10);
    rateFoundCard(db, ID, false, due);

    expect(loggedReviews()).toEqual([
      { card_kind: "found", card_key: ID, reviewed_at: T0.toISOString(), grade: 3 },
      { card_kind: "found", card_key: ID, reviewed_at: due.toISOString(), grade: 1 },
    ]);
  });

  it("holds nothing for a right try that kept the schedule of a card not yet due", () => {
    rateFoundCard(db, ID, true, T0);
    rateFoundCard(db, ID, true, minutesAfter(T0, 5));

    expect(loggedReviews()).toHaveLength(1);
  });

  it("outlives the position and its card", () => {
    rateFoundCard(db, ID, true, T0);
    db.prepare("DELETE FROM found_positions WHERE id = ?").run(ID);

    expect(loggedReviews()).toEqual([
      { card_kind: "found", card_key: ID, reviewed_at: T0.toISOString(), grade: 3 },
    ]);
  });

  it("is written with the card: a log row that cannot be written leaves the card unrated", () => {
    db.exec(
      "CREATE TRIGGER fail_log BEFORE INSERT ON drill_reviews BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );

    expect(() => rateFoundCard(db, ID, true, T0)).toThrow("injected");
    expect(card()).toBeUndefined();
    expect(loggedReviews()).toEqual([]);
  });
});
