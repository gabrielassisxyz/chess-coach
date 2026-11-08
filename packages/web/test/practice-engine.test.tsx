import type { AnalysisEvent, TrainingActivity } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardFactory } from "../src/components/Board.js";
import { ANALYSE_DEBOUNCE_MS } from "../src/hooks/useEngineAnalysis.js";
import type { ServerApi } from "../src/hooks/useServer.js";
import { Practice } from "../src/screens/Practice.js";
import { ENGINE_PREFS_STORAGE_KEY, readEnginePrefs } from "../src/state/engine-prefs.js";
import { initialChatState } from "../src/state/transcript.js";
import { legalMovesOf, START_FEN } from "./fixtures.js";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
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
      position_in_queue: 2,
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

const solved = (): TrainingActivity =>
  puzzle({ status: "solved", input_enabled: false, legal_moves: [] });

function api(activity: TrainingActivity, analysis: AnalysisEvent | null = null): ServerApi {
  return {
    items: [],
    permissions: [],
    lastError: null,
    errorCount: 0,
    lastErrorCode: null,
    turn: "idle",
    localCount: 0,
    cardsCreated: {},
    coachMessages: 0,
    lastMessageAt: null,
    tab: "practice",
    conversations: initialChatState.conversations,
    newConversation: vi.fn(() => true),
    practiceReplyPending: false,
    practiceEndedItem: null,
    analysis,
    reconnectAttempt: 0,
    activity,
    connection: "connected",
    say: vi.fn(() => true),
    approve: vi.fn(),
    dismissError: vi.fn(),
    send: vi.fn(() => true),
  };
}

const seen: { drawable?: { autoShapes?: unknown[] } }[] = [];
const spyBoard: BoardFactory = (_element, config) => {
  seen.push(config as (typeof seen)[number]);
  return { set: (next: (typeof seen)[number]) => seen.push(next), destroy: vi.fn() } as never;
};
const noMotifs = async () => [];

describe("the engine strip", () => {
  it("keeps the switch off and disabled while the item is open", () => {
    render(<Practice server={api(puzzle())} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    const toggle = screen.getByRole("switch", { name: "Engine" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Stockfish · off")).toBeTruthy();
  });

  it("asks the server about the shown position once switched on after the item ended", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const server = api(solved());
      render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
      const toggle = screen.getByRole("switch", { name: "Engine" }) as HTMLButtonElement;
      expect(toggle.disabled).toBe(false);
      fireEvent.click(toggle);
      expect(screen.getByText("Stockfish · thinking")).toBeTruthy();
      expect(server.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "analyse" }));
      act(() => vi.advanceTimersByTime(ANALYSE_DEBOUNCE_MS));
      expect(server.send).toHaveBeenCalledWith({
        type: "analyse",
        activity_id: 4,
        fen: START_FEN,
        lines: 1,
        depth: 18,
      });
      expect(readEnginePrefs().on).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the first line's score from the student's side and draws its arrow", () => {
    window.localStorage.setItem(ENGINE_PREFS_STORAGE_KEY, JSON.stringify({ on: true }));
    seen.length = 0;
    const analysis: AnalysisEvent = {
      type: "analysis",
      fen: START_FEN,
      depth: 18,
      requested_lines: 1,
      lines: [{ moves: ["e2e4", "e7e5"], san: ["e4", "e5"], score_cp: 35 }],
    };
    const { rerender } = render(
      <Practice server={api(solved(), analysis)} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    expect(screen.getByTestId("engine-eval").textContent).toBe("+0.3");
    expect(screen.getByTestId("engine-eval").getAttribute("data-tone")).toBe("better");
    expect(screen.getByText("Stockfish · depth 18")).toBeTruthy();
    expect(seen.at(-1)?.drawable?.autoShapes).toEqual([{ orig: "e2", dest: "e4", brush: "green" }]);

    const black = { ...solved(), orientation: "black" as const };
    rerender(
      <Practice server={api(black, analysis)} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    expect(screen.getByTestId("engine-eval").textContent).toBe("−0.3");
    expect(screen.getByTestId("engine-eval").getAttribute("data-tone")).toBe("worse");
  });

  it("ignores an answer for another position and reads a mate as M", () => {
    window.localStorage.setItem(ENGINE_PREFS_STORAGE_KEY, JSON.stringify({ on: true }));
    const other: AnalysisEvent = {
      type: "analysis",
      fen: "8/8/8/8/8/8/8/K6k w - - 0 1",
      depth: 18,
      requested_lines: 1,
      lines: [{ moves: ["a1a2"], san: ["Ka2"], score_cp: 0 }],
    };
    const { rerender } = render(
      <Practice server={api(solved(), other)} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    expect(screen.queryByTestId("engine-eval")).toBeNull();
    const mate: AnalysisEvent = {
      ...other,
      fen: START_FEN,
      lines: [{ moves: ["e2e4"], san: ["e4"], score_cp: 10000 }],
    };
    rerender(
      <Practice server={api(solved(), mate)} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    expect(screen.getByTestId("engine-eval").textContent).toBe("M");
  });

  it("opens the engine settings and keeps the lines and depth", () => {
    render(<Practice server={api(solved())} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.click(screen.getByRole("button", { name: "Engine settings" }));
    expect(screen.getByRole("region", { name: "Engine" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Lines"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Depth"), { target: { value: "12" } });
    expect(readEnginePrefs()).toMatchObject({ lines: 3, depth: 12 });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Engine" })).toBeNull();
  });
});
