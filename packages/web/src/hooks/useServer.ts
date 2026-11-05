import { type ActivityCommand, ClientCommandSchema, ServerEventSchema } from "@chess-coach/shared";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { reportClient } from "../state/client-log.js";
import { type ChatState, chatReducer, initialChatState } from "../state/transcript.js";

export type ConnectionState = "connected" | "reconnecting";

// The slice of WebSocket the hook uses, so tests can drive it with a named fake.
export interface SocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface UseServerOptions {
  url?: string;
  createSocket?: (url: string) => SocketLike;
}

export interface ServerApi extends ChatState {
  connection: ConnectionState;
  // Failed connection attempts since the socket was last open; 0 while connected and before the first try fails.
  reconnectAttempt: number;
  say(text: string): boolean;
  approve(requestId: string, allow: boolean): void;
  dismissError(): void;
  send(command: DistributiveOmit<ActivityCommand, "command_id">): boolean;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 10_000;
const SOCKET_OPEN = 1;

// The browser saw a refusal; the server logged it too, and the pair proves it reached the page.
function reportErrorFrame(event: {
  code: string;
  message: string;
  command_id?: string | undefined;
}): void {
  reportClient({
    level: "warn",
    event: "error_frame",
    message: event.message,
    context: { code: event.code, command_id: event.command_id ?? null },
  });
}

function defaultUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/api/ws`;
}

export function useServer(options: UseServerOptions = {}): ServerApi {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [connection, setConnection] = useState<ConnectionState>("reconnecting");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const socketRef = useRef<SocketLike | null>(null);
  const commandCount = useRef(0);
  const url = options.url ?? defaultUrl();
  const createSocket = options.createSocket;

  useEffect(() => {
    let disposed = false;
    let delay = BACKOFF_START_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const open = (): void => {
      const socket = createSocket ? createSocket(url) : (new WebSocket(url) as SocketLike);
      socketRef.current = socket;
      socket.onopen = () => {
        if (failures > 0) {
          reportClient({
            level: "info",
            event: "ws_reconnected",
            message: `socket open again after ${failures} attempts`,
            context: { attempts: failures },
          });
        }
        failures = 0;
        delay = BACKOFF_START_MS;
        setConnection("connected");
        setReconnectAttempt(0);
      };
      socket.onmessage = (message) => {
        const parsed = ServerEventSchema.safeParse(parseJson(message.data));
        if (parsed.success) {
          if (parsed.data.type === "error") reportErrorFrame(parsed.data);
          dispatch({ type: "server", event: parsed.data });
        } else {
          reportClient({
            level: "warn",
            event: "malformed_frame",
            message: parsed.error.message,
            context: { frame: String(message.data).slice(0, 2048) },
          });
          dispatch({ type: "protocol_error", message: "received a malformed server frame" });
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        failures += 1;
        reportClient({
          level: "warn",
          event: "ws_closed",
          message: "socket closed; reconnecting",
          context: { attempt: failures, retry_in_ms: delay },
        });
        socketRef.current = null;
        setConnection("reconnecting");
        setReconnectAttempt((count) => count + 1);
        timer = setTimeout(open, delay);
        delay = Math.min(delay * 2, BACKOFF_MAX_MS);
      };
    };
    open();

    return () => {
      disposed = true;
      clearTimeout(timer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [url, createSocket]);

  // Nothing is queued while disconnected: a command sent into a dead socket would replay into
  // a conversation the user has already seen move on.
  const sendCommand = useCallback((build: (commandId: string) => unknown): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    commandCount.current += 1;
    const command = ClientCommandSchema.safeParse(build(`c${commandCount.current}`));
    if (!command.success) return false;
    socket.send(JSON.stringify(command.data));
    return true;
  }, []);

  const say = useCallback(
    (text: string): boolean => {
      const sent = sendCommand((command_id) => ({ type: "say", command_id, text }));
      if (sent) dispatch({ type: "local_say", text });
      return sent;
    },
    [sendCommand],
  );

  const approve = useCallback(
    (requestId: string, allow: boolean): void => {
      const sent = sendCommand((command_id) => ({
        type: "approve_tool",
        command_id,
        request_id: requestId,
        allow,
      }));
      if (sent) dispatch({ type: "permission_answered", requestId });
    },
    [sendCommand],
  );

  const dismissError = useCallback(() => dispatch({ type: "dismiss_error" }), []);

  const send = useCallback(
    (command: DistributiveOmit<ActivityCommand, "command_id">): boolean =>
      sendCommand((command_id) => ({ ...command, command_id })),
    [sendCommand],
  );

  return { ...state, connection, reconnectAttempt, say, approve, dismissError, send };
}

function parseJson(data: unknown): unknown {
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}
