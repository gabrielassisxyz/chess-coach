import { dueAt, type Quality, review as reviewSchedule, type Schedule } from "../srs/sm2.js";
import type { Database } from "./open.js";
import type { RepertoireRow } from "./repertoires.js";

/** The review schedule of one move in one position, shared by every variation that plays it. */
export interface RepertoireCardSchedule extends Schedule {
  id: number;
  introduced_at: string;
  next_review_at: string;
  reviews: number;
  last_reviewed_at: string | null;
}

/** A move the student plays in a variation, with its schedule; `card` is null for a new move. */
export interface RepertoireDrillMove {
  rowId: number;
  positionKey: string;
  /** The half-move about to be played, counted from 1. */
  ply: number;
  /** The SAN moves from the starting position to this one, along the likeliest line. */
  line: string[];
  uci: string;
  san: string;
  reach: number;
  openingName: string | null;
  idea: string | null;
  card: RepertoireCardSchedule | null;
}

interface RepertoireDrillMoveDbRow {
  row_id: number;
  position_key: string;
  ply: number;
  line_san: string;
  move_uci: string;
  move_san: string;
  reach: number;
  opening_name: string | null;
  idea: string | null;
  card_id: number | null;
  introduced_at: string | null;
  next_review_at: string | null;
  interval_hours: number | null;
  ease_factor: number | null;
  repetitions: number | null;
  reviews: number | null;
  last_reviewed_at: string | null;
}

function drillMoveOf(row: RepertoireDrillMoveDbRow): RepertoireDrillMove {
  const card: RepertoireCardSchedule | null =
    row.card_id === null
      ? null
      : {
          id: row.card_id,
          introduced_at: row.introduced_at as string,
          next_review_at: row.next_review_at as string,
          interval_hours: row.interval_hours as number,
          ease_factor: row.ease_factor as number,
          repetitions: row.repetitions as number,
          reviews: row.reviews as number,
          last_reviewed_at: row.last_reviewed_at,
        };
  return {
    rowId: row.row_id,
    positionKey: row.position_key,
    ply: row.ply,
    line: JSON.parse(row.line_san) as string[],
    uci: row.move_uci,
    san: row.move_san,
    reach: row.reach,
    openingName: row.opening_name,
    idea: row.idea,
    card,
  };
}

/** Every move the student plays in one variation, each with the card it shares across variations. */
export function listRepertoireDrillMoves(
  db: Database,
  repertoireId: number,
): RepertoireDrillMove[] {
  const rows = db
    .prepare(
      `SELECT p.id AS row_id, p.position_key, p.ply, p.line_san, p.move_uci, p.move_san, p.reach,
              p.opening_name, p.idea, c.id AS card_id, c.introduced_at, c.next_review_at,
              c.interval_hours, c.ease_factor, c.repetitions, c.reviews, c.last_reviewed_at
       FROM repertoire_positions p
       LEFT JOIN repertoire_cards c
         ON c.position_key = p.position_key AND c.move_uci = p.move_uci
       WHERE p.repertoire_id = ? AND p.kind = 'own'
       ORDER BY p.id`,
    )
    .all(repertoireId) as RepertoireDrillMoveDbRow[];
  return rows.map(drillMoveOf);
}

export function findDrillRepertoire(db: Database, repertoireId: number): RepertoireRow | undefined {
  return db
    .prepare("SELECT id, side, group_name, variation_name FROM repertoires WHERE id = ?")
    .get(repertoireId) as RepertoireRow | undefined;
}

export function listDrillRepertoires(db: Database): RepertoireRow[] {
  return db
    .prepare("SELECT id, side, group_name, variation_name FROM repertoires ORDER BY id")
    .all() as RepertoireRow[];
}

// Showing a move with its answer is what makes it known, so the row is due from that moment and
// its first rating comes on a later pass. A move already known keeps its row.
export function introduceRepertoireCard(
  db: Database,
  move: { positionKey: string; uci: string },
  at: string,
): void {
  db.prepare(
    `INSERT INTO repertoire_cards (position_key, move_uci, introduced_at, next_review_at)
     VALUES (?, ?, ?, ?) ON CONFLICT (position_key, move_uci) DO NOTHING`,
  ).run(move.positionKey, move.uci, at, at);
}

/** What a rebuild did to the cards of the White moves it replaced. */
export interface RepertoireCardSweep {
  /** Cards whose position and move some variation still stores, history and all. */
  kept: number;
  /** Cards whose position and move no variation stores any more. */
  deleted: number;
}

/**
 * A card is shared by every variation that plays its move in its position, so it is kept while any
 * variation still stores that White move, and deleted once none does: the drill would otherwise
 * keep asking for a move nothing expects.
 */
export function deleteRepertoireCardsNoVariationPlays(
  db: Database,
  moves: ReadonlyArray<{ positionKey: string; uci: string }>,
): RepertoireCardSweep {
  const played = db.prepare(
    `SELECT 1 FROM repertoire_positions
     WHERE kind = 'own' AND position_key = ? AND move_uci = ? LIMIT 1`,
  );
  const held = db.prepare("SELECT 1 FROM repertoire_cards WHERE position_key = ? AND move_uci = ?");
  const remove = db.prepare("DELETE FROM repertoire_cards WHERE position_key = ? AND move_uci = ?");
  const sweep: RepertoireCardSweep = { kept: 0, deleted: 0 };
  for (const move of moves) {
    if (played.get(move.positionKey, move.uci) === undefined) {
      sweep.deleted += remove.run(move.positionKey, move.uci).changes;
    } else if (held.get(move.positionKey, move.uci) !== undefined) {
      sweep.kept += 1;
    }
  }
  return sweep;
}

/** How many cards were first shown after `since` (an ISO time), in any variation and any drill. */
export function countRepertoireCardsIntroducedSince(db: Database, since: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS introduced FROM repertoire_cards WHERE introduced_at > ?")
    .get(since) as { introduced: number };
  return row.introduced;
}

export function findRepertoireCard(
  db: Database,
  move: { positionKey: string; uci: string },
): RepertoireCardSchedule | undefined {
  return db
    .prepare(
      `SELECT id, introduced_at, next_review_at, interval_hours, ease_factor, repetitions, reviews,
              last_reviewed_at
       FROM repertoire_cards WHERE position_key = ? AND move_uci = ?`,
    )
    .get(move.positionKey, move.uci) as RepertoireCardSchedule | undefined;
}

export function saveRepertoireCardReview(
  db: Database,
  cardId: number,
  review: { schedule: Schedule; nextReviewAt: string; reviewedAt: string },
): void {
  db.prepare(
    `UPDATE repertoire_cards
     SET interval_hours = ?, ease_factor = ?, repetitions = ?, next_review_at = ?,
         last_reviewed_at = ?, reviews = reviews + 1
     WHERE id = ?`,
  ).run(
    review.schedule.interval_hours,
    review.schedule.ease_factor,
    review.schedule.repetitions,
    review.nextReviewAt,
    review.reviewedAt,
    cardId,
  );
}

// The qualities a drill's first try carries, so a move rates the same whichever way it was played.
const GAME_PASS_QUALITY: Quality = 4;
const GAME_FAIL_QUALITY: Quality = 2;

/**
 * Rates a repertoire move that a played game either got right or missed, by the rule a drill's
 * first try follows: a move never shown gets its card now, a right move that is not yet due keeps
 * its schedule so playing it often earns no longer interval, and anything else moves the card
 * along the SM-2 ladder.
 */
export function rateRepertoireCardFromGame(
  db: Database,
  move: { positionKey: string; uci: string },
  right: boolean,
  now: Date,
): void {
  introduceRepertoireCard(db, move, now.toISOString());
  const card = findRepertoireCard(db, move) as RepertoireCardSchedule;
  if (right && Date.parse(card.next_review_at) > now.getTime()) return;
  const schedule = reviewSchedule(card, right ? GAME_PASS_QUALITY : GAME_FAIL_QUALITY);
  saveRepertoireCardReview(db, card.id, {
    schedule,
    nextReviewAt: dueAt(now, schedule.interval_hours).toISOString(),
    reviewedAt: now.toISOString(),
  });
}
