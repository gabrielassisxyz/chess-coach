import type { CoachTab } from "@chess-coach/shared";
import type { Database } from "better-sqlite3";
import { type Clock, systemClock } from "../clock.js";

export interface CoachSession {
  id: number;
  tab: CoachTab;
  claudeSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  promptVersion: string;
}

export type ChatRole = "user" | "assistant" | "system";
export type ChatKind = "text" | "tool_use" | "tool_result" | "notification" | "incomplete";

export interface ChatMessage {
  id: number;
  coachSessionId: number;
  tab: CoachTab;
  seq: number;
  role: ChatRole;
  kind: ChatKind;
  contentJson: string;
  delivered: boolean;
  createdAt: string;
}

export interface NewChatMessage {
  role: ChatRole;
  kind: ChatKind;
  contentJson: string;
}

interface SessionRow {
  id: number;
  tab: CoachTab;
  claude_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  prompt_version: string;
}

interface MessageRow {
  id: number;
  coach_session_id: number;
  tab: CoachTab;
  seq: number;
  role: ChatRole;
  kind: ChatKind;
  content_json: string;
  delivered: number;
  created_at: string;
}

function toSession(row: SessionRow): CoachSession {
  return {
    id: row.id,
    tab: row.tab,
    claudeSessionId: row.claude_session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    promptVersion: row.prompt_version,
  };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    coachSessionId: row.coach_session_id,
    tab: row.tab,
    seq: row.seq,
    role: row.role,
    kind: row.kind,
    contentJson: row.content_json,
    delivered: row.delivered === 1,
    createdAt: row.created_at,
  };
}

export function createCoachSession(
  db: Database,
  input: { promptVersion: string; claudeSessionId?: string; tab?: CoachTab },
  clock: Clock = systemClock,
): CoachSession {
  const row = db
    .prepare(
      `INSERT INTO coach_sessions (tab, claude_session_id, started_at, prompt_version)
       VALUES (?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.tab ?? "play",
      input.claudeSessionId ?? null,
      clock.now().toISOString(),
      input.promptVersion,
    );
  return toSession(row as SessionRow);
}

export function findLatestOpenSession(
  db: Database,
  tab: CoachTab = "play",
): CoachSession | undefined {
  const row = db
    .prepare(
      "SELECT * FROM coach_sessions WHERE tab = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1",
    )
    .get(tab);
  return row ? toSession(row as SessionRow) : undefined;
}

export function closeCoachSession(db: Database, id: number, clock: Clock = systemClock): void {
  db.prepare("UPDATE coach_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(
    clock.now().toISOString(),
    id,
  );
}

// seq is read and written in one statement so concurrent writers on the file cannot reuse a number.
export function appendChatMessage(
  db: Database,
  coachSessionId: number,
  message: NewChatMessage,
  clock: Clock = systemClock,
): ChatMessage {
  const row = db
    .prepare(
      `INSERT INTO chat_messages
         (coach_session_id, tab, seq, role, kind, content_json, created_at)
       VALUES (
         @session,
         COALESCE((SELECT tab FROM coach_sessions WHERE id = @session), 'play'),
         (SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages WHERE coach_session_id = @session),
         @role, @kind, @content, @createdAt
       ) RETURNING *`,
    )
    .get({
      session: coachSessionId,
      role: message.role,
      kind: message.kind,
      content: message.contentJson,
      createdAt: clock.now().toISOString(),
    });
  return toMessage(row as MessageRow);
}

export function listChatTail(db: Database, coachSessionId: number, limit: number): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM chat_messages WHERE coach_session_id = ? ORDER BY seq DESC LIMIT ?
       ) ORDER BY seq ASC`,
    )
    .all(coachSessionId, limit);
  return (rows as MessageRow[]).map(toMessage);
}

export function markDelivered(db: Database, messageId: number): void {
  db.prepare("UPDATE chat_messages SET delivered = 1 WHERE id = ?").run(messageId);
}

export function listUndeliveredNotifications(db: Database, coachSessionId: number): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE coach_session_id = ? AND kind = 'notification' AND delivered = 0
       ORDER BY seq ASC`,
    )
    .all(coachSessionId);
  return (rows as MessageRow[]).map(toMessage);
}
