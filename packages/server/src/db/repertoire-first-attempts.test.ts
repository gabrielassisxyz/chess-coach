import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "./open.js";
import {
  countRepertoireFirstAttemptsInWindow,
  insertRepertoireFirstAttempt,
} from "./repertoire-cards.js";
import { createRepertoireVariation } from "./repertoires.js";

const AT = new Date("2026-11-15T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-first-attempts-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const variation = (name: string): number =>
  createRepertoireVariation(db, { side: "white", groupName: "Italian Game", variationName: name })
    .id;

const before = (ms: number): string => new Date(AT.getTime() - ms).toISOString();

// Every row is the same move in the same position, so only the variation and the time tell them
// apart: the count is per variation, not per card.
function addAttempt(repertoireId: number, attemptedAt: string, correct: 0 | 1): void {
  db.prepare(
    `INSERT INTO repertoire_first_attempts
       (position_key, move_uci, repertoire_id, attempted_at, correct)
     VALUES ('a-position', 'e2e4', ?, ?, ?)`,
  ).run(repertoireId, attemptedAt, correct);
}

function addAttemptsAround(first: number, second: number): void {
  addAttempt(first, AT.toISOString(), 1);
  addAttempt(first, before(HOUR_MS), 0);
  addAttempt(first, before(29 * DAY_MS), 1);
  // One millisecond inside the window, then exactly on its edge and beyond it.
  addAttempt(first, before(30 * DAY_MS - 1), 0);
  addAttempt(first, before(30 * DAY_MS), 1);
  addAttempt(first, before(31 * DAY_MS), 1);
  // After the time asked about, which the 30 days before it do not hold.
  addAttempt(first, new Date(AT.getTime() + 1).toISOString(), 1);

  addAttempt(second, before(2 * DAY_MS), 1);
  addAttempt(second, before(3 * DAY_MS), 1);
  addAttempt(second, before(4 * DAY_MS), 0);
  addAttempt(second, before(60 * DAY_MS), 0);
}

describe("the first attempts of a variation in the 30 days before a time", () => {
  it("counts the rows inside the window and how many were right, per variation", () => {
    const first = variation("Classical");
    const second = variation("Pianissimo");
    addAttemptsAround(first, second);

    expect(countRepertoireFirstAttemptsInWindow(db, first, AT)).toEqual({ attempts: 4, right: 2 });
    expect(countRepertoireFirstAttemptsInWindow(db, second, AT)).toEqual({
      attempts: 3,
      right: 2,
    });
  });

  it("reads the window from the time it is given, not from the clock", () => {
    const first = variation("Classical");
    addAttemptsAround(first, variation("Pianissimo"));

    const later = new Date(AT.getTime() + 2 * DAY_MS);
    // Two days on, the row after AT is inside and the one 29 days before AT has left the window.
    expect(countRepertoireFirstAttemptsInWindow(db, first, later)).toEqual({
      attempts: 3,
      right: 2,
    });
  });

  it("answers 0 of 0 for a variation with no row, and for one whose rows are all outside", () => {
    const first = variation("Classical");
    const empty = variation("Pianissimo");
    const old = variation("Scotch");
    addAttempt(old, before(45 * DAY_MS), 1);
    addAttempt(first, AT.toISOString(), 1);

    expect(countRepertoireFirstAttemptsInWindow(db, empty, AT)).toEqual({ attempts: 0, right: 0 });
    expect(countRepertoireFirstAttemptsInWindow(db, old, AT)).toEqual({ attempts: 0, right: 0 });
    expect(countRepertoireFirstAttemptsInWindow(db, 999, AT)).toEqual({ attempts: 0, right: 0 });
  });
});

describe("storing a first attempt", () => {
  it("keeps the card's position and move, the variation, the time and whether it was right", () => {
    const id = variation("Classical");
    const missedAt = "2026-11-14T09:30:00.000Z";
    insertRepertoireFirstAttempt(
      db,
      { positionKey: "first-position", uci: "e2e4", repertoireId: id, correct: true },
      AT.toISOString(),
    );
    insertRepertoireFirstAttempt(
      db,
      { positionKey: "second-position", uci: "g1f3", repertoireId: id, correct: false },
      missedAt,
    );

    expect(
      db
        .prepare(
          `SELECT position_key, move_uci, repertoire_id, attempted_at, correct
           FROM repertoire_first_attempts ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        position_key: "first-position",
        move_uci: "e2e4",
        repertoire_id: id,
        attempted_at: AT.toISOString(),
        correct: 1,
      },
      {
        position_key: "second-position",
        move_uci: "g1f3",
        repertoire_id: id,
        attempted_at: missedAt,
        correct: 0,
      },
    ]);
  });

  it("refuses a result that is neither 0 nor 1 and a variation that does not exist", () => {
    const id = variation("Classical");
    expect(() => addAttempt(id, AT.toISOString(), 2 as 0 | 1)).toThrow(/CHECK constraint failed/);
    expect(() => addAttempt(999, AT.toISOString(), 1)).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("goes with its variation when the variation is deleted, and leaves another's rows", () => {
    const gone = variation("Classical");
    const kept = variation("Pianissimo");
    addAttempt(gone, AT.toISOString(), 1);
    addAttempt(kept, AT.toISOString(), 0);

    db.prepare("DELETE FROM repertoires WHERE id = ?").run(gone);

    expect(db.prepare("SELECT repertoire_id FROM repertoire_first_attempts").all()).toEqual([
      { repertoire_id: kept },
    ]);
  });
});
