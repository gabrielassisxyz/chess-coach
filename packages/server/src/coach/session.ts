import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type Clock, systemClock } from "../clock.js";
import type { CoachSession as CoachSessionRow } from "../db/chat.js";
import {
  closeCoachSession,
  createCoachSession,
  findLatestOpenSession,
  listUndeliveredNotifications,
  markDelivered,
} from "../db/chat.js";
import type { Database } from "../db/open.js";
import { type Log, type LogFields, silentLog } from "../log.js";
import { assertSubscriptionAuth } from "./auth.js";
import { type CoachEvent, mapSdkMessage, type SessionInit } from "./events.js";
import type { CoachWorld } from "./game-tools.js";
import { type CoachNotification, renderNotifications } from "./notify.js";
import { buildCoachPrompt, type CoachPrompt } from "./prompt.js";
import { AsyncQueue } from "./queue.js";
import { COACH_TOOL_NAMES, createCoachMcpServer, MCP_SERVER_NAME } from "./tools.js";
import {
  markIncompleteIfDangling,
  recordFinalized,
  recordUserText,
  storeClaudeSessionId,
} from "./transcript.js";

// The slice of the SDK this module uses, so tests can inject a named fake instead of a process.
export interface CoachQuery extends AsyncIterable<SDKMessage> {
  close?(): void;
}
export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => CoachQuery;

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface CoachSessionDeps {
  db: Database;
  query: QueryFn;
  contentDir: string;
  dataDir: string;
  world: CoachWorld;
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
  permissionTimeoutMs?: number;
  /** Called with the id of each chat line the student sends, so it can be tied to an open item. */
  onUserText?: (messageId: number) => void;
  log?: Log;
}

const PERMISSION_TIMEOUT_MS = 60_000;

interface PendingPermission {
  resolve: (allow: boolean) => void;
  timer: NodeJS.Timeout;
}

interface OpenToolCall {
  name: string;
  startedAt: number;
}

// A message handed to the SDK, open until a result names its uuid. The SDK may answer several
// queued messages with one result; without uuids in the result, the oldest open one is assumed.
interface QueuedTurn {
  turn: number;
  uuid: string;
  queuedAt: number;
}

// A refusal from the coach's own tools is JSON carrying `error`; its code is what a reader wants.
function refusalCode(output: unknown): string | null {
  const text = Array.isArray(output)
    ? output.map((block) => (block as { text?: unknown } | null)?.text ?? "").join("")
    : output;
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text) as { error?: unknown } | null;
    return typeof parsed?.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

export class CoachSession {
  private readonly eventListeners = new Set<(event: CoachEvent) => void>();
  private readonly permissionListeners = new Set<(request: PermissionRequest) => void>();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly clock: Clock;
  private readonly log: Log;
  private prompt: CoachPrompt | undefined;
  private row: CoachSessionRow | undefined;
  private queue: AsyncQueue<SDKUserMessage> | undefined;
  private active: CoachQuery | undefined;
  private loop: Promise<void> = Promise.resolve();
  // Numbers each message handed to the SDK, so every tool call and the turn's end name their turn.
  private turn = 0;
  private readonly queuedTurns: QueuedTurn[] = [];
  // When the previous turn ended: a queued turn starts only then, not when it was queued.
  private lastTurnEndedAt = 0;
  // Set when notifications arrived while the coach was answering, so the next flush says so.
  private heldWhileBusy = false;
  // Once a result has named the messages it answered, one that names none is the SDK's own turn.
  private resultsNameMessages = false;
  private readonly openTools = new Map<string, OpenToolCall>();
  // True from handing the SDK a message until its turn ends: while it is set, notifications wait
  // and are folded into one message instead of queueing behind the answer being written.
  private busy = false;
  // Rows written during boot recovery wait for start(); launching the SDK earlier would start it twice.
  private started = false;

  constructor(private readonly deps: CoachSessionDeps) {
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? silentLog;
  }

  get sessionRow(): CoachSessionRow | undefined {
    return this.row;
  }

  onEvent(listener: (event: CoachEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onPermissionRequest(listener: (request: PermissionRequest) => void): () => void {
    this.permissionListeners.add(listener);
    return () => this.permissionListeners.delete(listener);
  }

  async start(): Promise<void> {
    assertSubscriptionAuth(this.deps.env ?? process.env);
    mkdirSync(this.deps.dataDir, { recursive: true });
    this.ensureSessionId();
    this.launch();
    this.started = true;
    this.flushNotifications();
  }

  // The game service writes notification rows before the SDK is up (recovery runs at boot), so
  // the session row has to exist without the query being started.
  ensureSessionId(): number {
    this.prompt ??= buildCoachPrompt(this.deps.contentDir);
    this.row ??= this.pickSessionRow(this.prompt.version);
    return this.row.id;
  }

  async send(text: string): Promise<void> {
    const row = this.ensureStream();
    const message = recordUserText(this.deps.db, row.id, text, this.clock);
    this.deps.onUserText?.(message.id);
    this.deliver(text, { source: "user_text", message_id: message.id });
  }

  /**
   * Hands the SDK everything the game service left undelivered, as one message. Rows are marked
   * delivered at the moment they are handed over, so a restart never sends a move twice.
   */
  flushNotifications(): void {
    if (!this.started) return;
    if (this.busy) {
      this.heldWhileBusy = true;
      return;
    }
    const row = this.ensureStream();
    const pending = listUndeliveredNotifications(this.deps.db, row.id);
    if (pending.length === 0) return;
    const text = renderNotifications(
      pending.map((message) => JSON.parse(message.contentJson) as CoachNotification),
    );
    this.deps.db.transaction(() => {
      for (const message of pending) markDelivered(this.deps.db, message.id);
    })();
    this.deliver(text, {
      source: "notifications",
      notification_ids: pending.map((message) => message.id),
      notification_types: pending.map(
        (message) => (JSON.parse(message.contentJson) as { type?: unknown }).type ?? null,
      ),
      // These waited for the coach to finish an answer and were folded into one message.
      folded: this.heldWhileBusy,
    });
    this.heldWhileBusy = false;
  }

  private ensureStream(): CoachSessionRow {
    if (!this.prompt) throw new Error("coach session not started");
    if (!this.queue) {
      this.row =
        this.row ??
        createCoachSession(this.deps.db, { promptVersion: this.prompt.version }, this.clock);
      this.launch();
    }
    return this.row as CoachSessionRow;
  }

  private deliver(text: string, origin: LogFields): void {
    this.busy = true;
    this.turn += 1;
    const uuid = randomUUID();
    this.queuedTurns.push({ turn: this.turn, uuid, queuedAt: performance.now() });
    // Logged when queued; the turn may wait behind an answer still being written.
    this.log.info("coach.turn_start", {
      coach_session_id: this.row?.id,
      turn: this.turn,
      message_uuid: uuid,
      queued_behind: this.queuedTurns.length - 1,
      ...origin,
      message: text,
    });
    this.queue?.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid: uuid as `${string}-${string}-${string}-${string}-${string}`,
    });
  }

  resolvePermission(requestId: string, allow: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    entry.resolve(allow);
    return true;
  }

  async stop(): Promise<void> {
    this.queue?.close();
    this.active?.close?.();
    for (const id of [...this.pending.keys()]) this.resolvePermission(id, false);
    await this.loop;
  }

  // A stored session is only resumable under the exact prompt it was started with.
  private pickSessionRow(version: string): CoachSessionRow {
    const open = findLatestOpenSession(this.deps.db);
    if (open && open.promptVersion === version) {
      markIncompleteIfDangling(this.deps.db, open.id, this.clock);
      return open;
    }
    if (open) closeCoachSession(this.deps.db, open.id, this.clock);
    return createCoachSession(this.deps.db, { promptVersion: version }, this.clock);
  }

  private launch(): void {
    const row = this.row as CoachSessionRow;
    const queue = new AsyncQueue<SDKUserMessage>();
    const resume = row.claudeSessionId ?? undefined;
    this.busy = false;
    // Messages queued on a stream that ended will never be answered by the new one.
    this.queuedTurns.length = 0;
    const stream = this.deps.query({ prompt: queue, options: this.buildOptions(resume) });
    this.queue = queue;
    this.active = stream;
    this.loop = this.consume(stream, row, resume !== undefined);
  }

  private buildOptions(resume: string | undefined): Options {
    const { db, contentDir, dataDir } = this.deps;
    const options: Options = {
      cwd: dataDir,
      // An empty list loads no user, project or local settings, so the repository's own
      // CLAUDE.md and the owner's skills never reach the coach.
      settingSources: [],
      systemPrompt: { type: "preset", preset: "claude_code", append: this.prompt?.append ?? "" },
      mcpServers: {
        [MCP_SERVER_NAME]: createCoachMcpServer({
          db,
          contentDir,
          world: this.deps.world,
          now: () => this.clock.now(),
        }),
      },
      // Without this the CLI also connects the owner's claude.ai connectors, whose tools would
      // then appear in the coach's tool list.
      strictMcpConfig: true,
      allowedTools: COACH_TOOL_NAMES,
      // `tools: []` is how the installed SDK disables every built-in tool; disallowedTools is
      // not needed. The probe asserts the init tool list to prove it.
      tools: [],
      permissionMode: "default",
      includePartialMessages: true,
      canUseTool: (toolName, input) => this.askPermission(toolName, input),
    };
    if (resume !== undefined) options.resume = resume;
    return options;
  }

  private askPermission(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  > {
    const requestId = randomUUID();
    const timeoutMs = this.deps.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS;
    return new Promise((resolve) => {
      const settle = (allow: boolean): void => {
        const entry = this.pending.get(requestId);
        if (entry) clearTimeout(entry.timer);
        this.pending.delete(requestId);
        resolve(
          allow
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "The student did not approve this tool." },
        );
      };
      const timer = setTimeout(() => {
        this.log.warn("coach.permission_resolved", {
          request_id: requestId,
          tool_name: toolName,
          outcome: "timeout",
        });
        settle(false);
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (allow) => {
          this.log.info("coach.permission_resolved", {
            request_id: requestId,
            tool_name: toolName,
            outcome: allow ? "allow" : "deny",
          });
          settle(allow);
        },
        timer,
      });
      this.log.info("coach.permission_request", {
        request_id: requestId,
        tool_name: toolName,
        input,
      });
      for (const listener of this.permissionListeners) listener({ requestId, toolName, input });
    });
  }

  private async consume(stream: CoachQuery, row: CoachSessionRow, resumed: boolean): Promise<void> {
    let initSeen = false;
    try {
      for await (const message of stream) {
        const mapped = mapSdkMessage(message);
        if (mapped.init) {
          initSeen = true;
          this.adoptInit(row, mapped.init);
        }
        for (const item of mapped.finalized)
          recordFinalized(this.deps.db, row.id, item, this.clock);
        for (const event of mapped.events) {
          this.logEvent(event);
          this.emit(event);
        }
        if (mapped.events.some((event) => event.kind === "turn_end")) {
          this.busy = false;
          this.flushNotifications();
        }
      }
    } catch (error) {
      this.log.error("coach.turn_error", error, {
        coach_session_id: row.id,
        turn: this.queuedTurns[0]?.turn ?? this.turn,
        queued_turns: this.queuedTurns.map((queued) => queued.turn),
        resumed,
        init_seen: initSeen,
      });
      // A stored session the CLI cannot find is closed so the next send starts a fresh one.
      if (resumed && !initSeen) {
        closeCoachSession(this.deps.db, row.id, this.clock);
        this.row = undefined;
      }
      this.emit({
        kind: "turn_error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.active === stream) {
        this.busy = false;
        this.queue?.close();
        this.queue = undefined;
        this.active = undefined;
      }
    }
  }

  private adoptInit(row: CoachSessionRow, init: SessionInit): void {
    if (row.claudeSessionId !== init.sessionId) {
      storeClaudeSessionId(this.deps.db, row.id, init.sessionId);
      row.claudeSessionId = init.sessionId;
    }
    this.log.info("coach.session", {
      coach_session_id: row.id,
      claude_session_id: init.sessionId,
      model: init.model,
      auth: init.apiKeySource,
      tools: init.tools.length,
    });
  }

  private logEvent(event: CoachEvent): void {
    const current = this.queuedTurns[0];
    const turn = { coach_session_id: this.row?.id, turn: current?.turn ?? this.turn };
    if (event.kind === "tool_use") {
      this.openTools.set(event.toolUseId, { name: event.name, startedAt: performance.now() });
      this.log.info("coach.tool_call", {
        ...turn,
        tool_use_id: event.toolUseId,
        name: event.name,
        input: event.input,
      });
    } else if (event.kind === "tool_result") {
      const call = this.openTools.get(event.toolUseId);
      this.openTools.delete(event.toolUseId);
      const code = refusalCode(event.output);
      const flagged = event.isError;
      this.log.info("coach.tool_result", {
        ...turn,
        tool_use_id: event.toolUseId,
        name: call?.name ?? null,
        duration_ms: call ? Math.round(performance.now() - call.startedAt) : null,
        is_error: flagged || code !== null,
        error_code: code,
        output: event.output,
      });
    } else if (event.kind === "turn_end" || event.kind === "turn_error") {
      this.closeTurn(turn, event);
    }
  }

  // A turn runs from when its first message was queued or when the turn before it ended, whichever
  // is later. A result that names no message this session sent (an SDK-internal turn) closes none.
  private closeTurn(
    base: LogFields,
    event: Extract<CoachEvent, { kind: "turn_end" | "turn_error" }>,
  ): void {
    const now = performance.now();
    const closed = this.takeAnswered(event.answered);
    const first = closed[0];
    const startedAt = first ? Math.max(first.queuedAt, this.lastTurnEndedAt) : null;
    const turn = { ...base, turn: first?.turn ?? null, turns: closed.map((open) => open.turn) };
    const timing = {
      duration_ms: startedAt === null ? null : Math.round(now - startedAt),
      waited_ms: first && startedAt !== null ? Math.round(startedAt - first.queuedAt) : null,
    };
    this.lastTurnEndedAt = now;
    if (event.kind === "turn_error") {
      this.log.warn("coach.turn_failed", { ...turn, ...timing, message: event.message });
      return;
    }
    this.log.info("coach.turn_end", {
      ...turn,
      ...timing,
      input_tokens: event.usage.inputTokens,
      output_tokens: event.usage.outputTokens,
    });
  }

  private takeAnswered(answered: string[] | undefined): QueuedTurn[] {
    if (!answered || answered.length === 0) {
      if (this.resultsNameMessages) return [];
      const oldest = this.queuedTurns.shift();
      return oldest ? [oldest] : [];
    }
    this.resultsNameMessages = true;
    const closed = this.queuedTurns.filter((open) => answered.includes(open.uuid));
    const left = this.queuedTurns.filter((open) => !answered.includes(open.uuid));
    this.queuedTurns.splice(0, this.queuedTurns.length, ...left);
    return closed;
  }

  private emit(event: CoachEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        this.log.error("coach.listener_failed", error, { kind: event.kind });
      }
    }
  }
}
