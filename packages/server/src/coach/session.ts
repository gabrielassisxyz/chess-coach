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
  log?: (line: string) => void;
}

const PERMISSION_TIMEOUT_MS = 60_000;

interface PendingPermission {
  resolve: (allow: boolean) => void;
  timer: NodeJS.Timeout;
}

export class CoachSession {
  private readonly eventListeners = new Set<(event: CoachEvent) => void>();
  private readonly permissionListeners = new Set<(request: PermissionRequest) => void>();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  private prompt: CoachPrompt | undefined;
  private row: CoachSessionRow | undefined;
  private queue: AsyncQueue<SDKUserMessage> | undefined;
  private active: CoachQuery | undefined;
  private loop: Promise<void> = Promise.resolve();
  private usageLogged = false;
  private initLogged = false;
  // True from handing the SDK a message until its turn ends: while it is set, notifications wait
  // and are folded into one message instead of queueing behind the answer being written.
  private busy = false;
  // Rows written during boot recovery wait for start(); launching the SDK earlier would start it twice.
  private started = false;

  constructor(private readonly deps: CoachSessionDeps) {
    this.clock = deps.clock ?? systemClock;
    this.log = deps.log ?? ((line) => console.log(line));
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
    this.deliver(text);
  }

  /**
   * Hands the SDK everything the game service left undelivered, as one message. Rows are marked
   * delivered at the moment they are handed over, so a restart never sends a move twice.
   */
  flushNotifications(): void {
    if (!this.started || this.busy) return;
    const row = this.ensureStream();
    const pending = listUndeliveredNotifications(this.deps.db, row.id);
    if (pending.length === 0) return;
    const text = renderNotifications(
      pending.map((message) => JSON.parse(message.contentJson) as CoachNotification),
    );
    this.deps.db.transaction(() => {
      for (const message of pending) markDelivered(this.deps.db, message.id);
    })();
    this.deliver(text);
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

  private deliver(text: string): void {
    this.busy = true;
    this.queue?.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
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
      const timer = setTimeout(() => settle(false), timeoutMs);
      this.pending.set(requestId, { resolve: settle, timer });
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
        for (const event of mapped.events) this.emit(event);
        if (mapped.events.some((event) => event.kind === "turn_end")) {
          this.busy = false;
          this.flushNotifications();
        }
      }
    } catch (error) {
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
    if (this.initLogged) return;
    this.initLogged = true;
    this.log(`coach session ${init.sessionId} model=${init.model} auth=${init.apiKeySource}`);
  }

  private emit(event: CoachEvent): void {
    if (event.kind === "turn_end" && !this.usageLogged) {
      this.usageLogged = true;
      this.log(`coach usage in=${event.usage.inputTokens} out=${event.usage.outputTokens}`);
    }
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        this.log(`coach listener failed: ${String(error)}`);
      }
    }
  }
}
