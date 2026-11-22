import {
  REPERTOIRE_IDEA_MAX_LENGTH,
  type ServerEvent,
  type TrainingActivity,
} from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { repertoireActivity } from "./practice-fixtures.js";

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
    suggested_grade: null,
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

  it("is not set by a retry that ended, since the coach is told nothing of it", () => {
    const first = activityOf(puzzle({ status: "failed", gave_up: true }));
    const again = { served_at: "2026-03-01T00:01:00.000Z", retry: true };
    const open = activityOf(puzzle({ ...again }));
    for (const end of [{ status: "solved" }, { status: "failed", gave_up: true }] as const) {
      expect(reduce(activityOf(puzzle({ ...again, ...end }))).practiceReplyPending).toBe(false);
      const replied = reduce(first, chatOf(1, { kind: "text_delta", text: "Boa" }), open);
      expect(replied.practiceReplyPending).toBe(false);
      const after = chatReducer(replied, {
        type: "server",
        event: activityOf(puzzle({ ...again, ...end })),
      });
      expect(after.practiceReplyPending).toBe(false);
      expect(practiceWaitingLabel(after.activity, after.practiceReplyPending)).toBeUndefined();
    }
    // The same ended state without the mark is a first play, which the coach does answer.
    const { retry: _retry, ...firstPlay } = again;
    expect(
      reduce(activityOf(puzzle({ ...firstPlay, status: "solved" }))).practiceReplyPending,
    ).toBe(true);
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

  it("shows no waiting label once a retry ended, and still the offer the first play left", () => {
    openOnPractice({ ...quiet("offered"), retry: true, status: "failed", gave_up: true });
    expect(screen.queryByText(PRACTICE_WAITING_LABEL)).toBeNull();
    expect(screen.getByRole("button", { name: ASK_COACH_LABEL })).toBeTruthy();
    cleanup();
    openOnPractice(puzzle({ status: "solved", coach_comment: null, retry: true }));
    expect(screen.queryByText(PRACTICE_WAITING_LABEL)).toBeNull();
    expect(screen.getByText("puzzle solved")).toBeTruthy();
    expect(screen.queryByRole("button", { name: ASK_COACH_LABEL })).toBeNull();
  });

  it("offers no button on a solve the coach already answers", () => {
    openOnPractice(puzzle({ status: "solved", coach_comment: null }));
    expect(screen.queryByRole("button", { name: ASK_COACH_LABEL })).toBeNull();
    expect(screen.getByText(PRACTICE_WAITING_LABEL)).toBeTruthy();
  });

  it("renders the ask button with its literal label", () => {
    openOnPractice(quiet("offered"));
    expect(screen.getByRole("button", { name: "Pedir comentário do coach" })).toBeTruthy();
  });

  it("renders no ask button after a refresh when the comment was already requested", () => {
    const { container } = render(<App />);
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: quiet("requested"),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Practice" }));
    expect(screen.getByText("puzzle solved")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pedir comentário do coach" })).toBeNull();
    expect(container.querySelector(".coach-actions")).toBeNull();
  });
});

describe("asking the coach for the idea of a line drill move", () => {
  const drillState = (asked: boolean, status: TrainingActivity["status"] = "in_progress") =>
    repertoireActivity({
      training: { status },
      drill: { answered: { position_id: 42, san: "c3", idea: null, asked } },
    });

  it("sets practiceReplyPending once asked becomes true, clears it on text, end or error, and does not re-arm for the same move", () => {
    const before = activityOf(drillState(false));
    const after = activityOf(drillState(true));
    expect(reduce(before).practiceReplyPending).toBe(false);
    expect(reduce(before, after).practiceReplyPending).toBe(true);
    expect(practiceWaitingLabel(drillState(true), true)).toBe(PRACTICE_WAITING_LABEL);
    expect(practiceWaitingLabel(drillState(false), true)).toBeUndefined();

    // Cleared by text_delta, turn_end or turn_error on practice.
    expect(
      reduce(before, after, chatOf(1, { kind: "text_delta", text: "Esse lance..." }))
        .practiceReplyPending,
    ).toBe(false);
    expect(
      reduce(
        before,
        after,
        chatOf(1, { kind: "turn_end", usage: { input_tokens: 1, output_tokens: 1 } }),
      ).practiceReplyPending,
    ).toBe(false);
    expect(
      reduce(before, after, chatOf(1, { kind: "turn_error", message: "boom" }))
        .practiceReplyPending,
    ).toBe(false);

    // A later activity echo for the same asked move does not re-arm the waiting line.
    const replied = reduce(
      before,
      after,
      chatOf(1, { kind: "text_delta", text: "Esse lance..." }),
      after,
    );
    expect(replied.practiceReplyPending).toBe(false);

    // Asking on a later answered move in the same pass arms the waiting line again.
    const nextMoveAsked = activityOf(
      repertoireActivity({
        sans: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6"],
        training: { status: "in_progress" },
        drill: { answered: { position_id: 43, san: "d4", idea: null, asked: true } },
      }),
    );
    expect(
      chatReducer(replied, { type: "server", event: nextMoveAsked }).practiceReplyPending,
    ).toBe(true);
  });

  it("shows the waiting line in the coach panel after pressing Ask for the idea until the practice turn answers", () => {
    render(<App />);
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: drillState(false),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Practice" }));
    expect(screen.queryByText(PRACTICE_WAITING_LABEL)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ask for the idea" }));
    expect(FakeSocket.latest.sent).toContainEqual(
      expect.objectContaining({ type: "ask_coach_about_item", activity_id: 6 }),
    );
    act(() => FakeSocket.latest.receive({ type: "activity", state: drillState(true) }));
    expect(screen.getByText(PRACTICE_WAITING_LABEL)).toBeTruthy();

    act(() =>
      FakeSocket.latest.receive({
        type: "chat",
        tab: "practice",
        message_id: 1,
        seq: 1,
        event: { kind: "text_delta", text: "Prepara d4." },
      }),
    );
    expect(screen.queryByText(PRACTICE_WAITING_LABEL)).toBeNull();
    expect(screen.getByText("writing")).toBeTruthy();
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

function turnStartRow(id: number, tab: "practice" | "play" = "practice"): ServerEvent {
  return {
    type: "chat_row",
    tab,
    entry: {
      id,
      seq: id,
      role: "system",
      kind: "text",
      content: { turn_start: `2026-03-01T00:00:0${id}.000Z` },
      created_at: `2026-03-01T00:00:0${id}.000Z`,
    },
  };
}

function turnEndEvent(seq: number, messageId = 1): ServerEvent {
  return {
    type: "chat",
    tab: "practice",
    message_id: messageId,
    seq,
    event: { kind: "turn_end", usage: { input_tokens: 1, output_tokens: 1 } },
  };
}

function textDeltaEvent(seq: number, text: string, messageId = 1): ServerEvent {
  return {
    type: "chat",
    tab: "practice",
    message_id: messageId,
    seq,
    event: { kind: "text_delta", text },
  };
}

const LONDON_BD3_LINE = ["d4", "d5", "Bf4", "Nf6", "e3", "e6", "Nf3", "c5"];

function bd3Drill(options: {
  positionId?: number;
  idea?: string | null;
  asked?: boolean;
}): TrainingActivity {
  return repertoireActivity({
    sans: LONDON_BD3_LINE,
    training: { status: "in_progress" },
    drill: {
      answered: {
        position_id: options.positionId ?? 77,
        san: "Bd3",
        idea: options.idea ?? null,
        asked: options.asked ?? false,
      },
    },
  });
}

describe("saving the coach's answer as a repertoire move note (reducer)", () => {
  it("anchors to the last assistant text of the first turn that starts after the request, once it ends", () => {
    const before = activityOf(bd3Drill({ positionId: 77, idea: null, asked: false }));
    const asked = activityOf(bd3Drill({ positionId: 77, idea: null, asked: true }));

    // A turn already running when the request arrives must NOT receive the card.
    const duringOldTurn = reduce(
      before,
      turnStartRow(1),
      textDeltaEvent(1, "Earlier reply.", 1),
      asked,
      textDeltaEvent(2, " More of earlier reply.", 1),
      turnEndEvent(3, 1),
    );
    expect(duringOldTurn.noteOffers).toEqual([]);

    // The first turn that starts after the request streams two text blocks around a tool call.
    const streaming = [
      turnStartRow(2),
      textDeltaEvent(4, "Let me check.", 2),
      chatOf(5, { kind: "tool_use", tool_use_id: "t1", name: "analyze", input: {} }),
      chatOf(6, { kind: "tool_result", tool_use_id: "t1", output: "{}" }),
      textDeltaEvent(7, "Develops the bishop ", 3),
      textDeltaEvent(8, "towards the kingside.", 3),
    ].reduce((state, event) => chatReducer(state, { type: "server", event }), duringOldTurn);

    // No card until the turn has ended.
    expect(streaming.noteOffers).toEqual([]);

    const ended = chatReducer(streaming, { type: "server", event: turnEndEvent(9, 3) });
    expect(ended.noteOffers).toEqual([
      {
        anchorKey: "live-7",
        positionId: 77,
        moveLabel: "5.Bd3",
        hadNote: false,
        replyText: "Develops the bishop towards the kingside.",
        saved: false,
      },
    ]);
  });

  it("handles turn_start arriving before activity asked=true when local_ask_idea armed the request", () => {
    let state = reduce(activityOf(bd3Drill({ positionId: 88, idea: "Old note.", asked: false })));
    state = chatReducer(state, { type: "local_ask_idea", commandId: "c1" });
    // Server emits turn_start before the updated activity frame.
    state = chatReducer(state, { type: "server", event: turnStartRow(1) });
    state = chatReducer(state, {
      type: "server",
      event: activityOf(bd3Drill({ positionId: 88, idea: "Old note.", asked: true })),
    });
    state = chatReducer(state, {
      type: "server",
      event: textDeltaEvent(1, "Controls e4 and eyes h7.", 1),
    });
    state = chatReducer(state, { type: "server", event: turnEndEvent(2, 1) });

    expect(state.noteOffers).toEqual([
      {
        anchorKey: "live-1",
        positionId: 88,
        moveLabel: "5.Bd3",
        hadNote: true,
        replyText: "Controls e4 and eyes h7.",
        saved: false,
      },
    ]);
    // No duplicate pending request left behind.
    expect(state.pendingNoteRequests).toEqual([]);
  });

  it("gives no card when the turn fails, even after partial text", () => {
    const failed = reduce(
      activityOf(bd3Drill({ positionId: 77, asked: false })),
      activityOf(bd3Drill({ positionId: 77, asked: true })),
      turnStartRow(1),
      textDeltaEvent(1, "Partial text...", 1),
      chatOf(2, { kind: "turn_error", message: "sdk crashed" }),
    );
    expect(failed.noteOffers).toEqual([]);
    expect(failed.activeNoteTurn).toBeNull();
  });

  it("removes the card on a new practice conversation or bootstrap, but not on another tab's new conversation", () => {
    const withOffer = reduce(
      activityOf(bd3Drill({ positionId: 77, asked: false })),
      activityOf(bd3Drill({ positionId: 77, asked: true })),
      turnStartRow(1),
      textDeltaEvent(1, "Aims at h7.", 1),
      turnEndEvent(2, 1),
    );
    expect(withOffer.noteOffers).toHaveLength(1);

    const playReset = chatReducer(withOffer, {
      type: "server",
      event: { type: "conversation_started", tab: "play" },
    });
    expect(playReset.noteOffers).toHaveLength(1);

    const practiceReset = chatReducer(withOffer, {
      type: "server",
      event: { type: "conversation_started", tab: "practice" },
    });
    expect(practiceReset.noteOffers).toEqual([]);

    const reloaded = chatReducer(withOffer, {
      type: "server",
      event: {
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: bd3Drill({ positionId: 77, asked: true }),
      },
    });
    expect(reloaded.noteOffers).toEqual([]);
  });
});

describe("saving the coach's answer as a repertoire move note (UI)", () => {
  function setupDrillChat(options: { positionId?: number; idea?: string | null } = {}) {
    render(<App />);
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: bd3Drill({ positionId: options.positionId ?? 77, idea: options.idea ?? null }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Practice" }));
  }

  function askAndReceiveReply(
    replyText: string,
    options: { positionId?: number; idea?: string | null } = {},
  ) {
    fireEvent.click(screen.getByRole("button", { name: "Ask for the idea" }));
    act(() => {
      FakeSocket.latest.receive(turnStartRow(1));
      FakeSocket.latest.receive(
        activityOf(
          bd3Drill({
            positionId: options.positionId ?? 77,
            idea: options.idea ?? null,
            asked: true,
          }),
        ),
      );
      FakeSocket.latest.receive(textDeltaEvent(1, replyText, 1));
    });
    // Still streaming: card must not appear yet.
    expect(screen.queryByTestId("note-save-card")).toBeNull();
    act(() => {
      FakeSocket.latest.receive(turnEndEvent(2, 1));
    });
  }

  it("shows 'Salvar como nota de 5.Bd3', opens the editor with count and validation, sends the original position_id even after moving on, and shows 'Nota salva'", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/health")) {
        return Response.json({ status: "ok", version: "0.0.0", ready: true });
      }
      if (url === "/api/repertoires/positions/77/idea" && init?.method === "PUT") {
        const parsed = JSON.parse(String(init.body)) as { idea: string };
        return Response.json({ rows_updated: 1, idea: parsed.idea.trim() });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    setupDrillChat({ positionId: 77, idea: null });
    askAndReceiveReply("Controls e4 and eyes h7.");

    const card = screen.getByTestId("note-save-card");
    const openBtn = within(card).getByRole("button", { name: "Salvar como nota de 5.Bd3" });
    fireEvent.click(openBtn);

    const textarea = within(card).getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Controls e4 and eyes h7.");
    expect(within(card).getByTestId("note-save-count").textContent).toBe(
      `${"Controls e4 and eyes h7.".length}/${REPERTOIRE_IDEA_MAX_LENGTH}`,
    );

    const saveBtn = () => within(card).getByRole("button", { name: "Salvar" }) as HTMLButtonElement;
    const cancelBtn = () => within(card).getByRole("button", { name: "Cancelar" });
    expect(saveBtn().disabled).toBe(false);

    // Empty / whitespace disables Salvar.
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(within(card).getByTestId("note-save-count").textContent).toBe(
      `0/${REPERTOIRE_IDEA_MAX_LENGTH}`,
    );
    expect(saveBtn().disabled).toBe(true);

    // Over 500 characters disables Salvar.
    fireEvent.change(textarea, { target: { value: "a".repeat(REPERTOIRE_IDEA_MAX_LENGTH + 1) } });
    expect(within(card).getByTestId("note-save-count").textContent).toBe(
      `${REPERTOIRE_IDEA_MAX_LENGTH + 1}/${REPERTOIRE_IDEA_MAX_LENGTH}`,
    );
    expect(saveBtn().disabled).toBe(true);

    // Cancelar closes back to the button; opening again restores the reply text.
    fireEvent.click(cancelBtn());
    expect(within(card).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Salvar como nota de 5.Bd3" }));
    expect((within(card).getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Controls e4 and eyes h7.",
    );

    // Move on to a different answered move before clicking Salvar: the request still sends position_id 77.
    act(() => {
      FakeSocket.latest.receive(
        activityOf(
          repertoireActivity({
            sans: [...LONDON_BD3_LINE, "Bd3", "Nc6"],
            training: { status: "in_progress" },
            drill: {
              answered: { position_id: 99, san: "c3", idea: null, asked: false },
            },
          }),
        ),
      );
    });

    fireEvent.change(within(card).getByRole("textbox"), {
      target: { value: "My own note for Bd3." },
    });
    fireEvent.click(saveBtn());

    await waitFor(() => {
      expect(within(card).getByText("Nota salva")).toBeTruthy();
    });
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/repertoires/positions/77/idea",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ idea: "My own note for Bd3." }),
      }),
    );
  });

  it("reads 'Substituir a nota de 5.Bd3' when the move already had a note at the request", () => {
    setupDrillChat({ positionId: 77, idea: "Existing note." });
    askAndReceiveReply("Better explanation.", { positionId: 77, idea: "Existing note." });

    const card = screen.getByTestId("note-save-card");
    expect(within(card).getByRole("button", { name: "Substituir a nota de 5.Bd3" })).toBeTruthy();
  });

  it("shows 'A nota não foi salva.' and keeps the edited text on HTTP refusal and on lost connection, then succeeds on retry", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/health")) {
        return Response.json({ status: "ok", version: "0.0.0", ready: true });
      }
      if (url === "/api/repertoires/positions/77/idea" && init?.method === "PUT") {
        attempt += 1;
        if (attempt === 1) {
          return Response.json({ error: "invalid_request", message: "bad" }, { status: 400 });
        }
        if (attempt === 2) {
          throw new TypeError("Failed to fetch");
        }
        return Response.json({ rows_updated: 1, idea: "Edited retry note." });
      }
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    setupDrillChat({ positionId: 77, idea: null });
    askAndReceiveReply("Initial answer.");

    const card = screen.getByTestId("note-save-card");
    fireEvent.click(within(card).getByRole("button", { name: "Salvar como nota de 5.Bd3" }));
    fireEvent.change(within(card).getByRole("textbox"), {
      target: { value: "Edited retry note." },
    });

    // Attempt 1: HTTP refusal.
    fireEvent.click(within(card).getByRole("button", { name: "Salvar" }));
    await waitFor(() => {
      expect(within(card).getByRole("alert").textContent).toBe("A nota não foi salva.");
    });
    expect((within(card).getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Edited retry note.",
    );

    // Attempt 2: lost connection (fetch rejects).
    fireEvent.click(within(card).getByRole("button", { name: "Salvar" }));
    await waitFor(() => {
      expect(attempt).toBe(2);
      expect(within(card).getByRole("alert").textContent).toBe("A nota não foi salva.");
    });
    expect((within(card).getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Edited retry note.",
    );

    // Attempt 3: succeeds.
    fireEvent.click(within(card).getByRole("button", { name: "Salvar" }));
    await waitFor(() => {
      expect(within(card).getByText("Nota salva")).toBeTruthy();
    });
    expect(within(card).queryByRole("alert")).toBeNull();
  });

  it("removes the card on a new conversation and on a reconnect bootstrap", () => {
    setupDrillChat({ positionId: 77, idea: null });
    askAndReceiveReply("Aims at h7.");
    expect(screen.getByTestId("note-save-card")).toBeTruthy();

    act(() => {
      FakeSocket.latest.receive({ type: "conversation_started", tab: "practice" });
    });
    expect(screen.queryByTestId("note-save-card")).toBeNull();
  });
});
