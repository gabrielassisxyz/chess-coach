import type { Database } from "better-sqlite3";
import type { CardState, Grade, Schedule } from "../srs/fsrs.js";
import type { PlayerColor } from "./games.js";

export interface CardRecord {
  id: number;
  sourceKind: "game_move" | "teaching";
  sourceGameId: number | null;
  sourceMoveId: number | null;
  promptFen: string;
  studentColor: PlayerColor;
  playedUci: string | null;
  expectedUci: string;
  cpLoss: number | null;
  classification: string | null;
  explanation: string | null;
  createdAt: string;
  nextReviewAt: string;
  intervalHours: number;
  fsrsState: CardState;
  stability: number | null;
  difficulty: number | null;
  learningStep: number;
  lapses: number;
  lastReviewedAt: string | null;
  /** The puzzle the card was born from; no foreign key, so it can name a puzzle that is gone. */
  puzzleId: string | null;
}

export interface NewCard {
  sourceKind: "game_move" | "teaching";
  sourceGameId: number | null;
  sourceMoveId: number | null;
  promptFen: string;
  studentColor: PlayerColor;
  playedUci: string | null;
  expectedUci: string;
  cpLoss: number | null;
  classification: string | null;
  explanation: string | null;
  createdAt: string;
  /** The puzzle a teaching card was born from; at most one card exists per puzzle. */
  puzzleId?: string | null;
}

interface CardRow {
  id: number;
  source_kind: "game_move" | "teaching";
  source_game_id: number | null;
  source_move_id: number | null;
  prompt_fen: string;
  student_color: PlayerColor;
  played_uci: string | null;
  expected_uci: string;
  cp_loss: number | null;
  classification: string | null;
  explanation: string | null;
  created_at: string;
  next_review_at: string;
  interval_hours: number;
  fsrs_state: CardState;
  stability: number | null;
  difficulty: number | null;
  learning_step: number;
  lapses: number;
  last_reviewed_at: string | null;
  puzzle_id: string | null;
}

function toCard(row: CardRow): CardRecord {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceGameId: row.source_game_id,
    sourceMoveId: row.source_move_id,
    promptFen: row.prompt_fen,
    studentColor: row.student_color,
    playedUci: row.played_uci,
    expectedUci: row.expected_uci,
    cpLoss: row.cp_loss,
    classification: row.classification,
    explanation: row.explanation,
    createdAt: row.created_at,
    nextReviewAt: row.next_review_at,
    intervalHours: row.interval_hours,
    fsrsState: row.fsrs_state,
    stability: row.stability,
    difficulty: row.difficulty,
    learningStep: row.learning_step,
    lapses: row.lapses,
    lastReviewedAt: row.last_reviewed_at,
    puzzleId: row.puzzle_id,
  };
}

/** The columns the scheduler reads and writes, as one object. */
export function scheduleOf(card: CardRecord): Schedule {
  return {
    fsrs_state: card.fsrsState,
    stability: card.stability,
    difficulty: card.difficulty,
    learning_step: card.learningStep,
    lapses: card.lapses,
    interval_hours: card.intervalHours,
    last_reviewed_at: card.lastReviewedAt,
    next_review_at: card.nextReviewAt,
  };
}

// A new card is due the moment it is created, so it shows in the next training session.
// Returns null when the move or the puzzle already has a card; any other teaching card never conflicts.
export function insertCard(db: Database, card: NewCard): CardRecord | null {
  const row = db
    .prepare(
      `INSERT INTO srs_cards (source_kind, source_game_id, source_move_id, prompt_fen, student_color,
         played_uci, expected_uci, cp_loss, classification, explanation, created_at, next_review_at, puzzle_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING *`,
    )
    .get(
      card.sourceKind,
      card.sourceGameId,
      card.sourceMoveId,
      card.promptFen,
      card.studentColor,
      card.playedUci,
      card.expectedUci,
      card.cpLoss,
      card.classification,
      card.explanation,
      card.createdAt,
      card.createdAt,
      card.puzzleId ?? null,
    );
  return row ? toCard(row as CardRow) : null;
}

export function getCard(db: Database, id: number): CardRecord | undefined {
  const row = db.prepare("SELECT * FROM srs_cards WHERE id = ?").get(id);
  return row ? toCard(row as CardRow) : undefined;
}

export function setExplanation(db: Database, id: number, explanation: string): boolean {
  return (
    db.prepare("UPDATE srs_cards SET explanation = ? WHERE id = ?").run(explanation, id).changes ===
    1
  );
}

export function listCardsNewestFirst(db: Database, limit: number): CardRecord[] {
  const rows = db.prepare("SELECT * FROM srs_cards ORDER BY id DESC LIMIT ?").all(limit);
  return (rows as CardRow[]).map(toCard);
}

export function findCardIdByMove(db: Database, moveId: number): number | null {
  const row = db.prepare("SELECT id FROM srs_cards WHERE source_move_id = ?").get(moveId);
  return row ? (row as { id: number }).id : null;
}

export const DEFAULT_DUE_LIMIT = 20;
export const MAX_DUE_LIMIT = 100;

export function listDueCards(
  db: Database,
  now: Date,
  limit: number = DEFAULT_DUE_LIMIT,
): CardRecord[] {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), MAX_DUE_LIMIT);
  const rows = db
    .prepare(
      "SELECT * FROM srs_cards WHERE next_review_at <= ? ORDER BY next_review_at, id LIMIT ?",
    )
    .all(now.toISOString(), capped);
  return (rows as CardRow[]).map(toCard);
}

export interface NewReview {
  cardId: number;
  reviewedAt: string;
  grade: Grade;
  answeredUci: string;
  correct: boolean;
}

// `quality`, the old 0 to 5 scale, stays NULL: only the rows written before the grades have one.
export function insertReview(db: Database, review: NewReview): void {
  db.prepare(
    `INSERT INTO srs_reviews (card_id, reviewed_at, grade, answered_uci, correct)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(review.cardId, review.reviewedAt, review.grade, review.answeredUci, review.correct ? 1 : 0);
}

export function updateSchedule(db: Database, id: number, schedule: Schedule): void {
  db.prepare(
    `UPDATE srs_cards SET fsrs_state = @fsrs_state, stability = @stability, difficulty = @difficulty,
       learning_step = @learning_step, lapses = @lapses, interval_hours = @interval_hours,
       last_reviewed_at = @last_reviewed_at, next_review_at = @next_review_at
     WHERE id = @id`,
  ).run({ ...schedule, id });
}
