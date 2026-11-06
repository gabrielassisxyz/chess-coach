import {
  type ActivityState,
  type ClientCommand,
  ClientCommandSchema,
  COACH_TABS,
  type CoachTab,
  type ErrorCode,
  ErrorCodeSchema,
  type ServerEvent,
  type TrainingActivity,
  type TrainingMode,
  type TranscriptEntry,
} from "@chess-coach/shared";
import type { WebSocket } from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { ActivityError } from "../activity/errors.js";
import type { ActivityService } from "../activity/service.js";
import { type Clock, systemClock } from "../clock.js";
import type { CoachEventListener, PermissionRequest } from "../coach/session.js";
import { recordDivider } from "../coach/transcript.js";
import { type ChatMessage, listChatTail } from "../db/chat.js";
import type { Database } from "../db/open.js";
import { getCurrentElo } from "../db/settings.js";
import { GameError } from "../game/errors.js";
import { type Log, silentLog } from "../log.js";
import { SrsError } from "../srs/errors.js";
import { ChatEventNumbering } from "./chat-events.js";
import { isUpgradeAllowed } from "./origin.js";
import { askCoachAboutPly, createCards } from "./review-commands.js";

// The slice of CoachSession the hub drives, so tests can inject a named fake.
export interface CoachPort {
  conversationRow(tab: CoachTab): { id: number } | undefined;
  send(text: string, tab: CoachTab): Promise<void>;
  newConversation(tab: CoachTab): void;
  resolvePermission(requestId: string, allow: boolean): boolean;
  onEvent(listener: CoachEventListener): () => void;
  onPermissionRequest(listener: (request: PermissionRequest) => void): () => void;
  ensureSessionId(tab: CoachTab): number;
  flushNotifications(): void;
}

// The slice of ActivityService the hub drives.
export type ActivityPort = Pick<
  ActivityService,
  | "current"
  | "onState"
  | "openGame"
  | "selectReviewPly"
  | "leaveDemo"
  | "newGame"
  | "resign"
  | "abort"
  | "playerMove"
  | "undo"
  | "startTraining"
  | "trainingExplore"
  | "trainingTry"
  | "trainingShowSolution"
  | "trainingHint"
  | "rateCard"
  | "nextTrainingItem"
  | "endTraining"
  | "pausedTraining"
  | "resumeTraining"
  | "discardTraining"
>;

export interface HubOptions {
  coach: CoachPort;
  activity: ActivityPort;
  db: Database;
  allowedOrigins: readonly string[];
  pingIntervalMs?: number;
  clock?: Clock;
  log?: Log;
}

export const BOOTSTRAP_TAIL = 200;
export const MAX_FRAME_BYTES = 64 * 1024;
const PING_INTERVAL_MS = 30_000;
const OPEN = 1;

function toEntry(row: ChatMessage): TranscriptEntry {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    kind: row.kind,
    content: JSON.parse(row.contentJson) as unknown,
    created_at: row.createdAt,
  };
}

// The words a divider shows before its time, in the language the student reads the chat in.
const TRAINING_LABEL: Record<TrainingMode, string> = {
  srs: "Revisão",
  puzzles: "Puzzles",
  openings: "Aberturas",
};
const GAME_LABEL = "Partida";

function frame(event: ServerEvent): string {
  return JSON.stringify(event);
}

function errorFrame(code: ErrorCode, message: string, commandId?: string): string {
  return frame({
    type: "error",
    code,
    message,
    ...(commandId === undefined ? {} : { command_id: commandId }),
  });
}

// A refusal the hub itself raises, so it reaches the browser and the log by the same path.
class HubRefusal extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HubRefusal";
  }
}

// Game and activity refusals carry a code the browser can switch on; anything else is a fault.
function errorCodeOf(error: unknown): ErrorCode {
  if (error instanceof HubRefusal) return error.code;
  if (error instanceof GameError || error instanceof ActivityError || error instanceof SrsError) {
    const code = ErrorCodeSchema.safeParse(error.code);
    if (code.success) return code.data;
  }
  return "coach_error";
}

function trainingEventOf(state: TrainingActivity): ServerEvent {
  return {
    type: "training",
    activity_id: state.activity_id,
    mode: state.mode,
    item: state.item,
    status: state.status,
    expected: state.expected,
    summary: state.summary,
  };
}

function commandIdOf(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const id = (raw as { command_id?: unknown }).command_id;
  return typeof id === "string" && id !== "" && id.length <= 64 ? id : undefined;
}

// The websocket plugin is registered by the caller on the root instance, so the server decorator
// and injectWS stay visible outside this encapsulated context.
export async function registerHub(app: FastifyInstance, options: HubOptions): Promise<void> {
  const { coach, activity, db, allowedOrigins } = options;
  const log = options.log ?? silentLog;
  const numbering = new ChatEventNumbering();
  // A number per connection ties every command and refusal to the browser tab that sent it.
  let connections = 0;
  const reviewDeps = { db, coach, ...(options.clock ? { clock: options.clock } : {}) };

  const broadcast = (payload: string): void => {
    for (const client of app.websocketServer.clients) {
      if (client.readyState === OPEN) client.send(payload);
    }
  };
  const unsubscribeEvents = coach.onEvent((event, tab) =>
    broadcast(frame(numbering.next(event, tab))),
  );
  const unsubscribePermissions = coach.onPermissionRequest((request) =>
    broadcast(
      frame({
        type: "permission_request",
        request_id: request.requestId,
        tool_name: request.toolName,
        input: request.input,
      }),
    ),
  );
  const unsubscribeActivity = activity.onState((state: ActivityState | null) => {
    broadcast(frame({ type: "activity", state, paused_training: activity.pausedTraining() }));
    if (state?.kind === "training") broadcast(frame(trainingEventOf(state)));
  });
  app.addHook("onClose", async () => {
    unsubscribeActivity();
    unsubscribeEvents();
    unsubscribePermissions();
  });

  const tailOf = (tab: CoachTab): TranscriptEntry[] => {
    const row = coach.conversationRow(tab);
    return row ? listChatTail(db, row.id, BOOTSTRAP_TAIL).map(toEntry) : [];
  };

  // Written after the command succeeded, so a refused start leaves no rule behind.
  const divide = (tab: CoachTab, label: string): void => {
    const row = recordDivider(db, coach.ensureSessionId(tab), label, options.clock ?? systemClock);
    broadcast(frame({ type: "chat_row", tab, entry: toEntry(row) }));
  };

  const bootstrap = (): string => {
    const [play, games, practice] = COACH_TABS.map(tailOf) as [
      TranscriptEntry[],
      TranscriptEntry[],
      TranscriptEntry[],
    ];
    return frame({
      type: "bootstrap",
      conversations: { play, games, practice },
      activity: activity.current(),
      current_elo: getCurrentElo(db),
      paused_training: activity.pausedTraining(),
    });
  };

  const run = async (command: ClientCommand, socket: WebSocket): Promise<void> => {
    switch (command.type) {
      case "say":
        await coach.send(command.text, command.tab);
        return;
      case "new_conversation":
        coach.newConversation(command.tab);
        broadcast(frame({ type: "conversation_started", tab: command.tab }));
        return;
      case "approve_tool":
        if (!coach.resolvePermission(command.request_id, command.allow)) {
          throw new HubRefusal("unknown_request", "no such pending request");
        }
        return;
      case "open_game":
        await activity.openGame(command.game_id);
        return;
      case "select_review_ply":
        await activity.selectReviewPly(command.game_id, command.ply, command.activity_id);
        return;
      case "leave_demo":
        await activity.leaveDemo(command.activity_id);
        return;
      case "new_game":
        await activity.newGame({
          color: command.color,
          ...(command.elo === undefined ? {} : { elo: command.elo }),
        });
        divide("play", GAME_LABEL);
        return;
      case "resign":
        await activity.resign(command.activity_id);
        return;
      case "abort":
        await activity.abort(command.activity_id);
        return;
      case "move":
        if (activity.current()?.kind === "training") {
          throw new ActivityError("use_try_move", "grade a training item with try_move, not move");
        }
        await activity.playerMove(
          {
            from: command.from,
            to: command.to,
            ...(command.promotion === undefined ? {} : { promotion: command.promotion }),
          },
          command.activity_id,
        );
        return;
      case "undo":
        await activity.undo(command.activity_id);
        return;
      case "start_training":
        await activity.startTraining({
          mode: command.mode,
          ...(command.motif === undefined ? {} : { motif: command.motif }),
          ...(command.color === undefined ? {} : { color: command.color }),
          ...(command.size === undefined ? {} : { size: command.size }),
        });
        divide("practice", TRAINING_LABEL[command.mode]);
        return;
      case "explore":
        await activity.trainingExplore(
          { kind: command.kind, ...(command.uci === undefined ? {} : { uci: command.uci }) },
          command.activity_id,
        );
        return;
      case "try_move":
        await activity.trainingTry(command.uci, command.activity_id);
        return;
      case "show_solution":
        await activity.trainingShowSolution(command.activity_id);
        return;
      case "hint":
        await activity.trainingHint(command.activity_id);
        return;
      case "rate_card":
        await activity.rateCard(command.exposure_id, command.quality, command.activity_id);
        return;
      case "next_training_item":
        await activity.nextTrainingItem(command.activity_id);
        return;
      case "end_training":
        await activity.endTraining(command.activity_id);
        return;
      case "resume_training":
        await activity.resumeTraining();
        return;
      case "discard_training":
        await activity.discardTraining();
        return;
      case "create_cards": {
        const created = createCards(reviewDeps, command.game_id);
        log.info("review.cards_created", { game_id: command.game_id, result: created });
        socket.send(frame(created));
        return;
      }
      case "ask_coach_about_ply":
        askCoachAboutPly(reviewDeps, command.game_id, command.ply);
        return;
    }
  };

  const onMessage = (
    socket: WebSocket,
    conn: number,
    data: Buffer | ArrayBuffer | Buffer[],
  ): void => {
    const text = data.toString();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      log.warn("ws.invalid_frame", {
        conn,
        reason: "invalid_json",
        bytes: text.length,
        frame: text,
      });
      socket.send(errorFrame("invalid_json", "frame is not valid JSON"));
      return;
    }
    const parsed = ClientCommandSchema.safeParse(raw);
    if (!parsed.success) {
      const commandId = commandIdOf(raw);
      log.warn("ws.invalid_frame", {
        conn,
        reason: "invalid_command",
        command_id: commandId,
        message: parsed.error.message,
        frame: raw,
      });
      socket.send(errorFrame("invalid_command", parsed.error.message, commandId));
      return;
    }
    const command = parsed.data;
    const meta = { conn, command_id: command.command_id, type: command.type };
    log.info("ws.command", { ...meta, command });
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    run(command, socket).then(
      () => log.info("ws.command_done", { ...meta, ok: true, duration_ms: elapsed() }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const code = errorCodeOf(error);
        // A refusal is the app saying no; anything else is a fault worth its stack.
        if (code === "coach_error") {
          log.error("ws.command_failed", error, { ...meta, code, duration_ms: elapsed() });
        } else {
          log.warn("ws.command_failed", { ...meta, code, message, duration_ms: elapsed() });
        }
        socket.send(errorFrame(code, message, command.command_id));
      },
    );
  };

  app.get(
    "/api/ws",
    {
      websocket: true,
      onRequest: async (request, reply) => {
        const { origin, host } = request.headers;
        if (!isUpgradeAllowed({ origin, host }, allowedOrigins)) {
          await reply.code(403).send({ error: "origin not allowed" });
        }
      },
    },
    (socket, request) => {
      const conn = ++connections;
      const openedAt = performance.now();
      log.info("ws.connect", { conn, origin: request.headers.origin ?? null });
      let alive = true;
      socket.on("pong", () => {
        alive = true;
      });
      // Pings keep idle proxies from dropping the socket; a peer that never answers is cut.
      const timer = setInterval(() => {
        if (!alive) {
          log.warn("ws.ping_timeout", { conn });
          return socket.terminate();
        }
        alive = false;
        socket.ping();
      }, options.pingIntervalMs ?? PING_INTERVAL_MS);
      socket.on("close", (code: number) => {
        clearInterval(timer);
        log.info("ws.disconnect", {
          conn,
          code,
          duration_ms: Math.round(performance.now() - openedAt),
        });
      });
      socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) =>
        onMessage(socket, conn, data),
      );
      socket.send(bootstrap());
    },
  );
}
