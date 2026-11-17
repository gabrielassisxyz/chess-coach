import { GRADE, type Grade, newSchedule, review, type Schedule } from "../srs/fsrs.js";
import { insertDrillReview } from "./drill-reviews.js";
import type { Database } from "./open.js";

/** The review schedule of one position from the student's games, as `found_cards` keeps it. */
export interface FoundCardSchedule extends Schedule {
  position_id: string;
  introduced_at: string;
  reviews: number;
}

export function findFoundCard(db: Database, positionId: string): FoundCardSchedule | undefined {
  return db
    .prepare(
      `SELECT position_id, fsrs_state, stability, difficulty, learning_step, lapses, interval_hours,
              next_review_at, introduced_at, reviews, last_reviewed_at
       FROM found_cards WHERE position_id = ?`,
    )
    .get(positionId) as FoundCardSchedule | undefined;
}

/**
 * Rates a position by how the first attempt at it went: Good for a right one, Again for anything
 * else. A position never rated gets its card now, from that rating; a right attempt on a card that
 * is not yet due keeps its schedule, so drilling early earns no longer interval; anything else is
 * a review for the scheduler and a row in the log of drill reviews.
 */
export function rateFoundCard(db: Database, positionId: string, right: boolean, now: Date): void {
  const card = findFoundCard(db, positionId);
  if (card && right && Date.parse(card.next_review_at) > now.getTime()) return;
  const grade: Grade = right ? GRADE.Good : GRADE.Again;
  const schedule = review(card ?? newSchedule(now), grade, now);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO found_cards (position_id, fsrs_state, stability, difficulty, learning_step, lapses,
         interval_hours, next_review_at, introduced_at, reviews, last_reviewed_at)
       VALUES (@positionId, @fsrs_state, @stability, @difficulty, @learning_step, @lapses,
         @interval_hours, @next_review_at, @last_reviewed_at, 1, @last_reviewed_at)
       ON CONFLICT (position_id) DO UPDATE SET fsrs_state = excluded.fsrs_state,
         stability = excluded.stability, difficulty = excluded.difficulty,
         learning_step = excluded.learning_step, lapses = excluded.lapses,
         interval_hours = excluded.interval_hours, next_review_at = excluded.next_review_at,
         reviews = reviews + 1, last_reviewed_at = excluded.last_reviewed_at`,
    ).run({ positionId, ...schedule });
    insertDrillReview(db, {
      cardKind: "found",
      cardKey: positionId,
      reviewedAt: now.toISOString(),
      grade,
    });
  })();
}
