import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ActivityService } from "../../src/activity/service.js";
import type { CoachEvent } from "../../src/coach/events.js";
import {
  CoachSession,
  type CoachSessionDeps,
  coachNotificationSinks,
  IDLE_STREAM_MS,
} from "../../src/coach/session.js";
import { COACH_TOOL_NAMES } from "../../src/coach/tools.js";
import {
  appendChatMessage,
  createCoachSession,
  findLatestOpenSession,
  listChatTail,
} from "../../src/db/chat.js";
import { type Database, openDatabase } from "../../src/db/open.js";
import { GameService } from "../../src/game/service.js";
import { RecordingLog, silentLog } from "../../src/log.js";
import { contentDir } from "../../src/paths.js";
import { ReviewDesk } from "../../src/srs/review.js";
import { FakeSdk, loadRecordedTurns } from "../fakes/fake-sdk.js";
import { makeWorld } from "../fakes/fake-world.js";
import { GatedSdk } from "../fakes/gated-sdk.js";
import { ScriptedEngine } from "../fakes/scripted-engine.js";

const FIXTURE_SESSION_ID = "00000000-0000-4000-8000-000000000001";

function setup(overrides: Partial<CoachSessionDeps> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "coach-session-"));
  const db = openDatabase(dataDir);
  const sdk = new FakeSdk();
  const logs = new RecordingLog();
  const session = new CoachSession({
    db,
    query: sdk.query,
    contentDir: contentDir(),
    dataDir,
    world: makeWorld(db).world,
    env: {},
    log: logs,
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
    await session.send("hello", "play");
    await vi.waitFor(() => expect(turnsEnded(events)).toBe(1));
    await session.send("what is in the curriculum?", "play");
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
    await session.send("hello", "play");
    const row = findLatestOpenSession(db);
    expect(listChatTail(db, row?.id ?? -1, 1)[0]?.role).toBe("user");
    await vi.waitFor(() => expect(sdk.userTexts).toEqual(["hello"]));
    await session.stop();
  });

  it("records the SDK session id and the prompt version, and logs every init and turn", async () => {
    const { db, session, events, logs } = setup();
    await session.start();
    await session.send("one", "play");
    await vi.waitFor(() => expect(turnsEnded(events)).toBe(1));
    await session.send("two", "play");
    await vi.waitFor(() => expect(turnsEnded(events)).toBe(2));
    const row = findLatestOpenSession(db);
    expect(row?.claudeSessionId).toBe(FIXTURE_SESSION_ID);
    expect(row?.promptVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(logs.named("coach.session").length).toBeGreaterThanOrEqual(1);
    expect(logs.named("coach.session")[0]?.fields).toMatchObject({
      claude_session_id: FIXTURE_SESSION_ID,
    });
    const starts = logs.named("coach.turn_start");
    expect(starts.map((entry) => entry.fields.turn)).toEqual([1, 2]);
    expect(starts[0]?.fields).toMatchObject({ source: "user_text", message: "one" });
    const ends = logs.named("coach.turn_end");
    expect(ends.map((entry) => entry.fields.turn)).toEqual([1, 2]);
    for (const end of ends) {
      expect(end.fields).toMatchObject({ output_tokens: expect.any(Number) });
      expect(end.fields.duration_ms).toBeGreaterThanOrEqual(0);
    }
    await session.stop();
  });

  it("configures the SDK with no built-ins, no settings and the chess tools only", async () => {
    const { session, sdk } = setup();
    await session.start();
    expect(sdk.calls).toHaveLength(0);
    await session.send("hello", "play");
    const options = sdk.calls[0]?.options;
    expect(options?.tools).toEqual([]);
    expect(options?.settingSources).toEqual([]);
    expect(options?.permissionMode).toBe("default");
    expect(options?.includePartialMessages).toBe(true);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.allowedTools).toEqual(COACH_TOOL_NAMES);
    expect(options?.allowedTools).toHaveLength(18);
    expect(options?.resume).toBeUndefined();
    await session.stop();
  });

  it("resumes the stored session after a restart and keeps one open row", async () => {
    const first = setup();
    await first.session.start();
    await first.session.send("one", "play");
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
      log: silentLog,
    });
    await again.start();
    await again.send("two", "play");
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
      log: silentLog,
    });
    await session.start();
    await session.send("hello", "play");
    expect(sdk.calls[0]?.options.resume).toBeUndefined();
    const closed = db.prepare("SELECT ended_at FROM coach_sessions WHERE id = ?").get(stale.id) as {
      ended_at: string | null;
    };
    expect(closed.ended_at).not.toBeNull();
    expect(session.conversationRow("play")?.id).not.toBe(stale.id);
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
      log: silentLog,
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
      log: silentLog,
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
      log: silentLog,
    });
    session.onEvent((e) => events.push(e));
    await session.start();
    await session.send("hello", "play");
    await vi.waitFor(() =>
      expect(events).toEqual([{ kind: "turn_error", message: "no conversation found" }]),
    );
    const closed = db.prepare("SELECT ended_at FROM coach_sessions WHERE id = ?").get(dead.id) as {
      ended_at: string | null;
    };
    expect(closed.ended_at).not.toBeNull();

    await session.send("again", "play");
    expect(session.conversationRow("play")?.id).not.toBe(dead.id);
    expect(broken.calls[1]?.options.resume).toBeUndefined();
    await session.stop();
  });

  it("reports a login failure as a turn_error carrying the SDK's message", async () => {
    const message = "Not logged in. Please run /login";
    const { session, events } = setup({
      query: new FakeSdk({ failBeforeInit: new Error(message) }).query,
    });
    await session.start();
    await session.send("hello", "play");
    await vi.waitFor(() => expect(events).toEqual([{ kind: "turn_error", message }]));
    await session.stop();
  });

  it("recovers after the SDK process exits mid-turn and answers the next message", async () => {
    const sdk = new FakeSdk({
      failMidTurn: { messages: 5, error: new Error("Claude Code process exited with code 1") },
    });
    const { session, events } = setup({ query: sdk.query });
    await session.start();
    await session.send("hello", "play");
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe("turn_error"));
    expect(events.some((e) => e.kind === "text_delta")).toBe(true);
    expect(turnsEnded(events)).toBe(0);

    await session.send("are you there", "play");
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
    await expect(session.send("hi", "play")).rejects.toThrow("not started");
  });

  describe("permission requests", () => {
    async function ask(overrides: Partial<CoachSessionDeps> = {}) {
      const ctx = setup(overrides);
      await ctx.session.start();
      await ctx.session.send("hello", "play");
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

describe("the coach log", () => {
  it("numbers a turn sent while another is answered by when it is answered", async () => {
    const turn = loadRecordedTurns()[0] ?? [];
    const { session, events, logs } = setup({ query: new FakeSdk({ turns: [turn, turn] }).query });
    await session.start();
    await session.send("one", "play");
    await session.send("two", "play");
    await vi.waitFor(() => expect(turnsEnded(events)).toBe(2));
    expect(logs.named("coach.turn_start").map((entry) => entry.fields.turn)).toEqual([1, 2]);
    expect(logs.named("coach.turn_start")[1]?.fields.queued_behind).toBe(1);
    expect(logs.named("coach.turn_end").map((entry) => entry.fields.turn)).toEqual([1, 2]);
    for (const end of logs.named("coach.turn_end")) {
      expect(end.fields.waited_ms).toBeGreaterThanOrEqual(0);
    }
    await session.stop();
  });

  it("logs the SDK's init every time it arrives, not only the first", async () => {
    const turn = loadRecordedTurns()[0] ?? [];
    const inits = turn.filter((message) => message.type === "system").length;
    expect(inits).toBeGreaterThan(0);
    const { session, events, logs } = setup({ query: new FakeSdk({ turns: [turn, turn] }).query });
    await session.start();
    await session.send("one", "play");
    await vi.waitFor(() => expect(turnsEnded(events)).toBe(1));
    await session.send("two", "play");
    await vi.waitFor(() => expect(turnsEnded(events)).toBe(2));
    expect(logs.named("coach.session")).toHaveLength(inits * 2);
    await session.stop();
  });

  it("logs a stream that dies mid-turn with the turn it cut off", async () => {
    const failing = new FakeSdk({ failMidTurn: { messages: 1, error: new Error("cli exited") } });
    const { session, logs } = setup({ query: failing.query });
    await session.start();
    await session.send("one", "play");
    await vi.waitFor(() => expect(logs.named("coach.turn_error")).toHaveLength(1));
    expect(logs.named("coach.turn_error")[0]).toMatchObject({
      level: "error",
      fields: { turn: 1, error_message: "cli exited" },
    });
    await session.stop();
  });

  it("logs a permission asked, and how it was answered or timed out", async () => {
    const sdk = new FakeSdk();
    const { session, logs } = setup({ query: sdk.query, permissionTimeoutMs: 20 });
    session.onPermissionRequest((request) => {
      if (request.toolName === "Bash") session.resolvePermission(request.requestId, true);
    });
    await session.start();
    await session.send("hello", "play");
    const canUseTool = sdk.calls[0]?.options.canUseTool;
    if (!canUseTool) throw new Error("no permission callback");
    const signal = new AbortController().signal;
    await canUseTool("Bash", { command: "ls" }, { signal, suggestions: [] } as never);
    await canUseTool("Write", { path: "x" }, { signal, suggestions: [] } as never);
    expect(logs.named("coach.permission_request").map((entry) => entry.fields.tool_name)).toEqual([
      "Bash",
      "Write",
    ]);
    expect(logs.named("coach.permission_resolved").map((entry) => entry.fields.outcome)).toEqual([
      "allow",
      "timeout",
    ]);
    await session.stop();
  });
});

const BACK_RANK = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";

function openSession(db: Database, dataDir: string, overrides: Partial<CoachSessionDeps> = {}) {
  const sdk = new FakeSdk();
  const logs = new RecordingLog();
  const session = new CoachSession({
    db,
    query: sdk.query,
    contentDir: contentDir(),
    dataDir,
    world: makeWorld(db).world,
    env: {},
    log: logs,
    ...overrides,
  });
  const events: { event: CoachEvent; tab: string }[] = [];
  session.onEvent((event, tab) => events.push({ event, tab }));
  return { sdk, session, events, logs };
}

const ended = (events: { event: CoachEvent }[]) =>
  events.filter((e) => e.event.kind === "turn_end").length;

const notificationTypes = (db: Database, sessionId: number | undefined) =>
  listChatTail(db, sessionId ?? -1, 50)
    .filter((row) => row.kind === "notification")
    .map((row) => (JSON.parse(row.contentJson) as { type: string }).type);

describe("per-tab conversations", () => {
  it("resolves each tab's own open row and resumes a tab by its own stored id", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coach-tabs-"));
    const db = openDatabase(dataDir);
    const version = (await versionOf()).version;
    const play = createCoachSession(db, {
      promptVersion: version,
      claudeSessionId: "p",
      tab: "play",
    });
    const practice = createCoachSession(db, {
      promptVersion: version,
      claudeSessionId: "q",
      tab: "practice",
    });
    const { sdk, session, events } = openSession(db, dataDir);
    await session.start();
    expect(session.conversationRow("play")?.id).toBe(play.id);
    expect(session.conversationRow("practice")?.id).toBe(practice.id);
    expect(session.conversationRow("games")).toBeUndefined();

    await session.send("about this puzzle", "practice");
    await vi.waitFor(() => expect(ended(events)).toBe(1));
    expect(sdk.calls.map((call) => call.options.resume)).toEqual(["q"]);
    expect(listChatTail(db, practice.id, 50)[0]).toMatchObject({ role: "user", tab: "practice" });
    expect(listChatTail(db, play.id, 5)).toEqual([]);
    expect(new Set(events.map((e) => e.tab))).toEqual(new Set(["practice"]));
    await session.stop();
  });

  it("lands a training notification in the practice row and a game-end notification in the play row", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coach-route-"));
    const db = openDatabase(dataDir);
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
       VALUES ('f1', 'test', 'fork', 'easy', ?, '["a1a8"]', '["Ra8#"]', 'why')`,
    ).run(BACK_RANK);
    const { session } = openSession(db, dataDir);
    const sinks = coachNotificationSinks(session);
    const game = new GameService({ db, engine: new ScriptedEngine([]), notifications: sinks.game });
    const activity = new ActivityService({
      db,
      game,
      training: {
        desk: new ReviewDesk({ db, notifications: sinks.training }),
        notifications: sinks.training,
      },
    });
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("a1a8");
    await activity.endTraining();
    await activity.newGame({ color: "white" });
    await activity.resign();

    const practice = notificationTypes(db, session.conversationRow("practice")?.id);
    const play = notificationTypes(db, session.conversationRow("play")?.id);
    expect(practice).toContain("puzzle_result");
    expect(practice).not.toContain("game_end");
    expect(play).toEqual(["game_end"]);
    expect(session.conversationRow("games")).toBeUndefined();
  });

  it("closes only the named tab's row on newConversation and starts that tab fresh", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coach-new-"));
    const db = openDatabase(dataDir);
    const { sdk, session, events, logs } = openSession(db, dataDir);
    await session.start();
    await session.send("one", "play");
    await vi.waitFor(() => expect(ended(events)).toBe(1));
    await session.send("two", "practice");
    await vi.waitFor(() => expect(ended(events)).toBe(2));
    const play = session.conversationRow("play");
    const practice = session.conversationRow("practice");

    session.newConversation("practice");
    const endedAt = (id: number | undefined) =>
      (
        db.prepare("SELECT ended_at FROM coach_sessions WHERE id = ?").get(id) as {
          ended_at: string | null;
        }
      ).ended_at;
    expect(endedAt(practice?.id)).not.toBeNull();
    expect(endedAt(play?.id)).toBeNull();
    expect(session.conversationRow("practice")).toBeUndefined();
    expect(session.conversationRow("play")?.id).toBe(play?.id);
    expect(logs.named("coach.conversation_reset")[0]?.fields).toMatchObject({
      tab: "practice",
      coach_session_id: practice?.id,
    });

    await session.send("three", "practice");
    await vi.waitFor(() => expect(ended(events)).toBe(3));
    const fresh = session.conversationRow("practice");
    expect(fresh?.id).not.toBe(practice?.id);
    expect(listChatTail(db, fresh?.id ?? -1, 50)[0]?.contentJson).toBe('{"text":"three"}');
    expect(sdk.calls).toHaveLength(3);
    expect(sdk.calls[2]?.options.resume).toBeUndefined();
    await session.stop();
  });

  it("runs at most one coach turn at a time across tabs, in arrival order", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "coach-one-"));
    const db = openDatabase(dataDir);
    const gated = new GatedSdk();
    const { session, events } = openSession(db, dataDir, { query: gated.query });
    await session.start();
    await session.send("a", "play");
    await session.send("b", "practice");
    await session.send("c", "games");
    await vi.waitFor(() => expect(gated.userTexts).toEqual(["a"]));
    // A tab's stream starts on that tab's first message, so the waiting tabs have none yet.
    expect(gated.calls).toHaveLength(1);

    gated.release();
    await vi.waitFor(() => expect(gated.userTexts).toEqual(["a", "b"]));
    expect(gated.calls).toHaveLength(2);
    gated.release();
    await vi.waitFor(() => expect(gated.userTexts).toEqual(["a", "b", "c"]));
    gated.release();
    await vi.waitFor(() => expect(ended(events)).toBe(3));
    expect(gated.maxConcurrentTurns).toBe(1);
    expect(events.filter((e) => e.event.kind === "turn_end").map((e) => e.tab)).toEqual([
      "play",
      "practice",
      "games",
    ]);
    await session.stop();
  });

  it("closes an idle tab stream after 10 minutes and resumes it by its stored id", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const dataDir = mkdtempSync(join(tmpdir(), "coach-idle-"));
      const db = openDatabase(dataDir);
      const { sdk, session, events, logs } = openSession(db, dataDir);
      await session.start();
      await session.send("one", "play");
      await vi.waitFor(() => expect(ended(events)).toBe(1));
      const row = session.conversationRow("play");
      expect(IDLE_STREAM_MS).toBe(10 * 60_000);

      await vi.advanceTimersByTimeAsync(IDLE_STREAM_MS - 1_000);
      expect(logs.named("coach.stream_closed")).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(logs.named("coach.stream_closed")[0]?.fields).toMatchObject({
        tab: "play",
        reason: "idle",
      });

      await session.send("two", "play");
      await vi.waitFor(() => expect(ended(events)).toBe(2));
      expect(sdk.calls).toHaveLength(2);
      expect(sdk.calls[1]?.options.resume).toBe(FIXTURE_SESSION_ID);
      expect(session.conversationRow("play")?.id).toBe(row?.id);
      await session.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
