import type { ServerEvent, TrainingActivity } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import {
  PRACTICE_WAITING_LABEL,
  practiceIdleLabel,
  practiceWaitingLabel,
} from "../src/state/practice.js";
import { ASK_COACH_LABEL } from "../src/state/practice-item.js";
import { lineCardsByAnchor } from "../src/state/tool-summary.js";
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

describe("a puzzle solved first try", () => {
  const quiet = (comment: "offered" | "requested") =>
    puzzle({ status: "solved", coach_comment: comment });

  function openOnPractice(state: TrainingActivity): void {
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
    act(() => FakeSocket.latest.receive({ type: "activity", state }));
  }

  it("owes no reply until the student asks, and owes one after", () => {
    expect(reduce(activityOf(quiet("offered"))).practiceReplyPending).toBe(false);
    expect(reduce(activityOf(quiet("offered")), activityOf(quiet("requested")))).toMatchObject({
      practiceReplyPending: true,
    });
  });

  it("shows the button and no waiting label, and asks the server for the comment", () => {
    openOnPractice(quiet("offered"));
    expect(screen.queryByText(PRACTICE_WAITING_LABEL)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: ASK_COACH_LABEL }));
    expect(FakeSocket.latest.sent).toContainEqual(
      expect.objectContaining({ type: "ask_coach_about_item", activity_id: 4 }),
    );
    expect(screen.queryByRole("button", { name: ASK_COACH_LABEL })).toBeNull();
    act(() => FakeSocket.latest.receive({ type: "activity", state: quiet("requested") }));
    expect(screen.getByText(PRACTICE_WAITING_LABEL)).toBeTruthy();
    expect(screen.queryByRole("button", { name: ASK_COACH_LABEL })).toBeNull();
  });

  it("offers no button on a solve the coach already answers", () => {
    openOnPractice(puzzle({ status: "solved", coach_comment: null }));
    expect(screen.queryByRole("button", { name: ASK_COACH_LABEL })).toBeNull();
    expect(screen.getByText(PRACTICE_WAITING_LABEL)).toBeTruthy();
  });
});

const LINE_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function offerCalls(): ChatItemLike[] {
  return [
    { type: "text", key: "q", role: "user" },
    {
      type: "tool",
      key: "s1",
      name: "mcp__chess__show_position",
      result: { output: JSON.stringify({ offered: true, start_fen: LINE_FEN, moves: [] }) },
    },
    {
      type: "tool",
      key: "m1",
      name: "mcp__chess__make_move",
      result: {
        output: JSON.stringify({ offered: true, start_fen: LINE_FEN, moves: ["e4", "e5"] }),
      },
    },
    { type: "text", key: "a", role: "assistant" },
  ];
}

type ChatItemLike = {
  type: string;
  key: string;
  role?: string;
  name?: string;
  result?: { output: unknown; isError?: boolean };
};

describe("the coach's line card", () => {
  it("hangs one card per show_position under the last coach message of the turn", () => {
    const anchored = lineCardsByAnchor(offerCalls());
    expect([...anchored.keys()]).toEqual(["a"]);
    expect(anchored.get("a")).toEqual([{ key: "s1", fen: LINE_FEN, moves: ["e4", "e5"] }]);
  });

  it("makes no card for a demo the board showed, a refused call or another turn", () => {
    const shown = { output: JSON.stringify({ kind: "demo", fen: LINE_FEN }) };
    const items = offerCalls().map((item) =>
      item.type === "tool" ? { ...item, result: shown } : item,
    );
    expect(lineCardsByAnchor(items).size).toBe(0);
    const refused = offerCalls().map((item) =>
      item.type === "tool"
        ? { ...item, result: { ...(item.result as object), isError: true } as never }
        : item,
    );
    expect(lineCardsByAnchor(refused).size).toBe(0);
    const twoTurns = [
      ...offerCalls(),
      { type: "text", key: "q2", role: "user" },
      { type: "text", key: "a2", role: "assistant" },
    ];
    expect([...lineCardsByAnchor(twoTurns).keys()]).toEqual(["a"]);
  });

  it("opens the line only when the student clicks the card", () => {
    render(<App />);
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: {
          play: [],
          games: [],
          practice: [
            {
              id: 1,
              seq: 1,
              role: "user",
              kind: "text",
              content: { text: "why?" },
              created_at: "t",
            },
            {
              id: 2,
              seq: 2,
              role: "assistant",
              kind: "tool_use",
              content: {
                toolUseId: "u1",
                name: "mcp__chess__show_position",
                input: { fen: LINE_FEN },
              },
              created_at: "t",
            },
            {
              id: 3,
              seq: 3,
              role: "user",
              kind: "tool_result",
              content: {
                toolUseId: "u1",
                output: JSON.stringify({ offered: true, start_fen: LINE_FEN, moves: [] }),
              },
              created_at: "t",
            },
            {
              id: 4,
              seq: 4,
              role: "assistant",
              kind: "text",
              content: { text: "Abra a linha abaixo." },
              created_at: "t",
            },
          ],
        },
        activity: puzzle({ status: "solved" }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Practice" }));
    expect(FakeSocket.latest.sent.some((m) => (m as { type: string }).type === "show_line")).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show line on board" }));
    expect(FakeSocket.latest.sent).toContainEqual(
      expect.objectContaining({ type: "show_line", fen: LINE_FEN, moves: [] }),
    );
  });
});
