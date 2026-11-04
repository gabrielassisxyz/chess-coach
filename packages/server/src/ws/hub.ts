import {
  type ClientCommand,
  ClientCommandSchema,
  type ErrorCode,
  type ServerEvent,
  type TranscriptEntry,
} from "@chess-coach/shared";
import type { WebSocket } from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { CoachEvent } from "../coach/events.js";
import type { PermissionRequest } from "../coach/session.js";
import { type ChatMessage, listChatTail } from "../db/chat.js";
import type { Database } from "../db/open.js";
import { ChatEventNumbering } from "./chat-events.js";
import { isUpgradeAllowed } from "./origin.js";

// The slice of CoachSession the hub drives, so tests can inject a named fake.
export interface CoachPort {
  readonly sessionRow: { id: number } | undefined;
  send(text: string): Promise<void>;
  resolvePermission(requestId: string, allow: boolean): boolean;
  onEvent(listener: (event: CoachEvent) => void): () => void;
  onPermissionRequest(listener: (request: PermissionRequest) => void): () => void;
}

export interface HubOptions {
  coach: CoachPort;
  db: Database;
  allowedOrigins: readonly string[];
  pingIntervalMs?: number;
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

function commandIdOf(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const id = (raw as { command_id?: unknown }).command_id;
  return typeof id === "string" && id !== "" && id.length <= 64 ? id : undefined;
}

// The websocket plugin is registered by the caller on the root instance, so the server decorator
// and injectWS stay visible outside this encapsulated context.
export async function registerHub(app: FastifyInstance, options: HubOptions): Promise<void> {
  const { coach, db, allowedOrigins } = options;
  const numbering = new ChatEventNumbering();

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
  app.addHook("onClose", async () => {
    unsubscribeEvents();
    unsubscribePermissions();
  });

  const bootstrap = (): string => {
    const row = coach.sessionRow;
    const rows = row ? listChatTail(db, row.id, BOOTSTRAP_TAIL) : [];
    return frame({ type: "bootstrap", transcript: rows.map(toEntry) });
  };

  const run = async (command: ClientCommand, socket: WebSocket): Promise<void> => {
    if (command.type === "say") {
      await coach.send(command.text);
      return;
    }
    if (!coach.resolvePermission(command.request_id, command.allow)) {
      socket.send(errorFrame("unknown_request", "no such pending request", command.command_id));
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
      socket.send(errorFrame("coach_error", message, parsed.data.command_id));
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
