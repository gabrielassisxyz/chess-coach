import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../clock.js";
import {
  appendChatMessage,
  closeCoachSession,
  createCoachSession,
  findLatestOpenSession,
  listChatTail,
  listUndeliveredNotifications,
  markDelivered,
} from "./chat.js";
import { type Database, openDatabase } from "./open.js";

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  set(next: Date): void {
    this.current = next;
  }
}

let tmp: string;
let db: Database;
const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-chat-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const text = (n: number) => ({
  role: "user" as const,
  kind: "text" as const,
  contentJson: `"${n}"`,
});

describe("coach sessions", () => {
  it("finds the latest open session and stops finding it once closed", () => {
    const first = createCoachSession(db, { promptVersion: "v1" }, clock);
    const second = createCoachSession(db, { promptVersion: "v1", claudeSessionId: "abc" }, clock);
    expect(findLatestOpenSession(db)?.id).toBe(second.id);
    expect(second.claudeSessionId).toBe("abc");
    expect(second.startedAt).toBe("2026-01-01T00:00:00.000Z");

    clock.set(new Date("2026-01-02T00:00:00.000Z"));
    closeCoachSession(db, second.id, clock);
    expect(findLatestOpenSession(db)?.id).toBe(first.id);
    closeCoachSession(db, first.id, clock);
    expect(findLatestOpenSession(db)).toBeUndefined();
  });
});

describe("chat messages", () => {
  it("assigns gapless seq per session", () => {
    const a = createCoachSession(db, { promptVersion: "v1" }, clock);
    const b = createCoachSession(db, { promptVersion: "v1" }, clock);
    const seqs = [
      appendChatMessage(db, a.id, text(1), clock).seq,
      appendChatMessage(db, b.id, text(2), clock).seq,
      appendChatMessage(db, a.id, text(3), clock).seq,
      appendChatMessage(db, a.id, text(4), clock).seq,
    ];
    expect(seqs).toEqual([1, 1, 2, 3]);
  });

  it("rejects a duplicate seq in the same session", () => {
    const a = createCoachSession(db, { promptVersion: "v1" }, clock);
    appendChatMessage(db, a.id, text(1), clock);
    expect(() =>
      db
        .prepare(
          `INSERT INTO chat_messages (coach_session_id, seq, role, kind, content_json, created_at)
           VALUES (?, 1, 'user', 'text', '"x"', 'now')`,
        )
        .run(a.id),
    ).toThrow(/UNIQUE/);
  });

  it("rejects a message for a session that does not exist", () => {
    expect(() => appendChatMessage(db, 999, text(1), clock)).toThrow(/FOREIGN KEY/);
  });

  it("lists the last N in ascending order", () => {
    const a = createCoachSession(db, { promptVersion: "v1" }, clock);
    for (let i = 1; i <= 5; i++) appendChatMessage(db, a.id, text(i), clock);
    expect(listChatTail(db, a.id, 3).map((m) => m.seq)).toEqual([3, 4, 5]);
  });

  it("returns undelivered notifications only, until marked delivered", () => {
    const a = createCoachSession(db, { promptVersion: "v1" }, clock);
    appendChatMessage(db, a.id, text(1), clock);
    const n1 = appendChatMessage(
      db,
      a.id,
      { role: "system", kind: "notification", contentJson: "{}" },
      clock,
    );
    const n2 = appendChatMessage(
      db,
      a.id,
      { role: "system", kind: "notification", contentJson: "{}" },
      clock,
    );
    expect(listUndeliveredNotifications(db, a.id).map((m) => m.id)).toEqual([n1.id, n2.id]);
    markDelivered(db, n1.id);
    expect(listUndeliveredNotifications(db, a.id).map((m) => m.id)).toEqual([n2.id]);
  });
});
