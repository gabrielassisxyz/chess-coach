import type { ActivityState } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat } from "../src/components/Chat.js";
import { useServer } from "../src/hooks/useServer.js";
import { Practice } from "../src/screens/Practice.js";
import { createFakeSocket, FakeSocket } from "./fake-socket.js";
import { legalMovesOf, liveGame, move, START_FEN } from "./fixtures.js";
import { repertoireActivity, repertoireList } from "./practice-fixtures.js";

const board = {
  activity_id: 9,
  orientation: "white" as const,
  fen: START_FEN,
  turn: "white" as const,
  last_move: null,
  legal_moves: legalMovesOf(START_FEN),
  input_enabled: true,
  pending: "none" as const,
};

const transcript = [
  {
    id: 1,
    seq: 1,
    role: "user",
    kind: "text",
    content: { text: "how am I doing" },
    created_at: "t",
  },
  {
    id: 2,
    seq: 2,
    role: "assistant",
    kind: "text",
    content: { text: "Let me look." },
    created_at: "t",
  },
];

const LINE_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// A practice conversation where the coach offered a line: show_position, two moves, then its words.
const offeredLineRows = [
  { id: 1, seq: 1, role: "user", kind: "text", content: { text: "why?" }, created_at: "t" },
  {
    id: 2,
    seq: 2,
    role: "assistant",
    kind: "tool_use",
    content: { toolUseId: "u1", name: "mcp__chess__show_position", input: { fen: LINE_FEN } },
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
    kind: "tool_use",
    content: { toolUseId: "u2", name: "mcp__chess__make_move", input: { san: "e4" } },
    created_at: "t",
  },
  {
    id: 5,
    seq: 5,
    role: "user",
    kind: "tool_result",
    content: {
      toolUseId: "u2",
      output: JSON.stringify({ offered: true, start_fen: LINE_FEN, moves: ["e4"] }),
    },
    created_at: "t",
  },
  {
    id: 6,
    seq: 6,
    role: "assistant",
    kind: "text",
    content: { text: "Abra a linha abaixo." },
    created_at: "t",
  },
];

// A refresh is a brand new socket whose first frame is a bootstrap: the page keeps nothing.
function refreshInto(activity: ActivityState | null) {
  const view = renderHook(() =>
    useServer({ url: "ws://test/api/ws", createSocket: createFakeSocket }),
  );
  act(() => FakeSocket.latest.open());
  act(() =>
    FakeSocket.latest.receive({
      type: "bootstrap",
      conversations: { play: transcript, games: [], practice: [] },
      activity,
    }),
  );
  return view.result.current;
}

beforeEach(() => FakeSocket.reset());
afterEach(cleanup);

describe("browser refresh", () => {
  it("restores a live game with its moves and the chat history", () => {
    const server = refreshInto(
      liveGame({ moves: [move(1), move(2)], phase: "evaluating", input_enabled: false }),
    );
    expect(server.activity).toMatchObject({ kind: "live_game", phase: "evaluating" });
    expect(server.activity?.kind === "live_game" && server.activity.moves).toHaveLength(2);
    expect(server.items.map((item) => item.type)).toEqual(["text", "text"]);
  });

  it("restores a review at the selected ply", () => {
    const server = refreshInto({
      kind: "review",
      ...board,
      input_enabled: false,
      legal_moves: [],
      game: { id: 3, moves: [move(1), move(2)], result: "1-0" },
      selected_ply: 2,
    });
    expect(server.activity).toMatchObject({ kind: "review", selected_ply: 2 });
  });

  it("restores a card in training with its exposure", () => {
    const server = refreshInto({
      kind: "training",
      ...board,
      mode: "srs",
      item: {
        kind: "card",
        card_id: 7,
        exposure_id: "ex-1",
        prompt_fen: START_FEN,
        student_color: "white",
        rating_preview: { "0": 4, "1": 4, "2": 4, "3": 24, "4": 24, "5": 72 },
        position_in_queue: 2,
        queue_length: 3,
      },
      status: "prompt",
      served_at: "2026-03-01T00:00:00.000Z",
      exposure_id: "ex-1",
      expected: null,
      exploring: { fen: START_FEN, line_san: [], trail: [] },
      tries: 0,
      last_try: null,
      gave_up: false,
      solution_line: null,
      suggested_quality: null,
      hint_square: null,
      summary: null,
    });
    expect(server.activity).toMatchObject({ kind: "training", exposure_id: "ex-1" });
  });

  it("restores a puzzle in training at its cursor", () => {
    const server = refreshInto({
      kind: "training",
      ...board,
      mode: "puzzles",
      item: {
        kind: "puzzle",
        puzzle_id: "f1",
        motif: "fork",
        difficulty: "easy",
        fen: START_FEN,
        cursor: 2,
        reply_uci: null,
        position_in_queue: 1,
        queue_length: 10,
      },
      status: "in_progress",
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
    });
    expect(server.activity).toMatchObject({ kind: "training", item: { cursor: 2 } });
  });

  it("restores a repertoire drill mid-pass with its variation, line, hint and wrong tries", async () => {
    const idea = "Prepare d4 and keep the bishop on the a2 g8 diagonal.";
    const server = refreshInto(
      repertoireActivity({
        training: {
          tries: 2,
          last_try: { uci: "d2d3", san: "d3", correct: false },
          wrong_tries: [
            { ply: 6, uci: "d2d3", san: "d3" },
            { ply: 6, uci: "b1c3", san: "Nc3" },
          ],
        },
        drill: { hint: { kind: "idea", text: idea }, moves_left: 5, moves_right: 3 },
      }),
    );
    expect(server.activity).toMatchObject({
      kind: "training",
      mode: "repertoire",
      tries: 2,
      repertoire: { hint: { kind: "idea", text: idea } },
    });

    render(<Practice server={server} fetchRepertoires={async () => repertoireList} />);
    expect(screen.getByTestId("variation-name").textContent).toBe("Italian Game: Giuoco Piano");
    expect(screen.getByRole("list", { name: "Moves" }).textContent).toContain("Bc4");
    expect(screen.getByTestId("fact-tries").querySelector("dd")?.textContent).toBe("2");
    expect(screen.getByTestId("fact-left").querySelector("dd")?.textContent).toBe("5");
    expect(document.querySelector(".state-card")?.textContent).toContain(idea);
    expect(screen.getByRole("button", { name: "Ask for the move" })).toBeTruthy();
  });

  it("restores a finished drill's result and a new move's answer from the bootstrap alone", () => {
    const first = refreshInto(
      repertoireActivity({
        drill: { first_pass: true, answer: { uci: "c2c3", san: "c3" } },
      }),
    );
    expect(first.activity).toMatchObject({
      repertoire: { first_pass: true, answer: { san: "c3" } },
    });
    cleanup();

    const done = refreshInto(
      repertoireActivity({
        training: { status: "solved", input_enabled: false, legal_moves: [] },
        drill: { moves_left: 0, result: { practised: 12, first_try_right: 9 } },
      }),
    );
    expect(done.activity).toMatchObject({ repertoire: { result: { practised: 12 } } });
  });

  it("restores a demo with the activity it returns to", () => {
    const server = refreshInto({
      kind: "demo",
      ...board,
      input_enabled: false,
      legal_moves: [],
      returns_to: "live_game",
      moves_played: ["e2e4"],
    });
    expect(server.activity).toMatchObject({ kind: "demo", returns_to: "live_game" });
  });

  it("restores an empty board when no activity is open", () => {
    const server = refreshInto(null);
    expect(server.activity).toBeNull();
  });

  it("rebuilds the coach's offered line card from the stored tool calls", () => {
    const view = renderHook(() =>
      useServer({ url: "ws://test/api/ws", createSocket: createFakeSocket, tab: "practice" }),
    );
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: offeredLineRows },
        activity: null,
      }),
    );
    render(<Chat server={view.result.current} />);
    expect(screen.getAllByTestId("line-card")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show line on board" }));
    expect(FakeSocket.latest.sent).toContainEqual(
      expect.objectContaining({ type: "show_line", fen: LINE_FEN, moves: ["e4"] }),
    );
  });
});
