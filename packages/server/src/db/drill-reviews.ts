import { GRADE, type Grade } from "../srs/fsrs.js";
import type { Database } from "./open.js";

export type DrillCardKind = "repertoire" | "found";

/**
 * The key a repertoire card's reviews are logged under. A position key holds spaces itself, so the
 * move is the last word; a found card is logged under its position id.
 */
export const repertoireCardKey = (move: { positionKey: string; uci: string }): string =>
  `${move.positionKey} ${move.uci}`;

/**
 * One rating of a repertoire or found card. The card tables keep only the schedule a card has now;
 * fitting FSRS's parameters to the student needs every rating, so each one leaves a row. It has no
 * foreign key, so a card or a unit that is deleted keeps its history.
 */
export function insertDrillReview(
  db: Database,
  review: { cardKind: DrillCardKind; cardKey: string; reviewedAt: string; grade: Grade },
): void {
  db.prepare(
    `INSERT INTO drill_reviews (card_kind, card_key, reviewed_at, grade)
     VALUES (@cardKind, @cardKey, @reviewedAt, @grade)`,
  ).run(review);
}

/** The window a count of misses reads: ratings after `after` and up to and including `upTo`. */
export interface RepertoireMissWindow {
  after: Date;
  upTo: Date;
}

/**
 * How many times each repertoire card was missed in the window, by the key `repertoireCardKey`
 * gives; a card never missed in it is absent. A miss is a rating of Again, which is every wrong
 * try, hint and shown solution. One read of the log answers every card, so a listing of every
 * variation asks it once. Ratings are written by `toISOString`, so comparing the text compares the
 * moments; a rating exactly at `after` is outside the window, one at `upTo` inside, as in the
 * window of the first attempts.
 */
export function countRepertoireMisses(
  db: Database,
  window: RepertoireMissWindow,
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT card_key, COUNT(*) AS misses FROM drill_reviews
       WHERE card_kind = 'repertoire' AND grade = ? AND reviewed_at > ? AND reviewed_at <= ?
       GROUP BY card_key`,
    )
    .all(GRADE.Again, window.after.toISOString(), window.upTo.toISOString()) as {
    card_key: string;
    misses: number;
  }[];
  return new Map(rows.map((row) => [row.card_key, row.misses]));
}
