import type { Database } from "./open.js";

export type ExplorationKind = "move" | "undo" | "reset";

export interface NewTrainingItem {
  kind: "card" | "puzzle" | "repertoire";
  cardId: number | null;
  puzzleId: string | null;
  exposureId: string | null;
  servedAt: string;
  runId?: number | null;
}

export function openTrainingItem(db: Database, item: NewTrainingItem): number {
  const row = db
    .prepare(
      `INSERT INTO training_items (kind, card_id, puzzle_id, exposure_id, served_at, run_id)
       VALUES (@kind, @cardId, @puzzleId, @exposureId, @servedAt, @runId) RETURNING id`,
    )
    .get({ ...item, runId: item.runId ?? null }) as { id: number };
  return row.id;
}

export function closeTrainingItem(
  db: Database,
  itemId: number,
  result: { answeredAt: string; answerUci: string | null; correct: boolean },
): void {
  db.prepare(
    `UPDATE training_items SET answered_at = ?, answer_uci = ?, correct = ? WHERE id = ?`,
  ).run(result.answeredAt, result.answerUci, result.correct ? 1 : 0, itemId);
}

// A hint marks the piece that should move; the ledger keeps it so a hinted solve never counts
// as solved first try.
export function setTrainingItemHinted(db: Database, itemId: number): void {
  db.prepare(`UPDATE training_items SET hinted = 1 WHERE id = ?`).run(itemId);
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

export interface TrainingTry {
  seq: number;
  atMs: number;
  ply: number;
  uci: string;
  correct: boolean;
}

export function insertTrainingTry(db: Database, itemId: number, attempt: TrainingTry): void {
  db.prepare(
    `INSERT INTO training_tries (item_id, seq, at_ms, ply, uci, correct)
     VALUES (@itemId, @seq, @atMs, @ply, @uci, @correct)`,
  ).run({ ...attempt, itemId, correct: attempt.correct ? 1 : 0 });
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

// `discarded` is written only for a run a repertoire unit's delete ends; the older rows with it come
// from when a paused run could be discarded.
export type RunEndReason = "finished" | "ended" | "discarded" | "replaced" | "left";

export interface StoredRunItem {
  kind: "card" | "puzzle" | "repertoire";
  id: number | string;
}

export type ItemOutcome = "solved" | "failed";

export interface TrainingRunRow {
  id: number;
  mode: "srs" | "puzzles" | "openings" | "repertoire";
  motif: string | null;
  color: "white" | "black" | null;
  size: number;
  items: StoredRunItem[];
  position: number;
  solved: number;
  failed: number;
  // One entry per answered item, in queue order.
  outcomes: ItemOutcome[];
  currentJson: string;
  startedAt: string;
  updatedAt: string;
}

export interface RunProgress {
  position: number;
  solved: number;
  failed: number;
  outcomes: ItemOutcome[];
  currentJson: string;
  updatedAt: string;
}

export function insertTrainingRun(
  db: Database,
  run: Omit<TrainingRunRow, "id" | "updatedAt">,
): number {
  const row = db
    .prepare(
      `INSERT INTO training_runs (mode, motif, color, size, items_json, position, solved, failed,
         outcomes_json, current_json, started_at, updated_at)
       VALUES (@mode, @motif, @color, @size, @itemsJson, @position, @solved, @failed,
         @outcomesJson, @currentJson, @startedAt, @startedAt) RETURNING id`,
    )
    .get({
      mode: run.mode,
      motif: run.motif,
      color: run.color,
      size: run.size,
      itemsJson: JSON.stringify(run.items),
      position: run.position,
      solved: run.solved,
      failed: run.failed,
      outcomesJson: JSON.stringify(run.outcomes),
      currentJson: run.currentJson,
      startedAt: run.startedAt,
    }) as { id: number };
  return row.id;
}

// Only an open run is written. A step that completes after its run ended, such as a try that waited
// on the engine while the board moved on, finds the row closed and leaves it as the record of where
// the run stopped. The step that finishes a run closes it before its own save, so that last save is
// dropped too; the answers that led to it were saved by their own steps.
export function saveTrainingRun(db: Database, runId: number, progress: RunProgress): void {
  db.prepare(
    `UPDATE training_runs SET position = @position, solved = @solved, failed = @failed,
       outcomes_json = @outcomesJson, current_json = @currentJson, updated_at = @updatedAt
     WHERE id = @runId AND ended_at IS NULL`,
  ).run({
    position: progress.position,
    solved: progress.solved,
    failed: progress.failed,
    outcomesJson: JSON.stringify(progress.outcomes),
    currentJson: progress.currentJson,
    updatedAt: progress.updatedAt,
    runId,
  });
}

// Only an open run is closed, so the first reason recorded is the one that stays.
export function endTrainingRun(
  db: Database,
  runId: number,
  reason: RunEndReason,
  endedAt: string,
): void {
  db.prepare(
    `UPDATE training_runs SET ended_at = ?, ended_reason = ?, updated_at = ?
     WHERE id = ? AND ended_at IS NULL`,
  ).run(endedAt, reason, endedAt, runId);
}

export function endOpenTrainingRuns(db: Database, reason: RunEndReason, endedAt: string): number {
  return db
    .prepare(
      `UPDATE training_runs SET ended_at = ?, ended_reason = ?, updated_at = ?
       WHERE ended_at IS NULL`,
    )
    .run(endedAt, reason, endedAt).changes;
}

// A run still open when the server starts was on a board that went with the last process, and no
// command brings it back, so the start ends it. What was answered stays rated and the rest due.
// Returns how many runs it ended.
export function endRunsLeftOpenAtStart(db: Database, endedAt: string): number {
  return endOpenTrainingRuns(db, "left", endedAt);
}
