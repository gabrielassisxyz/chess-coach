import type { TrainingActivity } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { Chat, COACH_MODEL_LABEL } from "../src/components/Chat.js";
import { PracticeCoachActions } from "../src/components/PracticeCoachActions.js";
import type { ServerApi } from "../src/hooks/useServer.js";
import { contextLineOf, whyChipOf } from "../src/state/practice-item.js";
import { initialChatState } from "../src/state/transcript.js";
import { FakeSocket } from "./fake-socket.js";
import { legalMovesOf, START_FEN } from "./fixtures.js";

beforeEach(() => {
  FakeSocket.reset();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ status: "ok", version: "0.0.0", ready: true })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function puzzle(overrides: Partial<TrainingActivity> = {}): TrainingActivity {
  return {
    kind: "training",
    activity_id: 4,
    orientation: "white",
    fen: START_FEN,
    turn: "white",
    last_move: null,
    legal_moves: legalMovesOf(START_FEN),
    input_enabled: true,
    pending: "none",
    mode: "puzzles",
    item: {
      kind: "puzzle",
      puzzle_id: "f1",
      motif: "fork",
      difficulty: "easy",
      fen: START_FEN,
      cursor: 0,
      reply_uci: null,
      position_in_queue: 3,
      queue_length: 10,
    },
    status: "prompt",
    served_at: "2026-03-01T00:00:00.000Z",
    expected: null,
    exploring: { fen: START_FEN, line_san: [], trail: [] },
    tries: 0,
    last_try: null,
    gave_up: false,
    solution_line: null,
    suggested_quality: null,
    hint_square: null,
    summary: null,
    ...overrides,
  };
}

function api(overrides: Partial<ServerApi> = {}): ServerApi {
  return {
    items: [],
    permissions: [],
    lastError: null,
    errorCount: 0,
    lastErrorCode: null,
    turn: "idle",
    localCount: 0,
    activity: null,
    cardsCreated: {},
    coachMessages: 0,
    lastMessageAt: null,
    tab: "practice",
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

describe("the context line over the conversation", () => {
  it("names the item and the side, and the motif only when the heading shows it", () => {
    expect(contextLineOf(puzzle(), null)).toBe("Puzzle 3 · you play White");
    expect(contextLineOf(puzzle(), "fork")).toBe("Puzzle 3 · Fork · you play White");
    expect(contextLineOf(puzzle({ status: "solved" }), null)).toBe(
      "Puzzle 3 · Fork · you play White",
    );
  });

  it("is pinned over the Practice conversation while an item is on the board", () => {
    render(<App />);
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: puzzle(),
      }),
    );
    expect(screen.queryByTestId("chat-context")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Practice" }));
    expect(screen.getByTestId("chat-context").textContent).toBe("Puzzle 3 · you play White");
  });
});

describe("the composer", () => {
  it("offers the voice placeholder until there is text, then the send button", () => {
    const server = api();
    render(<Chat server={server} />);
    expect(screen.getByRole("button", { name: "Voice conversation" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Message to the coach"), {
      target: { value: "the queen is loose" },
    });
    expect(screen.queryByRole("button", { name: "Voice conversation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(server.say).toHaveBeenCalledWith("the queen is loose");
  });

  it("shows the dictate and voice controls as inert, and the coach model read-only", () => {
    render(<Chat server={api()} />);
    expect((screen.getByRole("button", { name: "Dictate" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Voice conversation" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTitle("Coach model").textContent).toBe(COACH_MODEL_LABEL);
    expect(screen.getByText("Enter to send")).toBeTruthy();
  });
});

describe("the question chip after a wrong try", () => {
  const ended = puzzle({
    status: "solved",
    tries: 1,
    wrong_tries: [{ ply: 0, uci: "e2e3", san: "e3" }],
  });

  it("asks about the first wrong move, once", () => {
    expect(whyChipOf(puzzle())).toBeNull();
    expect(whyChipOf(puzzle({ status: "solved" }))).toBeNull();
    expect(whyChipOf(ended)?.text).toBe("Por que e3 foi ruim?");
    const server = api({ activity: ended });
    render(<PracticeCoachActions server={server} />);
    fireEvent.click(screen.getByRole("button", { name: "Por que e3 foi ruim?" }));
    expect(server.say).toHaveBeenCalledWith("Por que e3 foi ruim?");
    expect(screen.queryByRole("button", { name: "Por que e3 foi ruim?" })).toBeNull();
  });
});
