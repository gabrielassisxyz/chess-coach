import { describe, expect, it } from "vitest";
import { dueAt, newSchedule, type Quality, review } from "./sm2.js";

// Every row is hand-computed from the rules, not read back from the function.
const TABLE: { q: Quality; interval: number; ease: number; reps: number; note: string }[] = [
  { q: 5, interval: 4, ease: 2.6, reps: 1, note: "first success, first rung" },
  { q: 4, interval: 24, ease: 2.6, reps: 2, note: "quality 4 leaves ease alone" },
  { q: 5, interval: 72, ease: 2.7, reps: 3, note: "third rung" },
  { q: 2, interval: 4, ease: 2.38, reps: 0, note: "reset after three successes" },
  { q: 4, interval: 4, ease: 2.38, reps: 1, note: "climbs again from the bottom" },
  { q: 3, interval: 24, ease: 2.24, reps: 2, note: "bare pass costs 0.14 ease" },
  { q: 5, interval: 72, ease: 2.34, reps: 3, note: "ease recovers" },
  { q: 5, interval: 168, ease: 2.44, reps: 4, note: "fourth rung" },
  { q: 4, interval: 336, ease: 2.44, reps: 5, note: "fifth rung" },
  { q: 4, interval: 720, ease: 2.44, reps: 6, note: "last rung" },
  { q: 4, interval: 1756.8, ease: 2.44, reps: 7, note: "first multiplication: 720 * 2.44" },
  { q: 0, interval: 4, ease: 1.64, reps: 0, note: "blackout resets and costs 0.8" },
  { q: 0, interval: 4, ease: 1.3, reps: 0, note: "ease stops at the floor" },
];

describe("sm2 worked examples", () => {
  it("starts a card due now with the default ease", () => {
    expect(newSchedule()).toEqual({ interval_hours: 0, ease_factor: 2.5, repetitions: 0 });
  });

  it("follows the table step by step", () => {
    let card = newSchedule();
    for (const row of TABLE) {
      card = review(card, row.q);
      const label = `q=${row.q} (${row.note})`;
      expect(card.interval_hours, label).toBeCloseTo(row.interval, 6);
      expect(card.ease_factor, label).toBeCloseTo(row.ease, 6);
      expect(card.repetitions, label).toBe(row.reps);
    }
  });

  it("does not mutate the card it was given", () => {
    const card = newSchedule();
    review(card, 5);
    expect(card).toEqual(newSchedule());
  });

  it("schedules the next review from the clock it is handed", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    expect(dueAt(at, 24).toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });
});
