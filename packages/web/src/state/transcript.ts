import type {
  ActivityState,
  ChatEvent,
  PermissionRequestEvent,
  ServerEvent,
  TranscriptEntry,
} from "@chess-coach/shared";

export type ChatItem =
  | { type: "text"; key: string; role: "user" | "assistant"; text: string; liveId?: number }
  | {
      type: "tool";
      key: string;
      toolUseId: string;
      name: string;
      input: unknown;
      result?: { output: unknown };
    }
  | { type: "turn_error"; key: string; message: string }
  | { type: "notice"; key: string; text: string };

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
}

export interface ChatState {
  items: ChatItem[];
  permissions: PendingPermission[];
  lastError: string | null;
  errorCount: number;
  localCount: number;
  activity: ActivityState | null;
}

export const initialChatState: ChatState = {
  items: [],
  permissions: [],
  lastError: null,
  errorCount: 0,
  localCount: 0,
  activity: null,
};

function textOf(content: unknown): string {
  const text = (content as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

function applyEntry(items: ChatItem[], entry: TranscriptEntry): void {
  const key = `row-${entry.id}`;
  const content = entry.content as Record<string, unknown> | null;
  if (entry.kind === "text" && entry.role !== "system") {
    items.push({ type: "text", key, role: entry.role, text: textOf(content) });
  } else if (entry.kind === "tool_use") {
    items.push({
      type: "tool",
      key,
      toolUseId: String(content?.toolUseId),
      name: String(content?.name),
      input: content?.input,
    });
  } else if (entry.kind === "tool_result") {
    attachResult(items, String(content?.toolUseId), content?.output);
  } else if (entry.kind === "incomplete") {
    items.push({ type: "notice", key, text: "The previous answer was interrupted." });
  } else if (entry.kind === "notification") {
    // A game report is for the coach; it carries no text of its own to show the student.
    const text = textOf(content);
    if (text !== "") items.push({ type: "notice", key, text });
  }
}

function attachResult(items: ChatItem[], toolUseId: string, output: unknown): void {
  const card = items.find((item) => item.type === "tool" && item.toolUseId === toolUseId);
  if (card?.type === "tool") card.result = { output };
}

function applyChat(state: ChatState, event: ChatEvent): ChatState {
  const items = state.items.map((item) => ({ ...item }));
  const payload = event.event;
  const key = `live-${event.seq}`;
  if (payload.kind === "text_delta") {
    const last = items.at(-1);
    if (last?.type === "text" && last.role === "assistant" && last.liveId === event.message_id) {
      last.text += payload.text;
    } else {
      items.push({
        type: "text",
        key,
        role: "assistant",
        text: payload.text,
        liveId: event.message_id,
      });
    }
  } else if (payload.kind === "tool_use") {
    items.push({
      type: "tool",
      key,
      toolUseId: payload.tool_use_id,
      name: payload.name,
      input: payload.input,
    });
  } else if (payload.kind === "tool_result") {
    attachResult(items, payload.tool_use_id, payload.output);
  } else if (payload.kind === "turn_error") {
    items.push({ type: "turn_error", key, message: payload.message });
  }
  return { ...state, items };
}

function addPermission(state: ChatState, event: PermissionRequestEvent): ChatState {
  const request = { requestId: event.request_id, toolName: event.tool_name, input: event.input };
  return { ...state, permissions: [...state.permissions, request] };
}

// errorCount lets a view react to every refusal, including a repeat of the same message.
function withError(state: ChatState, message: string): ChatState {
  return { ...state, lastError: message, errorCount: state.errorCount + 1 };
}

export type ChatAction =
  | { type: "server"; event: ServerEvent }
  | { type: "local_say"; text: string }
  | { type: "permission_answered"; requestId: string }
  | { type: "protocol_error"; message: string }
  | { type: "dismiss_error" };

// A bootstrap replaces everything: after a reconnect the server's transcript is the truth, so
// nothing from the previous socket (half-streamed text, open approval cards) survives it.
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "local_say") {
    const key = `local-${state.localCount}`;
    const item: ChatItem = { type: "text", key, role: "user", text: action.text };
    return { ...state, items: [...state.items, item], localCount: state.localCount + 1 };
  }
  if (action.type === "permission_answered") {
    const permissions = state.permissions.filter((p) => p.requestId !== action.requestId);
    return { ...state, permissions };
  }
  if (action.type === "protocol_error") return withError(state, action.message);
  if (action.type === "dismiss_error") return { ...state, lastError: null };

  const event = action.event;
  switch (event.type) {
    case "bootstrap": {
      const items: ChatItem[] = [];
      for (const entry of event.transcript) applyEntry(items, entry);
      return { ...initialChatState, items, localCount: state.localCount, activity: event.activity };
    }
    case "chat":
      return applyChat(state, event);
    case "permission_request":
      return addPermission(state, event);
    case "activity":
      return { ...state, activity: event.state };
    case "error":
      return withError(state, event.message);
    // The activity event that precedes it already carries the same item and status.
    case "training":
      return state;
  }
}
