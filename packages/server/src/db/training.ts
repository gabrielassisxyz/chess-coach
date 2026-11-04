import type { Database } from "./open.js";

export type ExplorationKind = "move" | "undo" | "reset";

export interface NewTrainingItem {
  kind: "card" | "puzzle";
  cardId: number | null;
  puzzleId: string | null;
  exposureId: string | null;
  servedAt: string;
}

export function openTrainingItem(db: Database, item: NewTrainingItem): number {
  const row = db
    .prepare(
      `INSERT INTO training_items (kind, card_id, puzzle_id, exposure_id, served_at)
       VALUES (@kind, @cardId, @puzzleId, @exposureId, @servedAt) RETURNING id`,
    )
    .get(item) as { id: number };
  return row.id;
}

export function closeTrainingItem(
  db: Database,
  itemId: number,
  result: { answeredAt: string; answerUci: string; correct: boolean },
): void {
  db.prepare(
    `UPDATE training_items SET answered_at = ?, answer_uci = ?, correct = ? WHERE id = ?`,
  ).run(result.answeredAt, result.answerUci, result.correct ? 1 : 0, itemId);
}

export function insertExplorationEvent(
  db: Database,
  event: {
    itemId: number;
    seq: number;
    atMs: number;
    kind: ExplorationKind;
    uci: string | null;
    fenAfter: string;
  },
): void {
  db.prepare(
    `INSERT INTO exploration_events (item_id, seq, at_ms, kind, uci, fen_after)
     VALUES (@itemId, @seq, @atMs, @kind, @uci, @fenAfter)`,
  ).run(event);
}

export function linkItemMessage(db: Database, itemId: number, messageId: number): void {
  db.prepare("INSERT OR IGNORE INTO item_messages (item_id, message_id) VALUES (?, ?)").run(
    itemId,
    messageId,
  );
}

// Verbatim, in the order the student typed them.
export function listItemMessageTexts(db: Database, itemId: number): string[] {
  const rows = db
    .prepare(
      `SELECT m.content_json FROM item_messages l
       JOIN chat_messages m ON m.id = l.message_id
       WHERE l.item_id = ? ORDER BY m.id ASC`,
    )
    .all(itemId) as { content_json: string }[];
  return rows.map((row) => (JSON.parse(row.content_json) as { text: string }).text);
}

/**
 * Adds fields to the newest undelivered notification of a type for one card. The review desk
 * writes the srs_answer row itself, so the reasoning is merged into it before the coach is woken.
 */
export function amendPendingNotification(
  db: Database,
  match: { sessionId: number; type: string; cardId: number },
  patch: Record<string, unknown>,
): boolean {
  const row = db
    .prepare(
      `SELECT id, content_json FROM chat_messages
       WHERE coach_session_id = ? AND kind = 'notification' AND delivered = 0
         AND json_extract(content_json, '$.type') = ?
         AND json_extract(content_json, '$.card_id') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(match.sessionId, match.type, match.cardId) as
    | { id: number; content_json: string }
    | undefined;
  if (!row) return false;
  const merged = { ...(JSON.parse(row.content_json) as object), ...patch };
  db.prepare("UPDATE chat_messages SET content_json = ? WHERE id = ?").run(
    JSON.stringify(merged),
    row.id,
  );
  return true;
}
