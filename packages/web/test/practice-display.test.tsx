import type { TrainingActivity } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardFactory } from "../src/components/Board.js";
import type { ServerApi } from "../src/hooks/useServer.js";
import { AUTO_NEXT_MS, Practice } from "../src/screens/Practice.js";
import { BOARD_PREFS_STORAGE_KEY } from "../src/state/board-prefs.js";
import { initialChatState } from "../src/state/transcript.js";
import { legalMovesOf, START_FEN } from "./fixtures.js";
import { motifCounts, progressOf } from "./practice-fixtures.js";
import { serverApi } from "./server-api.js";

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
  puzzle({
    status: "solved",
    input_enabled: false,
    legal_moves: [],
    last_try: { uci: "e2e4", san: "e4", correct: true },
    moves: [{ ply: 0, uci: "e2e4", san: "e4", by: "student" }],
  });

function api(activity: TrainingActivity): ServerApi {
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
    analysis: null,
    reconnectAttempt: 0,
    activity,
    connection: "connected",
    say: vi.fn(() => true),
    approve: vi.fn(),
    dismissError: vi.fn(),
    send: vi.fn(() => true),
  };
}

interface Seen {
  orientation?: unknown;
  coordinatesOnSquares?: unknown;
  coordinates?: unknown;
  highlight?: { lastMove?: unknown };
}
const seen: Seen[] = [];
const spyBoard: BoardFactory = (_element, config) => {
  seen.push(config as Seen);
  return { set: (next: Seen) => seen.push(next), destroy: vi.fn() } as never;
};
const noMotifs = async () => [];

describe("the Board & display popover", () => {
  it("opens from the bar, closes with Escape and with its own button", () => {
    render(<Practice server={api(puzzle())} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.queryByRole("region", { name: "Board and display" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Board and display settings" }));
    expect(screen.getByRole("region", { name: "Board and display" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Board and display" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Board and display settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "Board and display" })).toBeNull();
  });

  it("moves the coordinates to the edge, draws it at once and keeps the choice", () => {
    seen.length = 0;
    render(<Practice server={api(puzzle())} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(seen[0]).toMatchObject({ coordinates: true, coordinatesOnSquares: true });
    fireEvent.click(screen.getByRole("button", { name: "Board and display settings" }));
    fireEvent.click(screen.getByRole("radio", { name: "Edge" }));
    expect(seen.at(-1)).toMatchObject({ coordinates: true, coordinatesOnSquares: false });
    expect(JSON.parse(window.localStorage.getItem(BOARD_PREFS_STORAGE_KEY) ?? "{}")).toMatchObject({
      coordinates: "edge",
    });
    fireEvent.click(screen.getByRole("switch", { name: "Highlight last move" }));
    expect(seen.at(-1)?.highlight?.lastMove).toBe(false);
  });

  it("lists the four board themes as swatches and picks one", () => {
    render(<Practice server={api(puzzle())} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.click(screen.getByRole("button", { name: "Board and display settings" }));
    const radios = screen.getAllByRole("radio", { name: /Lichess|Chess\.com|Slate|Deep teal/ });
    expect(radios).toHaveLength(4);
    fireEvent.click(screen.getByRole("radio", { name: "Slate" }));
    expect(document.documentElement.dataset.board).toBe("slate");
    delete document.documentElement.dataset.board;
  });
});

describe("keyboard shortcuts on an item", () => {
  it("flips with f, asks for a hint with h and continues with space", () => {
    seen.length = 0;
    const open = api(puzzle());
    const { rerender } = render(
      <Practice server={open} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    fireEvent.keyDown(window, { key: "f" });
    expect(seen.at(-1)?.orientation).toBe("black");
    fireEvent.keyDown(window, { key: "h" });
    expect(open.send).toHaveBeenCalledWith({ type: "hint", activity_id: 4 });
    fireEvent.keyDown(window, { key: " " });
    expect(open.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "next_training_item" }),
    );

    const done = api(solved());
    rerender(<Practice server={done} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.keyDown(window, { key: "h" });
    expect(done.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "hint" }));
    fireEvent.keyDown(window, { key: " " });
    expect(done.send).toHaveBeenCalledWith({ type: "next_training_item", activity_id: 4 });
  });

  it("leaves space to a focused control instead of continuing", () => {
    const done = api(solved());
    render(<Practice server={done} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Analyse" }), { key: " " });
    expect(done.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "next_training_item" }),
    );
    fireEvent.keyDown(window, { key: " " });
    expect(done.send).toHaveBeenCalledWith({ type: "next_training_item", activity_id: 4 });
  });

  it("ignores the keys while typing in the composer", () => {
    const server = api(puzzle());
    render(
      <>
        <textarea aria-label="Message to the coach" />
        <Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText("Message to the coach"), { key: "h" });
    expect(server.send).not.toHaveBeenCalled();
  });
});

describe("jump to the next puzzle automatically", () => {
  it("continues a solved puzzle after the mark settles, and never a card", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      window.localStorage.setItem(BOARD_PREFS_STORAGE_KEY, JSON.stringify({ autoNext: true }));
      const server = api(solved());
      render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
      expect(server.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "next_training_item" }),
      );
      act(() => vi.advanceTimersByTime(AUTO_NEXT_MS));
      expect(server.send).toHaveBeenCalledWith({ type: "next_training_item", activity_id: 4 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits while the student analyses the ended position", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      window.localStorage.setItem(BOARD_PREFS_STORAGE_KEY, JSON.stringify({ autoNext: true }));
      const server = api(solved());
      render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
      fireEvent.click(screen.getByRole("button", { name: "Analyse" }));
      act(() => vi.advanceTimersByTime(AUTO_NEXT_MS * 2));
      expect(server.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "next_training_item" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Back to position" }));
      act(() => vi.advanceTimersByTime(AUTO_NEXT_MS));
      expect(server.send).toHaveBeenCalledWith({ type: "next_training_item", activity_id: 4 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays put with the setting off", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const server = api(solved());
      render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
      act(() => vi.advanceTimersByTime(AUTO_NEXT_MS * 2));
      expect(server.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "next_training_item" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the hub motif list", () => {
  const hubMotifs = async () => motifCounts;
  const hubProgress = async () => progressOf();

  it("shows the fourteen motifs with label and description plus the six remaining, each once", async () => {
    render(
      <Practice
        server={serverApi(null)}
        createBoard={spyBoard}
        fetchMotifs={hubMotifs}
        fetchProgress={hubProgress}
      />,
    );
    const card = await screen.findByRole("region", { name: "Puzzles by motif" });
    for (const label of [
      "Advanced pawn",
      "Attacking f2 or f7",
      "Capture the defender",
      "Discovered attack",
      "Double check",
      "Exposed king",
      "Fork",
      "Hanging piece",
      "Kingside attack",
      "Pin",
      "Queenside attack",
      "Sacrifice",
      "Skewer",
      "Trapped piece",
      "Back rank mate",
      "Checkmate",
      "Endgame",
      "Promotion",
      "Opening",
      "Opening trap",
    ]) {
      expect(
        await within(card).findAllByRole("radio", { name: new RegExp(`^${label},`, "i") }),
      ).toHaveLength(1);
    }
    expect(
      within(card)
        .getByRole("radio", { name: /hanging piece/i })
        .closest("label")?.textContent,
    ).toContain("An undefended piece, free to capture.");
    expect(card.textContent).not.toContain("tactics");
  });

  it("starts a hangingPiece queue from its choice", async () => {
    const server = serverApi(null);
    render(
      <Practice
        server={server}
        createBoard={spyBoard}
        fetchMotifs={hubMotifs}
        fetchProgress={hubProgress}
      />,
    );
    const card = await screen.findByRole("region", { name: "Puzzles by motif" });
    fireEvent.click(within(card).getByRole("radio", { name: /hanging piece/i }));
    fireEvent.click(within(card).getByRole("button", { name: /start hanging piece/i }));
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "puzzles",
      motif: "hangingPiece",
      size: 10,
    });
  });
});
