import type { ActivityState } from "@chess-coach/shared";
import { vi } from "vitest";
import type { ServerApi } from "../src/hooks/useServer.js";
import { initialChatState } from "../src/state/transcript.js";

export function serverApi(
  activity: ActivityState | null = null,
  overrides: Partial<ServerApi> = {},
): ServerApi {
  return {
    items: [],
    permissions: [],
    turn: "idle",
    lastError: null,
    lastErrorCode: null,
    errorCount: 0,
    localCount: 0,
    activity,
    cardsCreated: {},
    coachMessages: 0,
    lastMessageAt: null,
    tab: "play",
    conversations: initialChatState.conversations,
    newConversation: vi.fn(() => true),
    practiceReplyPending: false,
    practiceEndedItem: null,
    analysis: null,
    reconnectAttempt: 0,
    connection: "connected",
    say: vi.fn(() => true),
    approve: vi.fn(),
    dismissError: vi.fn(),
    send: vi.fn(() => true),
    ...overrides,
  };
}
