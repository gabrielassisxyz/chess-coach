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

const T0 = new Date("2026-03-01T00:00:00.000Z");
const HOUR = 3_600_000;

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
  db.prepare("SELECT card_id, quality, answered_uci, correct, reviewed_at FROM srs_reviews").all();

function rateOnce(desk: ReviewDesk, cardId: number, uci: string, quality: number) {
  const served = desk.serveCard(cardId);
  desk.answer(served.exposureId, uci);
  desk.rate(served.exposureId, quality);
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
    desk.rate(served.exposureId, 5);
    const after = getCard(db, id);
    expect(() => desk.rate(served.exposureId, 0)).toThrow(
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
    expect(getCard(db, id)?.repetitions).toBe(0);
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
    expect(() => desk.rate(mine.exposureId, 5)).toThrow(
      expect.objectContaining({ code: "exposure_stale" }),
    );
    expect(getCard(db, id)).toEqual(after);
    expect(reviewRows()).toHaveLength(1);
  });

  it("refuses a rating before an answer and a quality outside 0..5", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });
    const served = desk.serveCard(id);
    expect(() => desk.rate(served.exposureId, 3)).toThrow(
      expect.objectContaining({ code: "exposure_unanswered" }),
    );
    desk.answer(served.exposureId, "d2d4");
    for (const bad of [-1, 6, 2.5]) {
      expect(() => desk.rate(served.exposureId, bad)).toThrow(
        expect.objectContaining({ code: "invalid_quality" }),
      );
    }
    expect(reviewRows()).toEqual([]);
  });
});

describe("rescheduling", () => {
  it("rated 4 three times then 2 follows the SM-2 table", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });
    const expected = [
      { interval_hours: 4, ease_factor: 2.5, repetitions: 1 },
      { interval_hours: 24, ease_factor: 2.5, repetitions: 2 },
      { interval_hours: 72, ease_factor: 2.5, repetitions: 3 },
      { interval_hours: 4, ease_factor: 2.18, repetitions: 0 },
    ];
    [4, 4, 4, 2].forEach((quality, index) => {
      rateOnce(desk, id, "d2d4", quality);
      const card = getCard(db, id);
      const want = expected[index] as (typeof expected)[number];
      expect(card?.intervalHours).toBeCloseTo(want.interval_hours, 6);
      expect(card?.easeFactor).toBeCloseTo(want.ease_factor, 6);
      expect(card?.repetitions).toBe(want.repetitions);
      expect(card?.nextReviewAt).toBe(
        new Date(now.getTime() + want.interval_hours * HOUR).toISOString(),
      );
      now = new Date(now.getTime() + want.interval_hours * HOUR);
    });
    expect(reviewRows()).toHaveLength(4);
  });

  it("serves a due card, answers it wrong, rates 2 and finds it due again in four hours", () => {
    const id = addCard();
    const desk = new ReviewDesk({ db, clock });
    expect(desk.listDueCards().map((card) => card.id)).toEqual([id]);
    const served = desk.serveCard(id);
    expect(desk.answer(served.exposureId, "e2e4").correct).toBe(false);
    desk.rate(served.exposureId, 2);
    expect(desk.listDueCards()).toEqual([]);
    now = new Date(T0.getTime() + 4 * HOUR - 1);
    expect(desk.listDueCards()).toEqual([]);
    now = new Date(T0.getTime() + 4 * HOUR);
    expect(desk.listDueCards().map((card) => card.id)).toEqual([id]);
    expect(reviewRows()).toEqual([
      {
        card_id: id,
        quality: 2,
        answered_uci: "e2e4",
        correct: 0,
        reviewed_at: T0.toISOString(),
      },
    ]);
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
    expect(() => desk.rate(served.exposureId, 5)).toThrow("injected");
    expect(reviewRows()).toEqual([]);
    expect(getCard(db, id)).toEqual(before);
    db.exec("DROP TRIGGER fail_update");
    desk.rate(served.exposureId, 5);
    expect(reviewRows()).toHaveLength(1);
  });
});

describe("listDueCards", () => {
  it("orders by due time then id, and a card rated 5 waits for its new date", () => {
    const early = addCard(new Date(T0.getTime() - 2 * HOUR));
    const lateA = addCard(new Date(T0.getTime() - HOUR));
    const lateB = addCard(new Date(T0.getTime() - HOUR));
    addCard(new Date(T0.getTime() + HOUR));
    expect(listDueCards(db, T0).map((card) => card.id)).toEqual([early, lateA, lateB]);
    expect(listDueCards(db, T0, 2).map((card) => card.id)).toEqual([early, lateA]);
    rateOnce(new ReviewDesk({ db, clock }), early, "d2d4", 5);
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
