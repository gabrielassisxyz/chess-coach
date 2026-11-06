import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { COACH_TABS, type CoachTab } from "@chess-coach/shared";
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
import type { NotificationSink } from "../game/notifications.js";
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
import { CoachTurnLedger, type TurnTiming } from "./turn-ledger.js";

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
  /** How long a tab's stream may sit without a turn before its process is closed. */
  idleStreamMs?: number;
  /** Called with the id of each chat line the student sends, so it can be tied to an open item. */
  onUserText?: (messageId: number) => void;
  log?: Log;
}

const PERMISSION_TIMEOUT_MS = 60_000;
// A Claude Code process holds a few hundred MB; a tab nobody talks to should not keep one.
export const IDLE_STREAM_MS = 10 * 60_000;

interface PendingPermission {
  resolve: (allow: boolean) => void;
  timer: NodeJS.Timeout;
}

// Something waiting for its turn with the coach. Notifications are read when the turn comes, so
// everything that arrived while waiting is folded into one message.
type PendingDelivery =
  | { tab: CoachTab; kind: "text"; text: string; origin: LogFields; queuedAt: number }
  | { tab: CoachTab; kind: "notifications"; queuedAt: number };

// One tab's conversation: its open row and, while it is talking, its SDK stream.
interface TabConversation {
  readonly tab: CoachTab;
  resolved: boolean;
  row: CoachSessionRow | undefined;
  queue: AsyncQueue<SDKUserMessage> | undefined;
  active: CoachQuery | undefined;
  loop: Promise<void>;
  ledger: CoachTurnLedger;
  idleTimer: NodeJS.Timeout | undefined;
  // Set when notifications arrived while the coach was answering, so the next flush says so.
  heldWhileBusy: boolean;
}

export type CoachEventListener = (event: CoachEvent, tab: CoachTab) => void;

/**
 * Where each producer's notifications land: the live game is Play's conversation and training is
 * Practice's. A question about a stored game is asked from Games (see ws/review-commands.ts).
 */
export function coachNotificationSinks(coach: Pick<CoachSession, "ensureSessionId">): {
  game: NotificationSink;
  training: NotificationSink;
} {
  return {
    game: { sessionId: () => coach.ensureSessionId("play") },
    training: { sessionId: () => coach.ensureSessionId("practice") },
  };
}

/**
 * The coach's conversations, one per tab. Each tab resumes its own Claude session, started on
 * its first message and closed when idle; at most one turn runs at a time across all of them, in
 * the order the messages arrived, so three tabs never cost three concurrent processes.
 */
export class CoachSession {
  private readonly eventListeners = new Set<CoachEventListener>();
  private readonly permissionListeners = new Set<(request: PermissionRequest) => void>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly clock: Clock;
  private readonly log: Log;
  private readonly tabs: Map<CoachTab, TabConversation>;
  private readonly pending: PendingDelivery[] = [];
  private readonly timing: TurnTiming = { lastTurnEndedAt: 0 };
  private prompt: CoachPrompt | undefined;
  // Numbers each message handed to the SDK, so every tool call and the turn's end name their turn.
  private turn = 0;
  // Rows written during boot recovery wait for start(); launching the SDK earlier would start it twice.
  private started = false;

  constructor(private readonly deps: CoachSessionDeps) {
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? silentLog;
    this.tabs = new Map(COACH_TABS.map((tab) => [tab, this.emptyConversation(tab)]));
  }

  /** The tab's open row, if it has one; resolving it never creates one. */
  conversationRow(tab: CoachTab): CoachSessionRow | undefined {
    return this.resolve(tab).row;
  }

  onEvent(listener: CoachEventListener): () => void {
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
    for (const tab of COACH_TABS) this.resolve(tab);
    this.started = true;
    this.flushNotifications();
  }

  // The game service writes notification rows before the SDK is up (recovery runs at boot), so
  // the tab's row has to exist without its stream being started.
  ensureSessionId(tab: CoachTab): number {
    const conversation = this.resolve(tab);
    conversation.row ??= createCoachSession(
      this.deps.db,
      { promptVersion: this.requirePrompt().version, tab },
      this.clock,
    );
    return conversation.row.id;
  }

  async send(text: string, tab: CoachTab): Promise<void> {
    this.requirePrompt();
    const message = recordUserText(this.deps.db, this.ensureSessionId(tab), text, this.clock);
    this.deps.onUserText?.(message.id);
    this.pending.push({
      tab,
      kind: "text",
      text,
      origin: { source: "user_text", message_id: message.id },
      queuedAt: performance.now(),
    });
    this.pump();
  }

  /**
   * Queues a delivery for every tab with notifications nobody has handed the coach yet. Rows are
   * marked delivered when the turn comes and they are handed over, so a restart never sends a
   * move twice.
   */
  flushNotifications(): void {
    if (!this.started) return;
    for (const conversation of this.tabs.values()) {
      const row = conversation.row;
      if (!row || this.isWaiting(conversation.tab, "notifications")) continue;
      if (listUndeliveredNotifications(this.deps.db, row.id).length === 0) continue;
      if (this.runningTab() !== undefined) conversation.heldWhileBusy = true;
      this.pending.push({
        tab: conversation.tab,
        kind: "notifications",
        queuedAt: performance.now(),
      });
    }
    this.pump();
  }

  /** Closes the tab's conversation; its next message starts an empty one. Other tabs go on. */
  newConversation(tab: CoachTab): void {
    const conversation = this.resolve(tab);
    this.closeStream(conversation);
    this.pending.splice(
      0,
      this.pending.length,
      ...this.pending.filter((waiting) => waiting.tab !== tab),
    );
    const closed = conversation.row;
    if (closed) closeCoachSession(this.deps.db, closed.id, this.clock);
    conversation.row = undefined;
    conversation.heldWhileBusy = false;
    this.log.info("coach.conversation_reset", { tab, coach_session_id: closed?.id ?? null });
    this.pump();
  }

  resolvePermission(requestId: string, allow: boolean): boolean {
    const entry = this.permissions.get(requestId);
    if (!entry) return false;
    entry.resolve(allow);
    return true;
  }

  async stop(): Promise<void> {
    const loops: Promise<void>[] = [];
    for (const conversation of this.tabs.values()) {
      loops.push(conversation.loop);
      this.closeStream(conversation);
    }
    for (const id of [...this.permissions.keys()]) this.resolvePermission(id, false);
    await Promise.all(loops);
  }

  private emptyConversation(tab: CoachTab): TabConversation {
    return {
      tab,
      resolved: false,
      row: undefined,
      queue: undefined,
      active: undefined,
      loop: Promise.resolve(),
      ledger: new CoachTurnLedger(this.log, this.timing),
      idleTimer: undefined,
      heldWhileBusy: false,
    };
  }

  private requirePrompt(): CoachPrompt {
    if (!this.prompt) throw new Error("coach session not started");
    return this.prompt;
  }

  // A stored session is only resumable under the exact prompt it was started with; a stale one is
  // closed and the tab starts empty.
  private resolve(tab: CoachTab): TabConversation {
    const conversation = this.tabs.get(tab) as TabConversation;
    if (conversation.resolved) return conversation;
    this.prompt ??= buildCoachPrompt(this.deps.contentDir);
    const open = findLatestOpenSession(this.deps.db, tab);
    if (open && open.promptVersion === this.prompt.version) {
      markIncompleteIfDangling(this.deps.db, open.id, this.clock);
      conversation.row = open;
    } else if (open) {
      closeCoachSession(this.deps.db, open.id, this.clock);
    }
    conversation.resolved = true;
    return conversation;
  }

  private isWaiting(tab: CoachTab, kind?: PendingDelivery["kind"]): boolean {
    return this.pending.some((waiting) => waiting.tab === tab && (!kind || waiting.kind === kind));
  }

  // The tab whose stream holds a message it has not answered. At most one, by construction.
  private runningTab(): CoachTab | undefined {
    for (const conversation of this.tabs.values()) {
      if (conversation.ledger.openTurns > 0) return conversation.tab;
    }
    return undefined;
  }

  // Hands over what waits, oldest first. While a turn runs, only more text for the same tab may
  // follow it into that stream (the SDK answers it next); anything else waits for the turn to end.
  private pump(): void {
    if (!this.started) return;
    while (this.pending.length > 0) {
      const next = this.pending[0] as PendingDelivery;
      const running = this.runningTab();
      if (running !== undefined && !(next.kind === "text" && next.tab === running)) return;
      this.pending.shift();
      this.dispatch(next);
    }
  }

  private dispatch(next: PendingDelivery): void {
    const conversation = this.resolve(next.tab);
    if (next.kind === "text") {
      this.deliver(conversation, next.text, next.origin, next.queuedAt);
      return;
    }
    const row = conversation.row;
    const waiting = row ? listUndeliveredNotifications(this.deps.db, row.id) : [];
    if (waiting.length === 0) return;
    const contents = waiting.map((message) => JSON.parse(message.contentJson) as CoachNotification);
    this.deps.db.transaction(() => {
      for (const message of waiting) markDelivered(this.deps.db, message.id);
    })();
    this.deliver(
      conversation,
      renderNotifications(contents),
      {
        source: "notifications",
        notification_ids: waiting.map((message) => message.id),
        notification_types: contents.map((content) => (content as { type?: unknown }).type ?? null),
        // These waited for the coach to finish an answer and were folded into one message.
        folded: conversation.heldWhileBusy,
      },
      next.queuedAt,
    );
    conversation.heldWhileBusy = false;
  }

  private deliver(
    conversation: TabConversation,
    text: string,
    origin: LogFields,
    queuedAt: number,
  ): void {
    const queue = this.ensureStream(conversation);
    clearTimeout(conversation.idleTimer);
    this.turn += 1;
    const uuid = randomUUID();
    conversation.ledger.open({ turn: this.turn, uuid, queuedAt });
    // Logged when handed over; the turn may still wait behind an answer this stream is writing.
    this.log.info("coach.turn_start", {
      coach_session_id: conversation.row?.id,
      tab: conversation.tab,
      turn: this.turn,
      message_uuid: uuid,
      queued_behind: conversation.ledger.openTurns - 1,
      ...origin,
      message: text,
    });
    queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid: uuid as `${string}-${string}-${string}-${string}-${string}`,
    });
  }

  private ensureStream(conversation: TabConversation): AsyncQueue<SDKUserMessage> {
    this.ensureSessionId(conversation.tab);
    if (!conversation.queue) this.launch(conversation);
    return conversation.queue as AsyncQueue<SDKUserMessage>;
  }

  private launch(conversation: TabConversation): void {
    const row = conversation.row as CoachSessionRow;
    const queue = new AsyncQueue<SDKUserMessage>();
    const resume = row.claudeSessionId ?? undefined;
    conversation.ledger.reset();
    const stream = this.deps.query({ prompt: queue, options: this.buildOptions(resume) });
    conversation.queue = queue;
    conversation.active = stream;
    conversation.loop = this.consume(conversation, stream, row, resume !== undefined);
  }

  // The row stays open: the next message relaunches the stream resuming its stored id.
  private closeStream(conversation: TabConversation): void {
    clearTimeout(conversation.idleTimer);
    conversation.idleTimer = undefined;
    conversation.queue?.close();
    conversation.active?.close?.();
    conversation.queue = undefined;
    conversation.active = undefined;
    conversation.ledger.reset();
  }

  private scheduleIdleClose(conversation: TabConversation): void {
    clearTimeout(conversation.idleTimer);
    if (!conversation.queue || conversation.ledger.openTurns > 0) return;
    if (this.isWaiting(conversation.tab)) return;
    conversation.idleTimer = setTimeout(() => {
      if (conversation.ledger.openTurns > 0 || this.isWaiting(conversation.tab)) return;
      this.log.info("coach.stream_closed", {
        tab: conversation.tab,
        coach_session_id: conversation.row?.id ?? null,
        reason: "idle",
      });
      this.closeStream(conversation);
    }, this.deps.idleStreamMs ?? IDLE_STREAM_MS);
    // An idle stream is no reason to keep the process alive at shutdown.
    conversation.idleTimer.unref?.();
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
        const entry = this.permissions.get(requestId);
        if (entry) clearTimeout(entry.timer);
        this.permissions.delete(requestId);
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
      this.permissions.set(requestId, {
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

  private async consume(
    conversation: TabConversation,
    stream: CoachQuery,
    row: CoachSessionRow,
    resumed: boolean,
  ): Promise<void> {
    let initSeen = false;
    // A stream closed by a new conversation or by idleness may still drain; nothing it says
    // after that belongs on the page.
    const current = () => conversation.active === stream;
    try {
      for await (const message of stream) {
        const mapped = mapSdkMessage(message);
        if (mapped.init) {
          initSeen = true;
          this.adoptInit(conversation.tab, row, mapped.init);
        }
        for (const item of mapped.finalized)
          recordFinalized(this.deps.db, row.id, item, this.clock);
        if (!current()) continue;
        for (const event of mapped.events) {
          conversation.ledger.record(
            event,
            { coach_session_id: row.id, tab: conversation.tab },
            this.turn,
          );
          this.emit(event, conversation.tab);
        }
        if (mapped.events.some((event) => event.kind === "turn_end")) this.afterTurn(conversation);
      }
    } catch (error) {
      this.log.error("coach.turn_error", error, {
        coach_session_id: row.id,
        tab: conversation.tab,
        turn: conversation.ledger.oldestTurn ?? this.turn,
        queued_turns: conversation.ledger.turnNumbers,
        resumed,
        init_seen: initSeen,
      });
      // A stored session the CLI cannot find is closed so the next send starts a fresh one.
      if (resumed && !initSeen && conversation.row?.id === row.id) {
        closeCoachSession(this.deps.db, row.id, this.clock);
        conversation.row = undefined;
      }
      if (current()) {
        this.emit(
          { kind: "turn_error", message: error instanceof Error ? error.message : String(error) },
          conversation.tab,
        );
      }
    } finally {
      if (current()) {
        this.closeStream(conversation);
        this.pump();
      }
    }
  }

  private afterTurn(conversation: TabConversation): void {
    if (conversation.ledger.openTurns > 0) return;
    this.pump();
    this.scheduleIdleClose(conversation);
  }

  private adoptInit(tab: CoachTab, row: CoachSessionRow, init: SessionInit): void {
    if (row.claudeSessionId !== init.sessionId) {
      storeClaudeSessionId(this.deps.db, row.id, init.sessionId);
      row.claudeSessionId = init.sessionId;
    }
    this.log.info("coach.session", {
      coach_session_id: row.id,
      tab,
      claude_session_id: init.sessionId,
      model: init.model,
      auth: init.apiKeySource,
      tools: init.tools.length,
    });
  }

  private emit(event: CoachEvent, tab: CoachTab): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event, tab);
      } catch (error) {
        this.log.error("coach.listener_failed", error, { kind: event.kind });
      }
    }
  }
}
