import type { ActivityState } from "@chess-coach/shared";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useServer } from "../src/hooks/useServer.js";
import { createFakeSocket, FakeSocket } from "./fake-socket.js";
import { legalMovesOf, liveGame, move, START_FEN } from "./fixtures.js";

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
});
