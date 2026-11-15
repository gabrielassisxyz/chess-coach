import { type Clock, systemClock } from "../clock.js";
import { appendChatMessage, type ChatMessage, listChatTail } from "../db/chat.js";
import type { Database } from "../db/open.js";
import type { FinalizedItem } from "./events.js";

export function recordUserText(
  db: Database,
  sessionId: number,
  text: string,
  clock: Clock,
): ChatMessage {
  return appendChatMessage(
    db,
    sessionId,
    { role: "user", kind: "text", contentJson: JSON.stringify({ text }) },
    clock,
  );
}

/**
 * Marks where a practice queue or a game began inside a tab's conversation. It is a system text
 * row: the kind CHECK on chat_messages cannot be widened without rebuilding a table that
 * training_explorations references, and a system row is never sent to the coach.
 */
function recordSystemText(
  db: Database,
  sessionId: number,
  payload: Record<string, unknown>,
  clock: Clock,
): ChatMessage {
  return appendChatMessage(
    db,
    sessionId,
    {
      role: "system",
      kind: "text",
      contentJson: JSON.stringify(payload),
    },
    clock,
  );
}

export function recordDivider(
  db: Database,
  sessionId: number,
  label: string,
  clock: Clock,
): ChatMessage {
  return recordSystemText(db, sessionId, { label, at: clock.now().toISOString() }, clock);
}

/** Records the hidden turn-start boundary before a delivery reaches the SDK queue. */
export function recordTurnStart(
  db: Database,
  sessionId: number,
  clock: Clock = systemClock,
): ChatMessage {
  return recordSystemText(db, sessionId, { turn_start: clock.now().toISOString() }, clock);
}

export function recordFinalized(
  db: Database,
  sessionId: number,
  item: FinalizedItem,
  clock: Clock,
): void {
  appendChatMessage(
    db,
    sessionId,
    { role: item.role, kind: item.kind, contentJson: JSON.stringify(item.content) },
    clock,
  );
}

function isTurnStartRow(row: ChatMessage): boolean {
  if (row.role !== "system" || row.kind !== "text") return false;
  try {
    const parsed = JSON.parse(row.contentJson) as Record<string, unknown> | null;
    return typeof parsed?.turn_start === "string";
  } catch {
    return false;
  }
}

// A restart can land between a user row (or its turn-start marker) and the answer to it; the marker keeps the transcript honest.
export function markIncompleteIfDangling(
  db: Database,
  sessionId: number,
  clock: Clock = systemClock,
): boolean {
  const newest = listChatTail(db, sessionId, 1)[0];
  if (!newest) return false;
  if (newest.role === "user") {
    // A notification nobody has delivered yet is waiting to be sent, not an answer that was lost.
    if (newest.kind === "notification" && !newest.delivered) return false;
  } else if (!isTurnStartRow(newest)) {
    return false;
  }
  appendChatMessage(
    db,
    sessionId,
    { role: "system", kind: "incomplete", contentJson: JSON.stringify({}) },
    clock,
  );
  return true;
}

export function storeClaudeSessionId(
  db: Database,
  sessionId: number,
  claudeSessionId: string,
): void {
  db.prepare("UPDATE coach_sessions SET claude_session_id = ? WHERE id = ?").run(
    claudeSessionId,
    sessionId,
  );
}
