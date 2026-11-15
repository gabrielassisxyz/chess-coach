import {
  dueAt,
  newSchedule,
  type Quality,
  review as reviewSchedule,
  type Schedule,
} from "../srs/sm2.js";
import type { Database } from "./open.js";

/** The review schedule of one position from the student's games, as `found_cards` keeps it. */
export interface FoundCardSchedule extends Schedule {
  position_id: string;
  next_review_at: string;
  introduced_at: string;
  reviews: number;
  last_reviewed_at: string | null;
}

export function findFoundCard(db: Database, positionId: string): FoundCardSchedule | undefined {
  return db
    .prepare(
      `SELECT position_id, interval_hours, ease_factor, repetitions, next_review_at, introduced_at,
              reviews, last_reviewed_at
       FROM found_cards WHERE position_id = ?`,
    )
    .get(positionId) as FoundCardSchedule | undefined;
}

// The qualities the line drill's first try carries, so a position rates as a stored move does.
const FOUND_PASS_QUALITY: Quality = 4;
const FOUND_FAIL_QUALITY: Quality = 2;

/**
 * Rates a position by how the first attempt at it went. A position never rated gets its card now,
 * from that rating; a right attempt on a card that is not yet due keeps its schedule, so drilling
 * early earns no longer interval; anything else moves the card along the SM-2 ladder.
 */
export function rateFoundCard(db: Database, positionId: string, right: boolean, now: Date): void {
  const card = findFoundCard(db, positionId);
  if (card && right && Date.parse(card.next_review_at) > now.getTime()) return;
  const schedule = reviewSchedule(
    card ?? newSchedule(),
    right ? FOUND_PASS_QUALITY : FOUND_FAIL_QUALITY,
  );
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO found_cards (position_id, interval_hours, ease_factor, repetitions, next_review_at,
       introduced_at, reviews, last_reviewed_at)
     VALUES (@positionId, @interval, @ease, @repetitions, @nextReviewAt, @at, 1, @at)
     ON CONFLICT (position_id) DO UPDATE SET interval_hours = excluded.interval_hours,
       ease_factor = excluded.ease_factor, repetitions = excluded.repetitions,
       next_review_at = excluded.next_review_at, reviews = reviews + 1,
       last_reviewed_at = excluded.last_reviewed_at`,
  ).run({
    positionId,
    interval: schedule.interval_hours,
    ease: schedule.ease_factor,
    repetitions: schedule.repetitions,
    nextReviewAt: dueAt(now, schedule.interval_hours).toISOString(),
    at,
  });
}
