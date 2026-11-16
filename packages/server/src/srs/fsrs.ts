import {
  type Card,
  default_w,
  fsrs,
  generatorParameters,
  type Grade as LibraryGrade,
  type State,
} from "ts-fsrs";

/** FSRS's four grades as the tables store them: 1 Again, 2 Hard, 3 Good, 4 Easy. */
export type Grade = 1 | 2 | 3 | 4;

export const GRADE = { Again: 1, Hard: 2, Good: 3, Easy: 4 } as const satisfies Record<
  string,
  Grade
>;

export const GRADES: readonly Grade[] = [GRADE.Again, GRADE.Hard, GRADE.Good, GRADE.Easy];

export const isGrade = (value: unknown): value is Grade =>
  typeof value === "number" && GRADES.includes(value as Grade);

/** Where a card stands: never rated, being learned, graduated, or being learned again after a lapse. */
export type CardState = 0 | 1 | 2 | 3;

export const CARD_STATE = {
  New: 0,
  Learning: 1,
  Review: 2,
  Relearning: 3,
} as const satisfies Record<string, CardState>;

/**
 * What the card tables keep for the scheduler, column for column. `interval_hours` is the interval
 * the last rating scheduled, a fraction for a step in minutes, and `next_review_at` is that
 * rating's instant plus the interval.
 */
export interface Schedule {
  fsrs_state: CardState;
  stability: number | null;
  difficulty: number | null;
  learning_step: number;
  lapses: number;
  interval_hours: number;
  last_reviewed_at: string | null;
  next_review_at: string;
}

const MS_PER_HOUR = 3_600_000;

// The library's defaults, written out so that an upgrade cannot move the schedule unseen. Fuzz is
// off because it only spreads piles of thousands of cards, and without it the interval a button
// shows is the interval the card gets. The steps are Anki's.
const scheduler = fsrs(
  generatorParameters({
    w: default_w,
    request_retention: 0.9,
    maximum_interval: 36_500,
    enable_fuzz: false,
    enable_short_term: true,
    learning_steps: ["1m", "10m"],
    relearning_steps: ["10m"],
  }),
);

/** A card nobody has rated: due at `at`, with nothing remembered yet. */
export function newSchedule(at: Date): Schedule {
  return {
    fsrs_state: CARD_STATE.New,
    stability: null,
    difficulty: null,
    learning_step: 0,
    lapses: 0,
    interval_hours: 0,
    last_reviewed_at: null,
    next_review_at: at.toISOString(),
  };
}

// A card whose last review is unknown (one imported with its schedule and no history) was last
// reviewed one interval before it is due. A review stamped after `now`, which a clock set back
// leaves, counts as happening now: the library refuses a negative elapsed time.
function lastReviewOf(card: Schedule, now: Date): Date | undefined {
  if (card.fsrs_state === CARD_STATE.New) return undefined;
  const last =
    card.last_reviewed_at === null
      ? Date.parse(card.next_review_at) - card.interval_hours * MS_PER_HOUR
      : Date.parse(card.last_reviewed_at);
  return new Date(Math.min(last, now.getTime()));
}

function toLibraryCard(card: Schedule, now: Date): Card {
  const stored: Card = {
    due: new Date(card.next_review_at),
    stability: card.stability ?? 0,
    difficulty: card.difficulty ?? 0,
    elapsed_days: 0,
    scheduled_days: Math.round(card.interval_hours / 24),
    learning_steps: card.learning_step,
    reps: 0,
    lapses: card.lapses,
    state: card.fsrs_state as State,
  };
  const last = lastReviewOf(card, now);
  return last === undefined ? stored : { ...stored, last_review: last };
}

const hoursBetween = (from: Date, to: Date): number =>
  (to.getTime() - from.getTime()) / MS_PER_HOUR;

function fromLibraryCard(card: Card, now: Date): Schedule {
  return {
    fsrs_state: card.state as CardState,
    stability: card.stability,
    difficulty: card.difficulty,
    learning_step: card.learning_steps,
    lapses: card.lapses,
    interval_hours: hoursBetween(now, card.due),
    last_reviewed_at: now.toISOString(),
    next_review_at: card.due.toISOString(),
  };
}

/**
 * The schedule a card gets when it is rated `grade` at `now`. A right answer on a card that is not
 * yet due is not special here: the drills keep such a card's schedule themselves, before they call.
 */
export function review(card: Schedule, grade: Grade, now: Date): Schedule {
  return fromLibraryCard(
    scheduler.next(toLibraryCard(card, now), now, grade as LibraryGrade).card,
    now,
  );
}

/** Hours until the card is due again for each grade, exactly as `review` would set them. */
export function previewIntervals(card: Schedule, now: Date): Record<Grade, number> {
  const preview = scheduler.repeat(toLibraryCard(card, now), now);
  const hours = (grade: Grade): number =>
    hoursBetween(now, preview[grade as LibraryGrade].card.due);
  return {
    [GRADE.Again]: hours(GRADE.Again),
    [GRADE.Hard]: hours(GRADE.Hard),
    [GRADE.Good]: hours(GRADE.Good),
    [GRADE.Easy]: hours(GRADE.Easy),
  };
}
