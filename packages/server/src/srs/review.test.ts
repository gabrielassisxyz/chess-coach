import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { START_FEN } from "../../test/fixture-game.js";
import type { Clock } from "../clock.js";
import { createCoachSession, listChatTail } from "../db/chat.js";
import { type Database, openDatabase } from "../db/open.js";
import { getCard, insertCard, listDueCards } from "../db/srs.js";
import { ReviewDesk } from "./review.js";

// Midday: the scheduler counts elapsed time in calendar days, and a learning step of ten minutes
// must not cross a day boundary in the figures below.
const T0 = new Date("2026-03-01T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let tmp: string;
let db: Database;
let now: Date;
const clock: Clock = { now: () => now };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-review-"));
  db = openDatabase(tmp);
  now = T0;
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function addCard(createdAt: Date = T0, expectedUci = "d2d4"): number {
  const card = insertCard(db, {
    sourceKind: "teaching",
    sourceGameId: null,
    sourceMoveId: null,
    promptFen: START_FEN,
    studentColor: "white",
    playedUci: "e2e4",
    expectedUci,
    cpLoss: 100,
    classification: "inaccuracy",
    explanation: null,
    createdAt: createdAt.toISOString(),
  });
  return (card as { id: number }).id;
}

const reviewRows = () =>
  db
    .prepare("SELECT card_id, quality, grade, answered_uci, correct, reviewed_at FROM srs_reviews")
    .all();

function rateOnce(desk: ReviewDesk, cardId: number, uci: string, grade: number) {
  const served = desk.serveCard(cardId);
  desk.answer(served.exposureId, uci);
  return desk.rate(served.exposureId, grade);
}

describe("serving and grading", () => {
  it("serves the position without the expected move and grades by exact UCI", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });
    const served = desk.serveCard(id);
    expect(served).toMatchObject({ cardId: id, promptFen: START_FEN, studentColor: "white" });
    expect(JSON.stringify(served)).not.toContain("d2d4");
    expect(desk.answer(served.exposureId, "d2d4")).toEqual({
      correct: true,
      expected_uci: "d2d4",
      expected_san: "d4",
    });
    const wrong = desk.serveCard(id);
    expect(desk.answer(wrong.exposureId, "e2e4").correct).toBe(false);
  });

  it("counts a promotion with another piece as wrong", () => {
    const id = addCard(T0, "a7a8q");
    const desk = new ReviewDesk({ db, clock });
    const served = desk.serveCard(id);
    expect(desk.answer(served.exposureId, "a7a8n").correct).toBe(false);
    const again = desk.serveCard(id);
    expect(desk.answer(again.exposureId, "a7a8q").correct).toBe(true);
  });

  it("refuses to serve a card that does not exist and a second answer", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });
    expect(() => desk.serveCard(999)).toThrow(expect.objectContaining({ code: "card_not_found" }));
    const served = desk.serveCard(id);
    desk.answer(served.exposureId, "d2d4");
    expect(() => desk.answer(served.exposureId, "d2d4")).toThrow(
      expect.objectContaining({ code: "exposure_answered" }),
    );
  });
});

describe("rating rules", () => {
  it("refuses a second rating with exposure_used and leaves the card alone", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });
    const served = desk.serveCard(id);
    desk.answer(served.exposureId, "d2d4");
    desk.rate(served.exposureId, 4);
    const after = getCard(db, id);
    expect(() => desk.rate(served.exposureId, 1)).toThrow(
      expect.objectContaining({ code: "exposure_used" }),
    );
    expect(getCard(db, id)).toEqual(after);
    expect(reviewRows()).toHaveLength(1);
  });

  it("refuses an unknown exposure with exposure_unknown", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });
    expect(() => desk.rate("not-a-serving", 3)).toThrow(
      expect.objectContaining({ code: "exposure_unknown" }),
    );
    expect(() => desk.answer("not-a-serving", "d2d4")).toThrow(
      expect.objectContaining({ code: "exposure_unknown" }),
    );
    expect(reviewRows()).toEqual([]);
    expect(getCard(db, id)?.fsrsState).toBe(0);
  });

  it("refuses a serving made before another tab rated the card, with exposure_stale", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });
    const mine = desk.serveCard(id);
    const other = desk.serveCard(id);
    desk.answer(mine.exposureId, "d2d4");
    desk.answer(other.exposureId, "d2d4");
    desk.rate(other.exposureId, 4);
    const after = getCard(db, id);
    expect(() => desk.rate(mine.exposureId, 3)).toThrow(
      expect.objectContaining({ code: "exposure_stale" }),
    );
    expect(getCard(db, id)).toEqual(after);
    expect(reviewRows()).toHaveLength(1);
  });

  it("refuses a rating before an answer, and a grade outside 1 to 4, 0 and 5 included", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });
    const served = desk.serveCard(id);
    expect(() => desk.rate(served.exposureId, 3)).toThrow(
      expect.objectContaining({ code: "exposure_unanswered" }),
    );
    desk.answer(served.exposureId, "d2d4");
    for (const bad of [0, 5, -1, 6, 2.5]) {
      expect(() => desk.rate(served.exposureId, bad)).toThrow(
        expect.objectContaining({ code: "invalid_grade" }),
      );
    }
    expect(reviewRows()).toEqual([]);
    expect(getCard(db, id)?.fsrsState).toBe(0);
  });
});

describe("the intervals on the buttons", () => {
  it("are 1 minute, 6 minutes, 10 minutes and 8 days on a card nobody has rated", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });

    const preview = desk.previewRatings(id);

    expect(Object.keys(preview)).toEqual(["1", "2", "3", "4"]);
    expect(preview["1"]).toBeCloseTo(1 / 60, 9);
    expect(preview["2"]).toBeCloseTo(6 / 60, 9);
    expect(preview["3"]).toBeCloseTo(10 / 60, 9);
    expect(preview["4"]).toBeCloseTo(8 * 24, 9);
  });

  it("grow with how late the card is, read at the clock of the preview", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });
    rateOnce(desk, id, "d2d4", 3);
    now = new Date(T0.getTime() + 10 * MINUTE);
    rateOnce(desk, id, "d2d4", 3);
    const due = new Date(now.getTime() + 2 * DAY);

    now = due;
    const onTime = desk.previewRatings(id);
    now = new Date(due.getTime() + 5 * DAY);
    const late = desk.previewRatings(id);

    expect(onTime["3"]).toBeCloseTo(11 * 24, 9);
    expect(late["3"]).toBeGreaterThan(onTime["3"]);
  });

  it("are the interval each grade then gives the card", () => {
    for (const grade of [1, 2, 3, 4]) {
      db.exec("DELETE FROM srs_cards");
      now = T0;
      const id = addCard();
      const desk = new ReviewDesk({ db, clock });
      const shown = desk.previewRatings(id)[`${grade}` as "1" | "2" | "3" | "4"];

      rateOnce(desk, id, "d2d4", grade);

      expect(getCard(db, id)?.intervalHours, `grade ${grade}`).toBeCloseTo(shown, 9);
    }
  });
});

describe("rescheduling", () => {
  it("rated Good each time it falls due comes back after 10 minutes, 2 days and 11 days", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });
    const expected = [
      { interval: 10 * MINUTE, state: 1, step: 1 },
      { interval: 2 * DAY, state: 2, step: 0 },
      { interval: 11 * DAY, state: 2, step: 0 },
    ];
    for (const want of expected) {
      const rated = rateOnce(desk, id, "d2d4", 3);
      const card = getCard(db, id);
      expect(card?.intervalHours).toBeCloseTo(want.interval / HOUR, 9);
      expect(card).toMatchObject({
        fsrsState: want.state,
        learningStep: want.step,
        lapses: 0,
        lastReviewedAt: now.toISOString(),
        nextReviewAt: new Date(now.getTime() + want.interval).toISOString(),
      });
      expect(rated).toEqual({
        reviewedAt: now.toISOString(),
        nextReviewAt: new Date(now.getTime() + want.interval).toISOString(),
      });
      now = new Date(now.getTime() + want.interval);
    }
    expect(reviewRows()).toHaveLength(3);
  });

  it("rated Again on a card it had learned lapses and comes back in 10 minutes", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });
    for (const interval of [10 * MINUTE, 2 * DAY]) {
      rateOnce(desk, id, "d2d4", 3);
      now = new Date(now.getTime() + interval);
    }

    rateOnce(desk, id, "e2e4", 1);

    expect(getCard(db, id)).toMatchObject({
      fsrsState: 3,
      lapses: 1,
      nextReviewAt: new Date(now.getTime() + 10 * MINUTE).toISOString(),
    });
  });

  it("serves a due card, answers it wrong, rates Again and finds it due again in a minute", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });
    expect(desk.listDueCards().map((card) => card.id)).toEqual([id]);
    const served = desk.serveCard(id);
    expect(desk.answer(served.exposureId, "e2e4").correct).toBe(false);
    desk.rate(served.exposureId, 1);
    expect(desk.listDueCards()).toEqual([]);
    now = new Date(T0.getTime() + MINUTE - 1);
    expect(desk.listDueCards()).toEqual([]);
    now = new Date(T0.getTime() + MINUTE);
    expect(desk.listDueCards().map((card) => card.id)).toEqual([id]);
    expect(reviewRows()).toEqual([
      {
        card_id: id,
        quality: null,
        grade: 1,
        answered_uci: "e2e4",
        correct: 0,
        reviewed_at: T0.toISOString(),
      },
    ]);
  });

  it("writes the grade of each of the four buttons and leaves the old quality empty", () => {
    for (const grade of [1, 2, 3, 4]) {
      db.exec("DELETE FROM srs_cards");
      now = T0;
      const id = addCard();
      rateOnce(new ReviewDesk({ db, clock }), id, "d2d4", grade);

      expect(reviewRows(), `grade ${grade}`).toEqual([
        {
          card_id: id,
          quality: null,
          grade,
          answered_uci: "d2d4",
          correct: 1,
          reviewed_at: T0.toISOString(),
        },
      ]);
    }
  });

  it("writes the review row and the schedule in one transaction", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });
    const served = desk.serveCard(id);
    desk.answer(served.exposureId, "d2d4");
    const before = getCard(db, id);
    db.exec(
      "CREATE TRIGGER fail_update BEFORE UPDATE ON srs_cards BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() => desk.rate(served.exposureId, 3)).toThrow("injected");
    expect(reviewRows()).toEqual([]);
    expect(getCard(db, id)).toEqual(before);
    db.exec("DROP TRIGGER fail_update");
    desk.rate(served.exposureId, 3);
    expect(reviewRows()).toHaveLength(1);
  });
});

describe("listDueCards", () => {
  it("orders by due time then id, and a card rated Good waits for its new date", () => {
    const early = addCard(new Date(T0.getTime() - 2 * HOUR));
    const lateA = addCard(new Date(T0.getTime() - HOUR));
    const lateB = addCard(new Date(T0.getTime() - HOUR));
    addCard(new Date(T0.getTime() + HOUR));
    expect(listDueCards(db, T0).map((card) => card.id)).toEqual([early, lateA, lateB]);
    expect(listDueCards(db, T0, 2).map((card) => card.id)).toEqual([early, lateA]);
    rateOnce(new ReviewDesk({ db, clock }), early, "d2d4", 3);
    expect(listDueCards(db, T0).map((card) => card.id)).toEqual([lateA, lateB]);
  });

  it("defaults to 20 and caps at 100", () => {
    for (let i = 0; i < 105; i += 1) addCard();
    expect(listDueCards(db, T0)).toHaveLength(20);
    expect(listDueCards(db, T0, 500)).toHaveLength(100);
  });
});

describe("answer notification", () => {
  it("writes an undelivered notification row for the coach session", () => {
    const id = addCard();
    const session = createCoachSession(db, { promptVersion: "t" }, clock);
    const desk = new ReviewDesk({ db, clock, notifications: { sessionId: () => session.id } });
    const served = desk.serveCard(id);
    desk.answer(served.exposureId, "e2e4");
    const [row] = listChatTail(db, session.id, 5);
    expect(row).toMatchObject({ role: "user", kind: "notification", delivered: false });
    expect(JSON.parse(row?.contentJson ?? "")).toEqual({
      type: "srs_answer",
      card_id: id,
      prompt_fen: START_FEN,
      answered_uci: "e2e4",
      answered_san: "e4",
      expected_uci: "d2d4",
      expected_san: "d4",
      correct: false,
    });
  });
});
