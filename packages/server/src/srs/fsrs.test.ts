import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CARD_STATE,
  GRADE,
  GRADES,
  type Grade,
  isGrade,
  newSchedule,
  previewIntervals,
  review,
  type Schedule,
} from "./fsrs.js";

// Midday, so that the ten minutes of a learning step never cross a day boundary: the scheduler
// counts elapsed time in calendar days.
const START = new Date("2026-03-04T12:00:00.000Z");
const DAY_MS = 86_400_000;

const minutes = (count: number): number => count / 60;
const days = (count: number): number => count * 24;

// Each figure is what ts-fsrs 5.4.2 gives with the parameters in fsrs.ts, written down by hand.
describe("a card nobody has rated", () => {
  it("is New, due when it was created, with nothing remembered", () => {
    expect(newSchedule(START)).toEqual({
      fsrs_state: CARD_STATE.New,
      stability: null,
      difficulty: null,
      learning_step: 0,
      lapses: 0,
      interval_hours: 0,
      last_reviewed_at: null,
      next_review_at: START.toISOString(),
    });
  });

  it("comes back in 1 minute on Again, 6 on Hard, 10 on Good and 8 days on Easy", () => {
    const preview = previewIntervals(newSchedule(START), START);

    expect(preview[GRADE.Again]).toBeCloseTo(minutes(1), 9);
    expect(preview[GRADE.Hard]).toBeCloseTo(minutes(6), 9);
    expect(preview[GRADE.Good]).toBeCloseTo(minutes(10), 9);
    expect(preview[GRADE.Easy]).toBeCloseTo(days(8), 9);
  });

  it("starts the memory where the library does: difficulty 2.1181 on Good, 6.4133 on Again", () => {
    const good = review(newSchedule(START), GRADE.Good, START);
    const again = review(newSchedule(START), GRADE.Again, START);

    expect(good.difficulty).toBeCloseTo(2.1181, 4);
    expect(again.difficulty).toBeCloseTo(6.4133, 4);
  });
});

describe("a card answered Good each time it falls due", () => {
  it("comes back after 10 minutes, then 2, 11, 46 and 163 days", () => {
    const wanted = [minutes(10), days(2), days(11), days(46), days(163)];
    let card = newSchedule(START);
    let now = START;

    for (const hours of wanted) {
      card = review(card, GRADE.Good, now);
      expect(card.interval_hours).toBeCloseTo(hours, 9);
      expect(Date.parse(card.next_review_at) - now.getTime()).toBeCloseTo(hours * 3_600_000, 3);
      now = new Date(card.next_review_at);
    }
  });

  it("is Learning on the first step, then graduates to Review on the second Good", () => {
    const learning = review(newSchedule(START), GRADE.Good, START);
    const graduated = review(learning, GRADE.Good, new Date(learning.next_review_at));

    expect(learning).toMatchObject({ fsrs_state: CARD_STATE.Learning, learning_step: 1 });
    expect(graduated).toMatchObject({ fsrs_state: CARD_STATE.Review, learning_step: 0 });
    expect(graduated.stability).toBeGreaterThan(1);
  });

  it("answered Again at its 46-day review comes back in 10 minutes, then in 3 days on Good", () => {
    let card = newSchedule(START);
    let now = START;
    for (let rating = 0; rating < 4; rating += 1) {
      card = review(card, GRADE.Good, now);
      now = new Date(card.next_review_at);
    }
    expect(card.interval_hours).toBeCloseTo(days(46), 9);

    const lapsed = review(card, GRADE.Again, now);
    expect(lapsed).toMatchObject({ fsrs_state: CARD_STATE.Relearning, lapses: 1 });
    expect(lapsed.interval_hours).toBeCloseTo(minutes(10), 9);

    const recovered = review(lapsed, GRADE.Good, new Date(lapsed.next_review_at));
    expect(recovered).toMatchObject({ fsrs_state: CARD_STATE.Review, lapses: 1 });
    expect(recovered.interval_hours).toBeCloseTo(days(3), 9);
  });
});

// Each rating is handed the previous result as the stored card, as the drills do after a round
// trip through the tables. No loop waits for a state, so a conversion that drops a field fails on
// the assertion instead of never reaching it.
describe("a schedule read back from storage", () => {
  const rateAtDue = (card: Schedule, grade: Grade): Schedule =>
    review(card, grade, new Date(card.next_review_at));

  it("continues a learning card from its stored step: Again stays on step 0, Good moves to 1, Good graduates", () => {
    const again = review(newSchedule(START), GRADE.Again, START);
    expect(again).toMatchObject({ fsrs_state: CARD_STATE.Learning, learning_step: 0 });
    expect(again.interval_hours).toBeCloseTo(minutes(1), 9);

    const good = rateAtDue(again, GRADE.Good);
    expect(good).toMatchObject({ fsrs_state: CARD_STATE.Learning, learning_step: 1 });
    expect(good.interval_hours).toBeCloseTo(minutes(10), 9);

    const graduated = rateAtDue(good, GRADE.Good);
    expect(graduated).toMatchObject({ fsrs_state: CARD_STATE.Review, learning_step: 0 });
    expect(graduated.interval_hours).toBeCloseTo(days(1), 9);
  });

  it("builds a second lapse on the stored first one", () => {
    const first = review(newSchedule(START), GRADE.Good, START);
    const graduated = rateAtDue(first, GRADE.Good);
    expect(graduated).toMatchObject({ fsrs_state: CARD_STATE.Review, lapses: 0 });

    const lapsed = rateAtDue(graduated, GRADE.Again);
    expect(lapsed).toMatchObject({ fsrs_state: CARD_STATE.Relearning, lapses: 1 });

    const recovered = rateAtDue(lapsed, GRADE.Good);
    expect(recovered).toMatchObject({ fsrs_state: CARD_STATE.Review, lapses: 1 });

    const lapsedAgain = rateAtDue(recovered, GRADE.Again);
    expect(lapsedAgain).toMatchObject({ fsrs_state: CARD_STATE.Relearning, lapses: 2 });
  });
});

describe("the interval a button shows", () => {
  it("is the interval the grade gives, for every grade of a card in each state", () => {
    const learning = review(newSchedule(START), GRADE.Good, START);
    const reviewed = review(learning, GRADE.Good, new Date(learning.next_review_at));
    const at = new Date(reviewed.next_review_at);
    const relearning = review(reviewed, GRADE.Again, at);

    for (const [card, now] of [
      [newSchedule(START), START],
      [learning, new Date(learning.next_review_at)],
      [reviewed, at],
      [relearning, new Date(relearning.next_review_at)],
    ] as const) {
      const preview = previewIntervals(card, now);
      for (const grade of GRADES) {
        expect(preview[grade], `state ${card.fsrs_state} grade ${grade}`).toBeCloseTo(
          review(card, grade, now).interval_hours,
          9,
        );
      }
    }
  });

  it("grows with the grade on a graduated card", () => {
    const first = review(newSchedule(START), GRADE.Good, START);
    const card = review(first, GRADE.Good, new Date(first.next_review_at));
    const preview = previewIntervals(card, new Date(card.next_review_at));

    expect(preview[GRADE.Again]).toBeLessThan(preview[GRADE.Hard]);
    expect(preview[GRADE.Hard]).toBeLessThan(preview[GRADE.Good]);
    expect(preview[GRADE.Good]).toBeLessThan(preview[GRADE.Easy]);
  });
});

// A healthy card reaches 11 days in 3 ratings; the bound turns a broken schedule round trip into a
// failure instead of a loop that never ends.
const MAX_RATINGS_TO_REVIEW = 20;

// A card on its way to the given interval by Good answers, each at the instant it fell due.
function reviewedCard(intervalHours: number): Schedule {
  let card = newSchedule(START);
  let now = START;
  for (let rating = 0; card.interval_hours < intervalHours - 1e-9; rating += 1) {
    if (rating === MAX_RATINGS_TO_REVIEW) {
      throw new Error(`the card never reached Review after ${MAX_RATINGS_TO_REVIEW} Good ratings`);
    }
    card = review(card, GRADE.Good, now);
    now = new Date(card.next_review_at);
  }
  return card;
}

describe("reviewing", () => {
  it("stamps the rating's instant as the last review", () => {
    const card = review(newSchedule(START), GRADE.Good, START);

    expect(card.last_reviewed_at).toBe(START.toISOString());
  });

  it("does not change the card it was given", () => {
    const card = review(newSchedule(START), GRADE.Good, START);
    const before = structuredClone(card);

    review(card, GRADE.Easy, new Date(card.next_review_at));
    previewIntervals(card, new Date(card.next_review_at));

    expect(card).toEqual(before);
  });

  // The drills keep the schedule of a right answer that arrives early; the scheduler does not
  // know that rule, so an early review it is handed is a review like any other.
  it("moves a card that is not yet due when it is asked to: keeping it is the callers' rule", () => {
    const card = reviewedCard(days(11));
    const early = new Date(Date.parse(card.last_reviewed_at as string) + 2 * DAY_MS);

    const next = review(card, GRADE.Good, early);

    expect(early.getTime()).toBeLessThan(Date.parse(card.next_review_at));
    expect(next.next_review_at).not.toBe(card.next_review_at);
    expect(next.last_reviewed_at).toBe(early.toISOString());
  });

  it("treats a card with no last review as reviewed one interval before it is due", () => {
    const card = reviewedCard(days(11));
    const unknown: Schedule = { ...card, last_reviewed_at: null };
    const now = new Date(card.next_review_at);

    expect(review(unknown, GRADE.Good, now)).toEqual(review(card, GRADE.Good, now));
  });

  it("treats a review stamped after now, as a clock set back leaves, as happening now", () => {
    const card = reviewedCard(days(11));
    const now = new Date(Date.parse(card.last_reviewed_at as string) - 3 * DAY_MS);

    expect(() => review(card, GRADE.Good, now)).not.toThrow();
    expect(review(card, GRADE.Good, now)).toEqual(
      review({ ...card, last_reviewed_at: now.toISOString() }, GRADE.Good, now),
    );
  });
});

describe("the grade type", () => {
  it("accepts the four whole numbers from 1 to 4", () => {
    for (const grade of [1, 2, 3, 4] as const) expect(isGrade(grade)).toBe(true);
  });

  it("refuses 0 and 5, the old scale's ends, and anything that is not a whole number", () => {
    for (const value of [0, 5, 6, -1, 2.5, Number.NaN, "3", null, undefined]) {
      expect(isGrade(value), String(value)).toBe(false);
    }
  });

  it("names the grades as the tables store them", () => {
    expect(GRADE).toEqual({ Again: 1, Hard: 2, Good: 3, Easy: 4 });
    const typed: Grade[] = [...GRADES];
    expect(typed).toEqual([1, 2, 3, 4]);
  });
});

// One module owns the library, so a change of scheduler is one file. Reading the sources keeps
// that true as the code grows, and keeps the pin the lockfile has from drifting to a range.
describe("the scheduler dependency", () => {
  const serverDir = new URL("../../", import.meta.url);

  function importersOfLibrary(): string[] {
    return ["src", "test"]
      .flatMap((dir) =>
        readdirSync(new URL(`${dir}/`, serverDir), { recursive: true, encoding: "utf8" })
          .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
          .map((file) => `${dir}/${file}`),
      )
      .filter((file) =>
        /(from\s+|import\(\s*)["']ts-fsrs["']/.test(readFileSync(new URL(file, serverDir), "utf8")),
      )
      .sort();
  }

  it("is imported by src/srs/fsrs.ts alone", () => {
    expect(importersOfLibrary()).toEqual(["src/srs/fsrs.ts"]);
  });

  it("is pinned to exactly 5.4.2", () => {
    const manifest = JSON.parse(readFileSync(new URL("package.json", serverDir), "utf8")) as {
      dependencies: Record<string, string>;
    };

    expect(manifest.dependencies["ts-fsrs"]).toBe("5.4.2");
  });

  it("has replaced the ladder: sm2.ts and its test are gone", () => {
    expect(existsSync(new URL("src/srs/sm2.ts", serverDir))).toBe(false);
    expect(existsSync(new URL("src/srs/sm2.test.ts", serverDir))).toBe(false);
  });
});
