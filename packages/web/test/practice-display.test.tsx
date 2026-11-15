import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrainingActivity } from "@chess-coach/shared";
import type { Config } from "@lichess-org/chessground/config";
import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Chess, type Square } from "chess.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BoardFactory, MOVE_PAUSE_MS } from "../src/components/Board.js";
import { BoardSettingsToggle } from "../src/components/BoardSettings.js";
import { Chat } from "../src/components/Chat.js";
import type { ServerApi } from "../src/hooks/useServer.js";
import { AUTO_NEXT_MS, Practice } from "../src/screens/Practice.js";
import { BOARD_PREFS_STORAGE_KEY } from "../src/state/board-prefs.js";
import { initialChatState } from "../src/state/transcript.js";
import { legalMovesOf, START_FEN } from "./fixtures.js";
import { ITALIAN_APPROACH, repertoireActivity, repertoireList } from "./practice-fixtures.js";

interface HappyWindow {
  happyDOM: { setViewport(size: { width: number; height: number }): void };
}

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
  fen?: string;
  lastMove?: unknown;
  movable?: { color?: unknown };
}
const seen: Seen[] = [];
// Where the board reads chessground back, the spy answers as chessground would: the pieces of the
// last fen it was handed or of a drop since, and the hand drawings, which a new fen clears.
const drawn = {
  fen: START_FEN,
  shapes: [] as DrawShape[],
  move: undefined as ((from: Key, to: Key) => void) | undefined,
};
const spyBoard: BoardFactory = (_element, config) => {
  const take = (next: Config): void => {
    seen.push(next as Seen);
    if (!next.fen) return;
    drawn.fen = next.fen;
    drawn.shapes = [];
  };
  drawn.move = config.events?.move as typeof drawn.move;
  take(config);
  return {
    set: take,
    getFen: () => drawn.fen.split(" ")[0],
    setShapes: (shapes: DrawShape[]) => {
      drawn.shapes = shapes;
    },
    state: {
      drawable: {
        get shapes() {
          return drawn.shapes;
        },
      },
    },
    destroy: vi.fn(),
  } as never;
};

// A drop as chessground makes it: the piece lands on the square, then the board hears of the move.
function drop(from: Square, to: Square): void {
  const board = new Chess(drawn.fen);
  const piece = board.remove(from);
  if (piece) board.put(piece, to);
  drawn.fen = board.fen();
  act(() => drawn.move?.(from, to));
}

function expectNamedIconButtons(container: HTMLElement, labels: string[]): void {
  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button.icon-button")].filter(
    (button) => button.textContent?.trim() === "",
  );
  expect(buttons.map((button) => button.getAttribute("aria-label")).sort()).toEqual(
    [...labels].sort(),
  );
  for (const button of buttons) {
    expect(button.getAttribute("title"), button.getAttribute("aria-label") ?? "unnamed").toBe(
      button.getAttribute("aria-label"),
    );
  }
}

describe("icon controls on a practice item", () => {
  it("names every icon button in the board bar, chat composer, engine strip and settings panels", () => {
    const server = api(puzzle());
    const { container } = render(
      <>
        <Practice server={server} createBoard={spyBoard} />
        <Chat server={server} />
        <BoardSettingsToggle open={false} onToggle={vi.fn()} />
      </>,
    );
    const labels = [
      "First move",
      "Previous move",
      "Next move",
      "Last move",
      "Flip board",
      "Board and display settings",
      "Engine settings",
      "Board settings",
      "Collapse coach panel",
      "Dictate",
      "Voice conversation",
    ];
    expectNamedIconButtons(container, labels);

    fireEvent.click(screen.getByRole("button", { name: "Board and display settings" }));
    expectNamedIconButtons(container, [...labels, "Close"]);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Engine settings" }));
    expectNamedIconButtons(container, [...labels, "Close"]);
  });

  it("shows Explore as text and keeps its pressed state without an aria-label", () => {
    render(<Practice server={api(puzzle())} createBoard={spyBoard} />);
    const explore = screen.getByRole("button", { name: "Explore" });
    expect(explore.textContent?.trim()).toBe("Explore");
    expect(explore.hasAttribute("aria-label")).toBe(false);
    expect(explore.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(explore);
    expect(explore.getAttribute("aria-pressed")).toBe("true");
  });

  it("draws 20 pixel icons in 32 pixel square buttons", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(join(import.meta.dirname, "../src/styles/chat.css"), "utf8");
    document.head.append(style);
    try {
      const { container } = render(
        <>
          <Practice server={api(puzzle())} createBoard={spyBoard} />
          <BoardSettingsToggle open={false} onToggle={vi.fn()} />
        </>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Board and display settings" }));
      fireEvent.click(screen.getByRole("button", { name: "Engine settings" }));
      const icons = container.querySelectorAll("button.icon-button > svg:first-of-type");
      expect(icons.length).toBeGreaterThan(0);
      for (const icon of icons) {
        expect(icon.getAttribute("width")).toBe("20");
        expect(icon.getAttribute("height")).toBe("20");
      }
      const step = screen.getByRole("button", { name: "First move" });
      expect(getComputedStyle(step).width).toBe("32px");
      expect(getComputedStyle(step).height).toBe("32px");
    } finally {
      style.remove();
    }
  });

  it("keeps icon button targets at least 44 pixels wide on a phone", () => {
    const style = document.createElement("style");
    style.textContent = ["chat.css", "practice.css"]
      .map((file) => readFileSync(join(import.meta.dirname, "../src/styles", file), "utf8"))
      .join("\n");
    document.head.append(style);
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    (window as unknown as HappyWindow).happyDOM.setViewport({ width: 390, height: 844 });
    try {
      const server = api(puzzle());
      render(
        <>
          <Practice server={server} createBoard={spyBoard} />
          <Chat server={server} />
        </>,
      );
      for (const name of ["First move", "Engine settings", "Voice conversation"]) {
        const button = screen.getByRole("button", { name });
        expect(getComputedStyle(button).width, name).toBe("44px");
        expect(getComputedStyle(button).minHeight, name).toBe("44px");
      }
      expect(getComputedStyle(screen.getByRole("button", { name: "Dictate" })).width).toBe("auto");
    } finally {
      (window as unknown as HappyWindow).happyDOM.setViewport({
        width: originalWidth,
        height: originalHeight,
      });
      style.remove();
    }
  });
});

describe("the Board & display popover", () => {
  it("opens from the bar, closes with Escape and with its own button", () => {
    render(<Practice server={api(puzzle())} createBoard={spyBoard} />);
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
    render(<Practice server={api(puzzle())} createBoard={spyBoard} />);
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
    render(<Practice server={api(puzzle())} createBoard={spyBoard} />);
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
    const { rerender } = render(<Practice server={open} createBoard={spyBoard} />);
    fireEvent.keyDown(window, { key: "f" });
    expect(seen.at(-1)?.orientation).toBe("black");
    fireEvent.keyDown(window, { key: "h" });
    expect(open.send).toHaveBeenCalledWith({ type: "hint", activity_id: 4 });
    fireEvent.keyDown(window, { key: " " });
    expect(open.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "next_training_item" }),
    );

    const done = api(solved());
    rerender(<Practice server={done} createBoard={spyBoard} />);
    fireEvent.keyDown(window, { key: "h" });
    expect(done.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "hint" }));
    fireEvent.keyDown(window, { key: " " });
    expect(done.send).toHaveBeenCalledWith({ type: "next_training_item", activity_id: 4 });
  });

  it("leaves space to a focused control instead of continuing", () => {
    const done = api(solved());
    render(<Practice server={done} createBoard={spyBoard} />);
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
        <Practice server={server} createBoard={spyBoard} />
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
      render(<Practice server={server} createBoard={spyBoard} />);
      expect(server.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "next_training_item" }),
      );
      act(() => vi.advanceTimersByTime(AUTO_NEXT_MS));
      expect(server.send).toHaveBeenCalledWith({ type: "next_training_item", activity_id: 4 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps jumping past the tenth puzzle of a queue without a length", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      window.localStorage.setItem(BOARD_PREFS_STORAGE_KEY, JSON.stringify({ autoNext: true }));
      const answered = solved();
      answered.item = {
        kind: "puzzle",
        puzzle_id: "f11",
        motif: "fork",
        difficulty: "easy",
        fen: START_FEN,
        cursor: 0,
        reply_uci: null,
        position_in_queue: 11,
      };
      const server = api(answered);
      render(<Practice server={server} createBoard={spyBoard} />);
      expect(screen.getByRole("heading", { name: "Puzzle 11" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Finish training" })).toBeNull();
      act(() => vi.advanceTimersByTime(AUTO_NEXT_MS));
      expect(server.send).toHaveBeenCalledWith({ type: "next_training_item", activity_id: 4 });
      expect(server.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "end_training" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits while the student analyses the ended position", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      window.localStorage.setItem(BOARD_PREFS_STORAGE_KEY, JSON.stringify({ autoNext: true }));
      const server = api(solved());
      render(<Practice server={server} createBoard={spyBoard} />);
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
      render(<Practice server={server} createBoard={spyBoard} />);
      act(() => vi.advanceTimersByTime(AUTO_NEXT_MS * 2));
      expect(server.send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "next_training_item" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const AFTER_D4 = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
const AFTER_NC6 = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";

// What the server publishes once e4 was right and the puzzle answered e5.
const answeredWithE5 = (): TrainingActivity =>
  puzzle({
    status: "in_progress",
    fen: AFTER_E5,
    last_move: { from: "e7", to: "e5" },
    legal_moves: legalMovesOf(AFTER_E5),
    exploring: { fen: AFTER_E5, line_san: [], trail: [] },
    last_try: { uci: "e2e4", san: "e4", correct: true },
    moves: [
      { ply: 0, uci: "e2e4", san: "e4", by: "student" },
      { ply: 1, uci: "e7e5", san: "e5", by: "reply" },
    ],
  });

// What the server publishes once d4 was wrong: the position stays and the try is counted.
const missedWithD4 = (): TrainingActivity =>
  puzzle({
    tries: 1,
    last_try: { uci: "d2d4", san: "d4", correct: false },
    wrong_tries: [{ ply: 0, uci: "d2d4", san: "d4" }],
  });

const listedRepertoires = async () => repertoireList;

function renderItem(activity: TrainingActivity) {
  const server = api(activity);
  const view = render(
    <Practice server={server} createBoard={spyBoard} fetchRepertoires={listedRepertoires} />,
  );
  const publish = (next: TrainingActivity): ServerApi => {
    const updated = api(next);
    view.rerender(
      <Practice server={updated} createBoard={spyBoard} fetchRepertoires={listedRepertoires} />,
    );
    return updated;
  };
  return { server, publish };
}

const wait = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};
const badgeKind = (): string | null =>
  screen.queryByTestId("square-badge")?.getAttribute("data-kind") ?? null;
const sentTries = (server: ServerApi): unknown[] =>
  vi
    .mocked(server.send)
    .mock.calls.map(([command]) => command)
    .filter((command) => command.type === "try_move");

describe("the pause after a try", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves a wrong move on its square with the cross for the pause, then puts it back", () => {
    const { publish } = renderItem(puzzle());
    drop("d2", "d4");
    publish(missedWithD4());
    expect(seen.at(-1)).toMatchObject({ fen: AFTER_D4, lastMove: ["d2", "d4"] });
    expect(seen.at(-1)?.movable?.color).toBeUndefined();
    expect(badgeKind()).toBe("cross");

    wait(MOVE_PAUSE_MS - 1);
    expect(seen.at(-1)?.fen).toBe(AFTER_D4);
    expect(badgeKind()).toBe("cross");

    wait(1);
    expect(seen.at(-1)).toMatchObject({ fen: START_FEN, movable: { color: "white" } });
  });

  it("keeps the student's drawings when the wrong move goes back", () => {
    const arrow = { orig: "e2", dest: "e4", brush: "green" } as DrawShape;
    const { publish } = renderItem(puzzle());
    drawn.shapes = [arrow];
    drop("d2", "d4");
    publish(missedWithD4());
    wait(MOVE_PAUSE_MS);
    expect(seen.at(-1)?.fen).toBe(START_FEN);
    expect(drawn.shapes).toEqual([arrow]);
  });

  it("shows the student's move for the pause before the reply it got", () => {
    const { publish } = renderItem(puzzle());
    drop("e2", "e4");
    publish(answeredWithE5());
    expect(seen.at(-1)).toMatchObject({ fen: AFTER_E4, lastMove: ["e2", "e4"] });
    expect(seen.at(-1)?.movable?.color).toBeUndefined();

    wait(MOVE_PAUSE_MS - 1);
    expect(seen.at(-1)).toMatchObject({ fen: AFTER_E4, lastMove: ["e2", "e4"] });

    wait(1);
    expect(seen.at(-1)).toMatchObject({
      fen: AFTER_E5,
      lastMove: ["e7", "e5"],
      movable: { color: "white" },
    });
  });

  it("plays the moves after a right answer in a line drill one at a time, ending on the published position", () => {
    const asked = repertoireActivity();
    const board = new Chess(asked.fen);
    board.move("c3");
    const afterC3 = board.fen();
    board.move("Nf6");
    const afterNf6 = board.fen();
    const answered = repertoireActivity({
      sans: [...ITALIAN_APPROACH, "c3", "Nf6", "d4"],
      training: { status: "in_progress", last_try: { uci: "c2c3", san: "c3", correct: true } },
    });
    const line = (answered.moves ?? []).map((move) =>
      move.san === "c3" ? { ...move, by: "student" as const } : move,
    );
    const { publish } = renderItem(asked);
    drop("c2", "c3");
    publish({ ...answered, moves: line });
    expect(seen.at(-1)).toMatchObject({ fen: afterC3, lastMove: ["c2", "c3"] });

    wait(MOVE_PAUSE_MS - 1);
    expect(seen.at(-1)?.fen).toBe(afterC3);
    wait(1);
    expect(seen.at(-1)).toMatchObject({ fen: afterNf6, lastMove: ["g8", "f6"] });
    expect(seen.at(-1)?.movable?.color).toBeUndefined();

    wait(MOVE_PAUSE_MS - 1);
    expect(seen.at(-1)?.fen).toBe(afterNf6);
    wait(1);
    expect(seen.at(-1)).toMatchObject({ fen: answered.fen, lastMove: ["d2", "d4"] });
    const settled = seen.length;
    wait(MOVE_PAUSE_MS * 3);
    expect(seen.length).toBe(settled);
  });

  it("refuses drops until the pause is over, after a wrong move and before a reply", () => {
    for (const [from, to, state] of [
      ["d2", "d4", missedWithD4()],
      ["e2", "e4", answeredWithE5()],
    ] as const) {
      const { publish } = renderItem(puzzle());
      drop(from, to);
      const server = publish(state);
      expect(seen.at(-1)?.movable?.color).toBeUndefined();
      // Chessground refuses a drop without a movable colour; one that reached the board's
      // callback all the same is refused there.
      drop("g1", "f3");
      wait(MOVE_PAUSE_MS - 1);
      drop("g1", "f3");
      expect(sentTries(server)).toEqual([]);

      wait(1);
      drop("g1", "f3");
      expect(sentTries(server)).toEqual([{ type: "try_move", uci: "g1f3", activity_id: 4 }]);
      cleanup();
    }
  });

  it("shows a new item at once and drops the pause it arrived in", () => {
    const { publish } = renderItem(puzzle());
    drop("e2", "e4");
    publish(answeredWithE5());
    expect(seen.at(-1)?.fen).toBe(AFTER_E4);

    const next = puzzle({
      fen: AFTER_NC6,
      legal_moves: legalMovesOf(AFTER_NC6),
      exploring: { fen: AFTER_NC6, line_san: [], trail: [] },
      served_at: "2026-03-01T00:01:00.000Z",
      item: {
        kind: "puzzle",
        puzzle_id: "f2",
        motif: "fork",
        difficulty: "easy",
        fen: AFTER_NC6,
        cursor: 0,
        reply_uci: null,
        position_in_queue: 3,
        queue_length: 10,
      },
    });
    seen.length = 0;
    publish(next);
    expect(seen.at(-1)).toMatchObject({ fen: AFTER_NC6, movable: { color: "white" } });

    wait(MOVE_PAUSE_MS * 2);
    expect(seen.map((config) => config.fen).filter((fen) => fen !== AFTER_NC6)).toEqual([]);
  });
});
