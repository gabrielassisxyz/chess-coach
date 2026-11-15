import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FoundCardSchedule, findFoundCard, rateFoundCard } from "./found-cards.js";
import { insertFoundPosition } from "./found-positions.js";
import { runMigrations } from "./migrate.js";

const T0 = new Date("2026-11-15T12:00:00.000Z");
const HOUR_MS = 3_600_000;
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

describe("the schedule of a position from the student's games", () => {
  it("has no card until a drill rates the position", () => {
    expect(card()).toBeUndefined();
  });

  it("creates the card of a position solved first try with quality 4, back in 4 hours", () => {
    rateFoundCard(db, ID, true, T0);
    expect(card()).toEqual({
      position_id: ID,
      interval_hours: 4,
      ease_factor: 2.5,
      repetitions: 1,
      next_review_at: hoursAfter(T0, 4).toISOString(),
      introduced_at: T0.toISOString(),
      reviews: 1,
      last_reviewed_at: T0.toISOString(),
    });
  });

  it("creates the card of a position missed first with quality 2, back in 4 hours", () => {
    rateFoundCard(db, ID, false, T0);
    expect(card()).toMatchObject({
      interval_hours: 4,
      repetitions: 0,
      next_review_at: hoursAfter(T0, 4).toISOString(),
      reviews: 1,
    });
    expect(card()?.ease_factor).toBeCloseTo(2.18, 10);
  });

  it("moves a due card one step up the ladder on a right first try", () => {
    rateFoundCard(db, ID, true, T0);
    const due = hoursAfter(T0, 5);
    rateFoundCard(db, ID, true, due);
    expect(card()).toMatchObject({
      interval_hours: 24,
      repetitions: 2,
      next_review_at: hoursAfter(due, 24).toISOString(),
      introduced_at: T0.toISOString(),
      reviews: 2,
      last_reviewed_at: due.toISOString(),
    });
  });

  it("brings a card back in 4 hours on a miss, due or not", () => {
    rateFoundCard(db, ID, true, T0);
    rateFoundCard(db, ID, true, hoursAfter(T0, 5));
    const early = hoursAfter(T0, 6);
    rateFoundCard(db, ID, false, early);
    expect(card()).toMatchObject({
      interval_hours: 4,
      repetitions: 0,
      next_review_at: hoursAfter(early, 4).toISOString(),
      reviews: 3,
    });
  });

  it("keeps the whole schedule of a card not yet due on a right first try", () => {
    rateFoundCard(db, ID, true, T0);
    const before = card();
    rateFoundCard(db, ID, true, hoursAfter(T0, 1));
    expect(card()).toEqual(before);
  });

  it("goes with its position", () => {
    rateFoundCard(db, ID, true, T0);
    db.prepare("DELETE FROM found_positions WHERE id = ?").run(ID);
    expect(card()).toBeUndefined();
  });
});
