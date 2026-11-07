import type { ServerEvent, TrainingActivity } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import {
  PRACTICE_WAITING_LABEL,
  practiceIdleLabel,
  practiceWaitingLabel,
} from "../src/state/practice.js";
import { type ChatState, chatReducer, initialChatState } from "../src/state/transcript.js";
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
      position_in_queue: 1,
      queue_length: 5,
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

describe("the coach panel while an item is open", () => {
  it("words the idle state per item status and per summary", () => {
    expect(practiceIdleLabel(null)).toBeUndefined();
    expect(practiceIdleLabel(puzzle())).toBe("waiting for your answer");
    expect(practiceIdleLabel(puzzle({ status: "in_progress" }))).toBe("waiting for your answer");
    expect(practiceIdleLabel(puzzle({ status: "solved" }))).toBe("puzzle solved");
    expect(practiceIdleLabel(puzzle({ status: "failed" }))).toBe("solution shown");
    expect(practiceIdleLabel(puzzle({ summary: { solved: 1, failed: 0 } }))).toBeUndefined();
  });

  it("shows it in the panel header on Practice only", () => {
    render(<App />);
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: puzzle(),
      }),
    );
    expect(screen.getByText("watching the board")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Practice" }));
    expect(screen.getByText("waiting for your answer")).toBeTruthy();
    expect(screen.queryByText("watching the board")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Games" }));
    expect(screen.getByText("watching the board")).toBeTruthy();
  });
});

function activityOf(training: TrainingActivity): ServerEvent {
  return { type: "activity", state: training };
}

function chatOf(seq: number, event: unknown): ServerEvent {
  return { type: "chat", tab: "practice", message_id: 1, seq, event } as ServerEvent;
}

function reduce(...events: ServerEvent[]): ChatState {
  return events.reduce(
    (state, event) => chatReducer(state, { type: "server", event }),
    initialChatState,
  );
}

describe("the coach reply pending on an ended item", () => {
  it("is set on solved and on a given-up failed item, not on open, rated or summarized ones", () => {
    expect(reduce(activityOf(puzzle())).practiceReplyPending).toBe(false);
    expect(reduce(activityOf(puzzle({ status: "in_progress" }))).practiceReplyPending).toBe(false);
    expect(reduce(activityOf(puzzle({ status: "solved" }))).practiceReplyPending).toBe(true);
    expect(
      reduce(activityOf(puzzle({ status: "failed", gave_up: true }))).practiceReplyPending,
    ).toBe(true);
    expect(reduce(activityOf(puzzle({ status: "rated" }))).practiceReplyPending).toBe(false);
    expect(
      reduce(activityOf(puzzle({ status: "solved", summary: { solved: 1, failed: 0 } })))
        .practiceReplyPending,
    ).toBe(false);
  });

  it("clears when the reply streams, when the turn ends and on a turn error", () => {
    const ended = activityOf(puzzle({ status: "solved" }));
    expect(reduce(ended, chatOf(1, { kind: "text_delta", text: "Boa" })).practiceReplyPending).toBe(
      false,
    );
    expect(
      reduce(ended, chatOf(1, { kind: "turn_end", usage: { input_tokens: 1, output_tokens: 1 } }))
        .practiceReplyPending,
    ).toBe(false);
    expect(
      reduce(ended, chatOf(1, { kind: "turn_error", message: "boom" })).practiceReplyPending,
    ).toBe(false);
  });

  it("is not set again for the same ended item once the reply came", () => {
    const ended = activityOf(puzzle({ status: "solved" }));
    const replied = reduce(ended, chatOf(1, { kind: "text_delta", text: "Boa" }), ended);
    expect(replied.practiceReplyPending).toBe(false);
  });

  it("survives a tool call, which still means the coach is working", () => {
    const ended = activityOf(puzzle({ status: "solved" }));
    expect(
      reduce(ended, chatOf(1, { kind: "tool_use", tool_use_id: "t1", name: "analyze", input: {} }))
        .practiceReplyPending,
    ).toBe(true);
  });

  it("starts over cleared on a reconnect bootstrap", () => {
    const ended = reduce(activityOf(puzzle({ status: "solved" })));
    expect(ended.practiceReplyPending).toBe(true);
    const after = chatReducer(ended, {
      type: "server",
      event: {
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: puzzle({ status: "solved" }),
      },
    });
    expect(after.practiceReplyPending).toBe(false);
  });

  it("words the waiting label only while an ended item owes a reply", () => {
    expect(practiceWaitingLabel(puzzle({ status: "solved" }), true)).toBe(PRACTICE_WAITING_LABEL);
    expect(practiceWaitingLabel(puzzle({ status: "failed", gave_up: true }), true)).toBe(
      PRACTICE_WAITING_LABEL,
    );
    expect(practiceWaitingLabel(puzzle({ status: "solved" }), false)).toBeUndefined();
    expect(practiceWaitingLabel(puzzle(), true)).toBeUndefined();
    expect(practiceWaitingLabel(puzzle({ status: "rated" }), true)).toBeUndefined();
    expect(
      practiceWaitingLabel(puzzle({ status: "solved", summary: { solved: 1, failed: 0 } }), true),
    ).toBeUndefined();
    expect(practiceWaitingLabel(null, true)).toBeUndefined();
  });
});

describe("the waiting phrase in the panel header", () => {
  it("shows it after an item ends, until the reply streams and after the turn ends", () => {
    render(<App />);
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: puzzle(),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Practice" }));
    expect(screen.getByText("waiting for your answer")).toBeTruthy();
    act(() => FakeSocket.latest.receive({ type: "activity", state: puzzle({ status: "solved" }) }));
    expect(screen.getByText(PRACTICE_WAITING_LABEL)).toBeTruthy();
    act(() =>
      FakeSocket.latest.receive({
        type: "chat",
        tab: "practice",
        message_id: 1,
        seq: 1,
        event: { kind: "text_delta", text: "Boa" },
      }),
    );
    expect(screen.getByText("writing")).toBeTruthy();
    act(() =>
      FakeSocket.latest.receive({
        type: "chat",
        tab: "practice",
        message_id: 1,
        seq: 2,
        event: { kind: "turn_end", usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    );
    expect(screen.getByText("puzzle solved")).toBeTruthy();
    expect(screen.queryByText(PRACTICE_WAITING_LABEL)).toBeNull();
  });
});
