import type { TrainingActivity } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { practiceIdleLabel } from "../src/state/practice.js";
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
    expect(practiceIdleLabel(puzzle({ status: "solved" }))).toBeUndefined();
    expect(practiceIdleLabel(puzzle({ summary: { solved: 1, failed: 0 } }))).toBeUndefined();
  });

  it("shows it in the panel header on Practice only", () => {
    render(<App />);
    act(() => FakeSocket.latest.open());
    act(() => FakeSocket.latest.receive({ type: "bootstrap", transcript: [], activity: puzzle() }));
    expect(screen.getByText("watching the board")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Practice" }));
    expect(screen.getByText("waiting for your answer")).toBeTruthy();
    expect(screen.queryByText("watching the board")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Games" }));
    expect(screen.getByText("watching the board")).toBeTruthy();
  });
});
