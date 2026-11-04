import type { Database } from "better-sqlite3";
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
  easeFactor: number;
  repetitions: number;
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
  ease_factor: number;
  repetitions: number;
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
    easeFactor: row.ease_factor,
    repetitions: row.repetitions,
  };
}

// A new card is due the moment it is created, so it shows in the next training session.
// Returns null when the move already has a card; a teaching card has no move and never conflicts.
export function insertCard(db: Database, card: NewCard): CardRecord | null {
  const row = db
    .prepare(
      `INSERT INTO srs_cards (source_kind, source_game_id, source_move_id, prompt_fen, student_color,
         played_uci, expected_uci, cp_loss, classification, explanation, created_at, next_review_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_move_id) DO NOTHING RETURNING *`,
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
