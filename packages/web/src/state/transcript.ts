import type {
  ActivityState,
  ChatEvent,
  ErrorCode,
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

// What the coach is doing right now, derived from the chat events alone.
export type CoachTurn = "idle" | "thinking" | "streaming";

export interface ChatState {
  items: ChatItem[];
  turn: CoachTurn;
  permissions: PendingPermission[];
  lastError: string | null;
  // The server's code for lastError; null for a failure the page itself raised.
  lastErrorCode: ErrorCode | null;
  errorCount: number;
  localCount: number;
  activity: ActivityState | null;
  currentElo?: number | null;
  // Cards made from each game since the page loaded, summed so a repeat click cannot show 0 over 3.
  cardsCreated: Record<number, number>;
}

export const initialChatState: ChatState = {
  items: [],
  turn: "idle",
  permissions: [],
  lastError: null,
  lastErrorCode: null,
  errorCount: 0,
  localCount: 0,
  activity: null,
  currentElo: null,
  cardsCreated: {},
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
  const turn = turnAfter(payload.kind);
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
  return { ...state, items, turn };
}

// A tool call or its result means the coach is still working on the answer; only the end of
// the turn, or its failure, hands control back, so a turn that dies cannot leave "thinking" on.
function turnAfter(kind: ChatEvent["event"]["kind"]): CoachTurn {
  switch (kind) {
    case "text_delta":
      return "streaming";
    case "tool_use":
    case "tool_result":
      return "thinking";
    case "turn_end":
    case "turn_error":
      return "idle";
  }
}

function addPermission(state: ChatState, event: PermissionRequestEvent): ChatState {
  const request = { requestId: event.request_id, toolName: event.tool_name, input: event.input };
  return { ...state, permissions: [...state.permissions, request] };
}

// errorCount lets a view react to every refusal, including a repeat of the same message.
function withError(state: ChatState, message: string, code: ErrorCode | null): ChatState {
  return { ...state, lastError: message, lastErrorCode: code, errorCount: state.errorCount + 1 };
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
    return {
      ...state,
      items: [...state.items, item],
      turn: "thinking",
      localCount: state.localCount + 1,
    };
  }
  if (action.type === "permission_answered") {
    const permissions = state.permissions.filter((p) => p.requestId !== action.requestId);
    return { ...state, permissions };
  }
  if (action.type === "protocol_error") return withError(state, action.message, null);
  if (action.type === "dismiss_error") return { ...state, lastError: null };

  const event = action.event;
  switch (event.type) {
    case "bootstrap": {
      const items: ChatItem[] = [];
      for (const entry of event.transcript) applyEntry(items, entry);
      return {
        ...initialChatState,
        items,
        localCount: state.localCount,
        activity: event.activity,
        currentElo: event.current_elo ?? null,
      };
    }
    case "chat":
      return applyChat(state, event);
    case "permission_request":
      return addPermission(state, event);
    case "activity":
      return { ...state, activity: event.state };
    case "error":
      return withError(state, event.message, event.code);
    // The activity event that precedes it already carries the same item and status.
    case "training":
      return state;
    case "cards_created": {
      const total = (state.cardsCreated[event.game_id] ?? 0) + event.count;
      return { ...state, cardsCreated: { ...state.cardsCreated, [event.game_id]: total } };
    }
  }
}
