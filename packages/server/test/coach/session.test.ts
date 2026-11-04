import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CoachEvent } from "../../src/coach/events.js";
import { CoachSession, type CoachSessionDeps } from "../../src/coach/session.js";
import { COACH_TOOL_NAMES } from "../../src/coach/tools.js";
import {
  appendChatMessage,
  createCoachSession,
  findLatestOpenSession,
  listChatTail,
} from "../../src/db/chat.js";
import { openDatabase } from "../../src/db/open.js";
import { contentDir } from "../../src/paths.js";
import { FakeSdk } from "../fakes/fake-sdk.js";
import { makeWorld } from "../fakes/fake-world.js";

const FIXTURE_SESSION_ID = "00000000-0000-4000-8000-000000000001";

function setup(overrides: Partial<CoachSessionDeps> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "coach-session-"));
  const db = openDatabase(dataDir);
  const sdk = new FakeSdk();
  const logs: string[] = [];
  const session = new CoachSession({
    db,
    query: sdk.query,
    contentDir: contentDir(),
    dataDir,
    world: makeWorld(db).world,
    env: {},
    log: (line) => logs.push(line),
    ...overrides,
  });
  const events: CoachEvent[] = [];
  session.onEvent((event) => events.push(event));
  return { db, dataDir, sdk, session, events, logs };
}

const turnsEnded = (events: CoachEvent[]) => events.filter((e) => e.kind === "turn_end").length;

describe("CoachSession", () => {
  it("streams events and writes one row per finalized message, none per delta", async () => {
    const { db, session, events } = setup();
    await session.start();
    await session.send("hello");
    await vi.waitFor(() => expect(turnsEnded(events)).toBe(1));
    await session.send("what is in the curriculum?");
    await vi.waitFor(() => expect(turnsEnded(events)).toBe(2));

    const row = findLatestOpenSession(db);
    const rows = listChatTail(db, row?.id ?? -1, 50);
    expect(rows.map((r) => `${r.role}:${r.kind}`)).toEqual([
      "user:text",
      "assistant:text",
      "user:text",
      "assistant:text",
      "assistant:tool_use",
      "user:tool_result",
      "assistant:text",
    ]);
    const deltas = events.filter((e) => e.kind === "text_delta").length;
    const assistantText = rows.filter((r) => r.role === "assistant" && r.kind === "text").length;
    expect(deltas).toBeGreaterThan(assistantText);
    await session.stop();
  });

  it("writes the user's text before the SDK sees it", async () => {
    const { db, session, sdk } = setup();
    await session.start();
    await session.send("hello");
    const row = findLatestOpenSession(db);
    expect(listChatTail(db, row?.id ?? -1, 1)[0]?.role).toBe("user");
    await vi.waitFor(() => expect(sdk.userTexts).toEqual(["hello"]));
    await session.stop();
  });

  it("records the SDK session id and the prompt version, and logs init once", async () => {
    const { db, session, events, logs } = setup();
    await session.start();
    await session.send("one");
    await vi.waitFor(() => expect(turnsEnded(events)).toBe(1));
    await session.send("two");
    await vi.waitFor(() => expect(turnsEnded(events)).toBe(2));
    const row = findLatestOpenSession(db);
    expect(row?.claudeSessionId).toBe(FIXTURE_SESSION_ID);
    expect(row?.promptVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(logs.filter((l) => l.startsWith("coach session"))).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith("coach usage"))).toHaveLength(1);
    await session.stop();
  });

  it("configures the SDK with no built-ins, no settings and the chess tools only", async () => {
    const { session, sdk } = setup();
    await session.start();
    const options = sdk.calls[0]?.options;
    expect(options?.tools).toEqual([]);
    expect(options?.settingSources).toEqual([]);
    expect(options?.permissionMode).toBe("default");
    expect(options?.includePartialMessages).toBe(true);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.allowedTools).toEqual(COACH_TOOL_NAMES);
    expect(options?.allowedTools).toHaveLength(13);
    expect(options?.resume).toBeUndefined();
    await session.stop();
  });

  it("resumes the stored session after a restart and keeps one open row", async () => {
    const first = setup();
    await first.session.start();
    await first.session.send("one");
    await vi.waitFor(() => expect(turnsEnded(first.events)).toBe(1));
    await first.session.stop();

    const second = new FakeSdk();
    const again = new CoachSession({
      db: first.db,
      query: second.query,
      contentDir: contentDir(),
      dataDir: first.dataDir,
      world: makeWorld(first.db).world,
      env: {},
      log: () => {},
    });
    await again.start();
    expect(second.calls[0]?.options.resume).toBe(FIXTURE_SESSION_ID);
    const open = first.db
      .prepare("SELECT COUNT(*) AS n FROM coach_sessions WHERE ended_at IS NULL")
      .get();
    expect(open).toEqual({ n: 1 });
    await again.stop();
  });

  it("starts a new session when the stored one was built from another prompt", async () => {
    const { db, dataDir, sdk } = setup();
    const stale = createCoachSession(db, { promptVersion: "old", claudeSessionId: "stale-id" });
    const session = new CoachSession({
      db,
      query: sdk.query,
      contentDir: contentDir(),
      dataDir,
      world: makeWorld(db).world,
      env: {},
      log: () => {},
    });
    await session.start();
    expect(sdk.calls[0]?.options.resume).toBeUndefined();
    const closed = db.prepare("SELECT ended_at FROM coach_sessions WHERE id = ?").get(stale.id) as {
      ended_at: string | null;
    };
    expect(closed.ended_at).not.toBeNull();
    expect(session.sessionRow?.id).not.toBe(stale.id);
    await session.stop();
  });

  it("appends an incomplete row when the last row is an unanswered user message", async () => {
    const { db, dataDir, sdk } = setup();
    const row = createCoachSession(db, { promptVersion: (await versionOf()).version });
    appendChatMessage(db, row.id, { role: "user", kind: "text", contentJson: '{"text":"cut"}' });
    const session = new CoachSession({
      db,
      query: sdk.query,
      contentDir: contentDir(),
      dataDir,
      world: makeWorld(db).world,
      env: {},
      log: () => {},
    });
    await session.start();
    const tail = listChatTail(db, row.id, 5);
    expect(tail.map((r) => r.kind)).toEqual(["text", "incomplete"]);
    await session.stop();
  });

  it("leaves a transcript that ends on an answer alone", async () => {
    const { db, dataDir, sdk } = setup();
    const row = createCoachSession(db, { promptVersion: (await versionOf()).version });
    appendChatMessage(db, row.id, { role: "user", kind: "text", contentJson: "{}" });
    appendChatMessage(db, row.id, { role: "assistant", kind: "text", contentJson: "{}" });
    const session = new CoachSession({
      db,
      query: sdk.query,
      contentDir: contentDir(),
      dataDir,
      world: makeWorld(db).world,
      env: {},
      log: () => {},
    });
    await session.start();
    expect(listChatTail(db, row.id, 5)).toHaveLength(2);
    await session.stop();
  });

  it("closes a session the SDK cannot resume and starts a fresh one on the next send", async () => {
    const { db, dataDir } = setup();
    const version = (await versionOf()).version;
    const dead = createCoachSession(db, { promptVersion: version, claudeSessionId: "gone" });
    const broken = new FakeSdk({ failBeforeInit: new Error("no conversation found") });
    const events: CoachEvent[] = [];
    const session = new CoachSession({
      db,
      query: broken.query,
      contentDir: contentDir(),
      dataDir,
      world: makeWorld(db).world,
      env: {},
      log: () => {},
    });
    session.onEvent((e) => events.push(e));
    await session.start();
    await vi.waitFor(() =>
      expect(events).toEqual([{ kind: "turn_error", message: "no conversation found" }]),
    );
    const closed = db.prepare("SELECT ended_at FROM coach_sessions WHERE id = ?").get(dead.id) as {
      ended_at: string | null;
    };
    expect(closed.ended_at).not.toBeNull();

    await session.send("again");
    expect(session.sessionRow?.id).not.toBe(dead.id);
    expect(broken.calls[1]?.options.resume).toBeUndefined();
    await session.stop();
  });

  it("reports a login failure as a turn_error carrying the SDK's message", async () => {
    const message = "Not logged in. Please run /login";
    const { session, events } = setup({
      query: new FakeSdk({ failBeforeInit: new Error(message) }).query,
    });
    await session.start();
    await vi.waitFor(() => expect(events).toEqual([{ kind: "turn_error", message }]));
    await session.stop();
  });

  it("recovers after the SDK process exits mid-turn and answers the next message", async () => {
    const sdk = new FakeSdk({
      failMidTurn: { messages: 5, error: new Error("Claude Code process exited with code 1") },
    });
    const { session, events } = setup({ query: sdk.query });
    await session.start();
    await session.send("hello");
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe("turn_error"));
    expect(events.some((e) => e.kind === "text_delta")).toBe(true);
    expect(turnsEnded(events)).toBe(0);

    await session.send("are you there");
    await vi.waitFor(() => expect(sdk.calls).toHaveLength(2));
    expect(sdk.calls[1]?.options.resume).toBe(FIXTURE_SESSION_ID);
    await vi.waitFor(() => expect(turnsEnded(events)).toBe(1));
    await session.stop();
  });

  it("refuses to start with an API key in the environment", async () => {
    const { session } = setup({ env: { ANTHROPIC_API_KEY: "fake" } });
    await expect(session.start()).rejects.toThrow("ANTHROPIC_API_KEY");
  });

  it("rejects send before start", async () => {
    const { session } = setup();
    await expect(session.send("hi")).rejects.toThrow("not started");
  });

  describe("permission requests", () => {
    async function ask(overrides: Partial<CoachSessionDeps> = {}) {
      const ctx = setup(overrides);
      await ctx.session.start();
      const requests: { requestId: string; toolName: string }[] = [];
      ctx.session.onPermissionRequest((r) => requests.push(r));
      const canUseTool = ctx.sdk.calls[0]?.options.canUseTool;
      if (!canUseTool) throw new Error("canUseTool missing");
      const answer = canUseTool("Bash", { command: "ls" }, {
        signal: new AbortController().signal,
      } as never);
      return { ...ctx, requests, answer };
    }

    it("denies a request nobody answers within the timeout", async () => {
      const { answer, requests, session } = await ask({ permissionTimeoutMs: 20 });
      expect(requests).toHaveLength(1);
      expect(await answer).toMatchObject({ behavior: "deny" });
      expect(session.resolvePermission(requests[0]?.requestId ?? "", true)).toBe(false);
      await session.stop();
    });

    it("allows a request the listener approves in time", async () => {
      const { answer, requests, session } = await ask({ permissionTimeoutMs: 5_000 });
      expect(session.resolvePermission(requests[0]?.requestId ?? "", true)).toBe(true);
      expect(await answer).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
      await session.stop();
    });

    it("denies a request the listener refuses", async () => {
      const { answer, requests, session } = await ask({ permissionTimeoutMs: 5_000 });
      session.resolvePermission(requests[0]?.requestId ?? "", false);
      expect(await answer).toMatchObject({ behavior: "deny" });
      await session.stop();
    });
  });
});

async function versionOf() {
  const { buildCoachPrompt } = await import("../../src/coach/prompt.js");
  return buildCoachPrompt(contentDir());
}
