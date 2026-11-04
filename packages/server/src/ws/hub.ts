import {
  type ActivityState,
  type ClientCommand,
  ClientCommandSchema,
  type ErrorCode,
  ErrorCodeSchema,
  type ServerEvent,
  type TrainingActivity,
  type TranscriptEntry,
} from "@chess-coach/shared";
import type { WebSocket } from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { ActivityError } from "../activity/errors.js";
import type { ActivityService } from "../activity/service.js";
import type { Clock } from "../clock.js";
import type { CoachEvent } from "../coach/events.js";
import type { PermissionRequest } from "../coach/session.js";
import { type ChatMessage, listChatTail } from "../db/chat.js";
import type { Database } from "../db/open.js";
import { getCurrentElo } from "../db/settings.js";
import { GameError } from "../game/errors.js";
import { SrsError } from "../srs/errors.js";
import { ChatEventNumbering } from "./chat-events.js";
import { isUpgradeAllowed } from "./origin.js";
import { askCoachAboutPly, createCards } from "./review-commands.js";

// The slice of CoachSession the hub drives, so tests can inject a named fake.
export interface CoachPort {
  readonly sessionRow: { id: number } | undefined;
  send(text: string): Promise<void>;
  resolvePermission(requestId: string, allow: boolean): boolean;
  onEvent(listener: (event: CoachEvent) => void): () => void;
  onPermissionRequest(listener: (request: PermissionRequest) => void): () => void;
  ensureSessionId(): number;
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
  | "trainingAnswer"
  | "rateCard"
  | "nextTrainingItem"
  | "endTraining"
>;

export interface HubOptions {
  coach: CoachPort;
  activity: ActivityPort;
  db: Database;
  allowedOrigins: readonly string[];
  pingIntervalMs?: number;
  clock?: Clock;
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

// Game and activity refusals carry a code the browser can switch on; anything else is a fault.
function errorCodeOf(error: unknown): ErrorCode {
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
  const numbering = new ChatEventNumbering();
  const reviewDeps = { db, coach, ...(options.clock ? { clock: options.clock } : {}) };

  const broadcast = (payload: string): void => {
    for (const client of app.websocketServer.clients) {
      if (client.readyState === OPEN) client.send(payload);
    }
  };
  const unsubscribeEvents = coach.onEvent((event) => broadcast(frame(numbering.next(event))));
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
    broadcast(frame({ type: "activity", state }));
    if (state?.kind === "training") broadcast(frame(trainingEventOf(state)));
  });
  app.addHook("onClose", async () => {
    unsubscribeActivity();
    unsubscribeEvents();
    unsubscribePermissions();
  });

  const bootstrap = (): string => {
    const row = coach.sessionRow;
    const rows = row ? listChatTail(db, row.id, BOOTSTRAP_TAIL) : [];
    return frame({
      type: "bootstrap",
      transcript: rows.map(toEntry),
      activity: activity.current(),
      current_elo: getCurrentElo(db),
    });
  };

  const run = async (command: ClientCommand, socket: WebSocket): Promise<void> => {
    switch (command.type) {
      case "say":
        await coach.send(command.text);
        return;
      case "approve_tool":
        if (!coach.resolvePermission(command.request_id, command.allow)) {
          socket.send(errorFrame("unknown_request", "no such pending request", command.command_id));
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
        return;
      case "resign":
        await activity.resign(command.activity_id);
        return;
      case "abort":
        await activity.abort(command.activity_id);
        return;
      case "move":
        if (activity.current()?.kind === "training") {
          throw new ActivityError("use_answer", "grade a training item with answer, not move");
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
        });
        return;
      case "explore":
        await activity.trainingExplore(
          { kind: command.kind, ...(command.uci === undefined ? {} : { uci: command.uci }) },
          command.activity_id,
        );
        return;
      case "answer":
        await activity.trainingAnswer(command.uci, command.activity_id);
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
      case "create_cards":
        socket.send(frame(createCards(reviewDeps, command.game_id)));
        return;
      case "ask_coach_about_ply":
        askCoachAboutPly(reviewDeps, command.game_id, command.ply);
        return;
    }
  };

  const onMessage = (socket: WebSocket, data: Buffer | ArrayBuffer | Buffer[]): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      socket.send(errorFrame("invalid_json", "frame is not valid JSON"));
      return;
    }
    const parsed = ClientCommandSchema.safeParse(raw);
    if (!parsed.success) {
      socket.send(errorFrame("invalid_command", parsed.error.message, commandIdOf(raw)));
      return;
    }
    run(parsed.data, socket).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      socket.send(errorFrame(errorCodeOf(error), message, parsed.data.command_id));
    });
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
    (socket) => {
      let alive = true;
      socket.on("pong", () => {
        alive = true;
      });
      // Pings keep idle proxies from dropping the socket; a peer that never answers is cut.
      const timer = setInterval(() => {
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
      }, options.pingIntervalMs ?? PING_INTERVAL_MS);
      socket.on("close", () => clearInterval(timer));
      socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => onMessage(socket, data));
      socket.send(bootstrap());
    },
  );
}
