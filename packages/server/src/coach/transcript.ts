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
export function recordDivider(
  db: Database,
  sessionId: number,
  label: string,
  clock: Clock,
): ChatMessage {
  return appendChatMessage(
    db,
    sessionId,
    {
      role: "system",
      kind: "text",
      contentJson: JSON.stringify({ label, at: clock.now().toISOString() }),
    },
    clock,
  );
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

// A restart can land between a user row and the answer to it; the marker keeps the transcript honest.
export function markIncompleteIfDangling(
  db: Database,
  sessionId: number,
  clock: Clock = systemClock,
): boolean {
  const newest = listChatTail(db, sessionId, 1)[0];
  if (newest?.role !== "user") return false;
  // A notification nobody has delivered yet is waiting to be sent, not an answer that was lost.
  if (newest.kind === "notification" && !newest.delivered) return false;
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
