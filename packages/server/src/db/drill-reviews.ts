import type { Grade } from "../srs/fsrs.js";
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
