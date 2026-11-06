import {
  type ActivityState,
  type ChatEvent,
  COACH_TABS,
  type CoachTab,
  type ErrorCode,
  type PausedTraining,
  type PermissionRequestEvent,
  type ServerEvent,
  type TranscriptEntry,
} from "@chess-coach/shared";

export type ChatItem =
  | { type: "text"; key: string; role: "user" | "assistant"; text: string; liveId?: number }
  | {
      type: "tool";
      key: string;
      toolUseId: string;
      name: string;
      input: unknown;
      result?: { output: unknown; isError?: boolean };
    }
  | { type: "turn_error"; key: string; message: string }
  | { type: "notice"; key: string; text: string }
  // Where a practice queue or a game began inside the tab's conversation.
  | { type: "divider"; key: string; label: string; at: string };

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
}

// What the coach is doing right now, derived from the chat events alone.
export type CoachTurn = "idle" | "thinking" | "streaming";

// One tab's conversation with the coach, as the page knows it.
export interface TabChat {
  items: ChatItem[];
  turn: CoachTurn;
  // Assistant messages that started live since the page loaded; a view that was away compares it to what it last saw.
  coachMessages: number;
  // When the newest entry was written or arrived, in ms since the epoch; null for an empty one.
  lastMessageAt: number | null;
}

export type TabChats = Record<CoachTab, TabChat>;

export const emptyTabChat: TabChat = {
  items: [],
  turn: "idle",
  coachMessages: 0,
  lastMessageAt: null,
};

function emptyTabChats(): TabChats {
  return { play: emptyTabChat, games: emptyTabChat, practice: emptyTabChat };
}

export interface ChatState {
  conversations: TabChats;
  permissions: PendingPermission[];
  lastError: string | null;
  // The server's code for lastError; null for a failure the page itself raised.
  lastErrorCode: ErrorCode | null;
  errorCount: number;
  localCount: number;
  activity: ActivityState | null;
  currentElo?: number | null;
  // The practice queue the server holds open while the board shows something else.
  pausedTraining?: PausedTraining | null;
  // Cards made from each game since the page loaded, summed so a repeat click cannot show 0 over 3.
  cardsCreated: Record<number, number>;
  // A practice item ended and its notification was sent, so the coach owes a reply for it.
  practiceReplyPending: boolean;
  // The ended item that last set the flag: a later activity event for the same item (a demo
  // closing, a reconnect echo) must not ask for a reply the coach has already given.
  practiceEndedItem: string | null;
}

export const initialChatState: ChatState = {
  conversations: emptyTabChats(),
  permissions: [],
  lastError: null,
  lastErrorCode: null,
  errorCount: 0,
  localCount: 0,
  activity: null,
  currentElo: null,
  pausedTraining: null,
  cardsCreated: {},
  practiceReplyPending: false,
  practiceEndedItem: null,
};

function textOf(content: unknown): string {
  const text = (content as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

function applyEntry(items: ChatItem[], entry: TranscriptEntry): void {
  const key = `row-${entry.id}`;
  const content = entry.content as Record<string, unknown> | null;
  if (entry.kind === "text") {
    if (entry.role === "system") {
      const label = String(content?.label ?? "");
      items.push({ type: "divider", key, label, at: String(content?.at ?? entry.created_at) });
    } else {
      items.push({ type: "text", key, role: entry.role, text: textOf(content) });
    }
  } else if (entry.kind === "tool_use") {
    items.push({
      type: "tool",
      key,
      toolUseId: String(content?.toolUseId),
      name: String(content?.name),
      input: content?.input,
    });
  } else if (entry.kind === "tool_result") {
    attachResult(items, String(content?.toolUseId), content?.output, content?.isError === true);
  } else if (entry.kind === "incomplete") {
    items.push({ type: "notice", key, text: "The previous answer was interrupted." });
  } else if (entry.kind === "notification") {
    // A game report is for the coach; it carries no text of its own to show the student.
    const text = textOf(content);
    if (text !== "") items.push({ type: "notice", key, text });
  }
}

function attachResult(
  items: ChatItem[],
  toolUseId: string,
  output: unknown,
  isError: boolean,
): void {
  const card = items.find((item) => item.type === "tool" && item.toolUseId === toolUseId);
  if (card?.type === "tool") card.result = isError ? { output, isError } : { output };
}

function entriesChat(entries: TranscriptEntry[]): TabChat {
  const items: ChatItem[] = [];
  for (const entry of entries) applyEntry(items, entry);
  const newest = entries.at(-1);
  const lastMessageAt = newest ? Date.parse(newest.created_at) : null;
  return {
    ...emptyTabChat,
    items,
    lastMessageAt: Number.isNaN(lastMessageAt) ? null : lastMessageAt,
  };
}

function withTab(state: ChatState, tab: CoachTab, chat: TabChat): ChatState {
  return { ...state, conversations: { ...state.conversations, [tab]: chat } };
}

function applyRow(state: ChatState, tab: CoachTab, entry: TranscriptEntry): ChatState {
  const chat = state.conversations[tab];
  const items = [...chat.items];
  applyEntry(items, entry);
  return withTab(state, tab, { ...chat, items, lastMessageAt: Date.now() });
}

function applyChat(state: ChatState, event: ChatEvent): ChatState {
  const chat = state.conversations[event.tab];
  const items = chat.items.map((item) => ({ ...item }));
  const payload = event.event;
  const key = `live-${event.seq}`;
  const turn = turnAfter(payload.kind);
  let coachMessages = chat.coachMessages;
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
      coachMessages += 1;
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
    attachResult(items, payload.tool_use_id, payload.output, payload.is_error === true);
  } else if (payload.kind === "turn_error") {
    items.push({ type: "turn_error", key, message: payload.message });
  }
  // The coach's reply has started or finished, so an ended practice item no longer waits for one.
  const replied =
    payload.kind === "text_delta" || payload.kind === "turn_end" || payload.kind === "turn_error";
  const practiceReplyPending =
    replied && event.tab === "practice" ? false : state.practiceReplyPending;
  const next = withTab(state, event.tab, { items, turn, coachMessages, lastMessageAt: Date.now() });
  return { ...next, practiceReplyPending };
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
  | { type: "local_say"; text: string; tab: CoachTab }
  | { type: "permission_answered"; requestId: string }
  | { type: "protocol_error"; message: string }
  | { type: "dismiss_error" };

// A practice item whose notification the coach has not answered yet: solved or failed with
// the queue still open. A rated card or a finished queue owes no reply.
function endedItemKey(activity: ActivityState | null): string | null {
  if (activity?.kind !== "training" || activity.summary !== null) return null;
  if (activity.status !== "solved" && activity.status !== "failed") return null;
  return `${activity.served_at}#${activity.item.position_in_queue}`;
}

function pendingAfter(state: ChatState, activity: ActivityState | null): Partial<ChatState> {
  const key = endedItemKey(activity);
  if (key === null) return { practiceReplyPending: false };
  if (key === state.practiceEndedItem) return {};
  return { practiceReplyPending: true, practiceEndedItem: key };
}

// A bootstrap replaces everything: after a reconnect the server's transcript is the truth, so
// nothing from the previous socket (half-streamed text, open approval cards) survives it.
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "local_say") {
    const key = `local-${state.localCount}`;
    const item: ChatItem = { type: "text", key, role: "user", text: action.text };
    const chat = state.conversations[action.tab];
    const said = withTab(state, action.tab, {
      ...chat,
      items: [...chat.items, item],
      turn: "thinking",
      lastMessageAt: Date.now(),
    });
    return { ...said, localCount: state.localCount + 1 };
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
      const conversations = Object.fromEntries(
        COACH_TABS.map((tab) => [tab, entriesChat(event.conversations[tab])]),
      ) as TabChats;
      return {
        ...initialChatState,
        conversations,
        localCount: state.localCount,
        activity: event.activity,
        currentElo: event.current_elo ?? null,
        pausedTraining: event.paused_training ?? null,
      };
    }
    case "chat":
      return applyChat(state, event);
    case "chat_row":
      return applyRow(state, event.tab, event.entry);
    // The count is kept so a view comparing it to what it last saw is not reset by the fresh start.
    case "conversation_started":
      return withTab(state, event.tab, {
        ...emptyTabChat,
        coachMessages: state.conversations[event.tab].coachMessages,
      });
    case "permission_request":
      return addPermission(state, event);
    case "activity":
      return {
        ...state,
        activity: event.state,
        pausedTraining: event.paused_training ?? null,
        ...pendingAfter(state, event.state),
      };
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
