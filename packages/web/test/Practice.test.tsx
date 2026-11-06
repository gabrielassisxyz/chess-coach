import type {
  ActivityState,
  DemoActivity,
  PausedTraining,
  TrainingActivity,
} from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardFactory } from "../src/components/Board.js";
import { type ServerApi, useServer } from "../src/hooks/useServer.js";
import { Practice } from "../src/screens/Practice.js";
import { formatInterval, NONE, nextBatchParts, trainingView } from "../src/state/practice.js";
import { createFakeSocket, FakeSocket } from "./fake-socket.js";
import { legalMovesOf, START_FEN } from "./fixtures.js";
import { motifCounts, progressOf } from "./practice-fixtures.js";

afterEach(cleanup);

const board = {
  activity_id: 4,
  orientation: "white" as const,
  fen: START_FEN,
  turn: "white" as const,
  last_move: null,
  legal_moves: legalMovesOf(START_FEN),
  input_enabled: true,
  pending: "none" as const,
};

function card(overrides: Partial<TrainingActivity> = {}): TrainingActivity {
  return {
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
      position_in_queue: 1,
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
    ...overrides,
  };
}

function puzzle(overrides: Partial<TrainingActivity> = {}): TrainingActivity {
  return {
    kind: "training",
    ...board,
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

const looked: TrainingActivity["exploring"]["trail"] = [
  { seq: 1, at_ms: 2000, kind: "move", line_san: ["e4"] },
  { seq: 2, at_ms: 5000, kind: "move", line_san: ["e4", "e5"] },
  { seq: 3, at_ms: 6000, kind: "undo", line_san: ["e4"] },
  { seq: 4, at_ms: 7000, kind: "move", line_san: ["c4"] },
];

const failed = {
  status: "failed" as const,
  input_enabled: false,
  legal_moves: [],
  last_move: { from: "d2", to: "d4" },
  expected: { uci: "d2d4", san: "d4" },
};

const answeredCard = card({
  ...failed,
  last_move: null,
  exploring: { fen: START_FEN, line_san: [], trail: looked },
  tries: 1,
  last_try: { uci: "c2c4", san: "c4", correct: false },
  gave_up: true,
  solution_line: ["d2d4"],
  suggested_quality: 0,
});

function api(activity: TrainingActivity | null): ServerApi {
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
    reconnectAttempt: 0,
    activity,
    connection: "connected",
    say: vi.fn(() => true),
    approve: vi.fn(),
    dismissError: vi.fn(),
    send: vi.fn(() => true),
  };
}

const boards: { movableColor: unknown; fen: unknown; hint: unknown }[] = [];
let boardMove: ((from: string, to: string) => void) | undefined;
const spyBoard: BoardFactory = (_element, config) => {
  const custom = config.highlight?.custom as Map<string, string> | undefined;
  boards.push({
    movableColor: config.movable?.color,
    fen: config.fen,
    hint: custom ? Object.fromEntries(custom) : undefined,
  });
  boardMove = config.events?.move as typeof boardMove;
  return {
    set: (next: {
      movable?: { color?: unknown };
      fen?: unknown;
      highlight?: { custom?: Map<string, string> };
    }) => {
      const nextCustom = next.highlight?.custom as Map<string, string> | undefined;
      boards.push({
        movableColor: next.movable?.color,
        fen: next.fen,
        hint: nextCustom ? Object.fromEntries(nextCustom) : undefined,
      });
    },
    destroy: vi.fn(),
  } as never;
};

const noMotifs = async () => [];

const hubProps = {
  fetchProgress: async () => progressOf(),
  fetchMotifs: async () => motifCounts,
};

describe("the hub", () => {
  it("shows the due numbers from the progress summary", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-01T12:00:00") });
    try {
      render(<Practice server={api(null)} {...hubProps} />);
      const due = await screen.findByRole("region", { name: "Due cards" });
      expect(within(due).getByText("4")).toBeTruthy();
      expect(due.textContent).toContain("due now · from 3 games");
      expect(within(due).getByText("Blunders").nextSibling?.textContent).toBe("2");
      expect(within(due).getByText("Mistakes").nextSibling?.textContent).toBe("1");
      expect(within(due).getByText("Teaching").nextSibling?.textContent).toBe("1");
      expect(within(due).queryByText("Inaccuracies")).toBeNull();
      expect(within(due).getByText("Next batch 3").nextSibling?.textContent).toMatch(
        /^(today|tomorrow|[A-Z][a-z]{2}) \d\d:\d\d$/,
      );
      expect(within(due).getByText("Remembered, 30 days").nextSibling?.textContent).toBe("83%");
      expect(within(due).getByRole("button", { name: "Review 4 cards" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists a row per motif with its 30-day success and leaves the opening motifs to their own card", async () => {
    render(<Practice server={api(null)} {...hubProps} />);
    const card = await screen.findByRole("region", { name: "Puzzles by motif" });
    await within(card).findByRole("radio", { name: /fork/ });
    expect(
      within(card).getByRole("radio", { name: /fork/ }).closest("label")?.textContent,
    ).toContain("71%");
    expect(
      within(card).getByRole("radio", { name: /pin/ }).closest("label")?.textContent,
    ).toContain(NONE);
    expect(within(card).queryByRole("radio", { name: /opening/ })).toBeNull();
    const empty = within(card).getByRole("radio", { name: /smothered/ }) as HTMLInputElement;
    expect(empty.disabled).toBe(true);
    expect(empty.closest("label")?.textContent).toContain(NONE);
  });

  it("starts the chosen motif at the chosen size", async () => {
    const server = api(null);
    render(<Practice server={server} {...hubProps} />);
    await screen.findByRole("radio", { name: /fork/ });
    fireEvent.click(screen.getByRole("radio", { name: /fork/ }));
    fireEvent.click(screen.getByRole("button", { name: "20" }));
    fireEvent.click(screen.getByRole("button", { name: "Start fork" }));
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "puzzles",
      motif: "fork",
      size: 20,
    });
  });

  it("drills the openings per colour from the motif counts, disabling a colour with none", async () => {
    const server = api(null);
    render(<Practice server={server} {...hubProps} />);
    const card = await screen.findByRole("region", { name: "Opening drill" });
    await within(card).findByText("12 positions");
    expect(
      (within(card).getByRole("button", { name: "Drill as Black" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(card).getByRole("button", { name: "Drill as White" }));
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "openings",
      color: "white",
      size: 10,
    });
  });

  it("starts the due-card review with the default size", async () => {
    const server = api(null);
    render(<Practice server={server} {...hubProps} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review 4 cards" }));
    expect(server.send).toHaveBeenCalledWith({ type: "start_training", mode: "srs", size: 10 });
  });

  it("says the student is caught up, with the next batch, when nothing is due", async () => {
    const server = api(null);
    const empty = progressOf({ due_now: 0, due_by_classification: {}, due_from_games: 0 });
    render(<Practice server={server} {...hubProps} fetchProgress={async () => empty} />);
    const due = await screen.findByRole("region", { name: "Due cards" });
    await within(due).findByText(/you're caught up/);
    expect(within(due).getByText("Next batch 3")).toBeTruthy();
    expect(within(due).queryByRole("button")).toBeNull();
  });
});

describe("the next batch time", () => {
  const now = new Date(2026, 2, 1, 12, 0);
  const at = (day: number, hour: number, minute = 0) =>
    nextBatchParts(new Date(2026, 2, day, hour, minute).toISOString(), 3, now);

  it("names today, tomorrow or the weekday, with the local clock time and the count", () => {
    expect(at(1, 18, 30)).toEqual({ label: "Next batch 3", when: "today 18:30" });
    expect(at(2, 7)).toEqual({ label: "Next batch 3", when: "tomorrow 07:00" });
    expect(at(4, 7)?.when).toBe("Wed 07:00");
    expect(nextBatchParts(null, 0, now)).toBeNull();
  });
});

describe("a hub with a problem", () => {
  const missing = async () => ({
    status: "ok" as const,
    version: "test",
    ready: false,
    reason: "stockfish_missing",
  });

  it("explains a missing engine, disables the three starts and retries the health check", async () => {
    const fetchHealth = vi.fn(missing);
    render(<Practice server={api(null)} {...hubProps} fetchHealth={fetchHealth} />);
    const card = await screen.findByRole("alert", { name: "Engine missing" });
    expect(card.textContent).toContain("Stockfish isn't running");
    for (const name of ["Review 4 cards", "Start any motif", "Drill as White", "Drill as Black"]) {
      const button = await screen.findByRole("button", { name });
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    const before = fetchHealth.mock.calls.length;
    fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchHealth.mock.calls.length).toBeGreaterThan(before));
  });

  it("copies the fix command", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Practice server={api(null)} {...hubProps} fetchHealth={missing} />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy the command" }));
    expect(writeText).toHaveBeenCalledWith("sudo pacman -S stockfish");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("offers Check again for a coach that is not logged in, and shows it again on the next failure", async () => {
    const authFailure = {
      type: "turn_error" as const,
      key: "e1",
      message: "Not logged in. Run /login",
    };
    const server = api(null);
    const view = render(<Practice server={{ ...server, items: [authFailure] }} {...hubProps} />);
    const card = await screen.findByRole("alert", { name: "Coach not logged in" });
    expect(card.textContent).toContain("sign in with /login");
    fireEvent.click(within(card).getByRole("button", { name: "Check again" }));
    expect(screen.queryByRole("alert", { name: "Coach not logged in" })).toBeNull();
    view.rerender(
      <Practice
        server={{ ...server, items: [authFailure, { ...authFailure, key: "e2" }] }}
        {...hubProps}
      />,
    );
    expect(await screen.findByRole("alert", { name: "Coach not logged in" })).toBeTruthy();
  });

  it("shows no problem card when the engine is ready and the coach answered", async () => {
    render(
      <Practice
        server={{
          ...api(null),
          items: [
            { type: "turn_error", key: "e1", message: "Not logged in" },
            { type: "text", key: "t1", role: "assistant", text: "Hello" },
          ],
        }}
        {...hubProps}
        fetchHealth={async () => ({ status: "ok", version: "test", ready: true })}
      />,
    );
    await screen.findByRole("button", { name: "Review 4 cards" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a card on the board", () => {
  it("shows the breadcrumb, the side to move and the prompt status, with no rating yet", () => {
    render(<Practice server={api(card())} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("heading", { name: "Practice › Due cards · 1 of 3" })).toBeTruthy();
    expect(screen.getByText("White to move")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Your move");
    expect(screen.queryByRole("group", { name: "Rate your recall" })).toBeNull();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the verdict, the expected move, the looked-at trail and a locked board once given up", () => {
    boards.length = 0;
    render(<Practice server={api(answeredCard)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByText("Solution shown")).toBeTruthy();
    expect(screen.getByText("Expected d4")).toBeTruthy();
    expect(screen.getByRole("region", { name: "What you looked at \u00b7 0:07" })).toBeTruthy();
    expect(screen.getByText("e4 e5 \u2014 back")).toBeTruthy();
    expect(boards.at(-1)?.movableColor).toBeUndefined();
  });

  it("lets the student move only their own side while the card is open", () => {
    boards.length = 0;
    render(<Practice server={api(card())} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(boards.at(-1)?.movableColor).toBe("white");
  });

  it("allows next once rated and stops offering the rating", () => {
    render(
      <Practice
        server={api(card({ ...failed, status: "rated" }))}
        createBoard={spyBoard}
        fetchMotifs={noMotifs}
      />,
    );
    expect(screen.queryByRole("group", { name: "Rate your recall" })).toBeNull();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("a puzzle on the board", () => {
  it("never offers a rating, before or after the answer", () => {
    for (const status of ["prompt", "in_progress", "solved", "failed"] as const) {
      const { unmount } = render(
        <Practice server={api(puzzle({ status }))} createBoard={spyBoard} fetchMotifs={noMotifs} />,
      );
      expect(
        screen.getByRole("heading", { name: "Practice › Puzzles · fork · 2 of 10" }),
      ).toBeTruthy();
      expect(screen.queryByRole("group", { name: "Rate your recall" })).toBeNull();
      unmount();
    }
  });

  it("is never rateable, even answered and carrying an exposure id", () => {
    const answered = puzzle({ status: "solved", exposure_id: "ex-9" });
    expect(trainingView(answered).canRate).toBe(false);
    expect(trainingView(card({ status: "solved" })).canRate).toBe(true);
  });

  it("keeps next disabled until the puzzle is solved or failed", () => {
    const next = () => screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    const { rerender } = render(
      <Practice
        server={api(puzzle({ status: "in_progress" }))}
        fetchMotifs={noMotifs}
        createBoard={spyBoard}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Correct, keep going");
    expect(next().disabled).toBe(true);
    rerender(
      <Practice
        server={api(puzzle({ status: "solved" }))}
        fetchMotifs={noMotifs}
        createBoard={spyBoard}
      />,
    );
    expect(next().disabled).toBe(false);
  });
});

describe("the end of the queue", () => {
  it("offers Finish on the last item and shows the summary afterwards", () => {
    const last = puzzle({ status: "solved" });
    if (last.item.kind === "puzzle") last.item.position_in_queue = 10;
    const server = api(last);
    const { rerender } = render(
      <Practice server={server} fetchMotifs={noMotifs} createBoard={spyBoard} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(server.send).toHaveBeenCalledWith({ type: "next_training_item", activity_id: 4 });

    const ended = api(puzzle({ status: "solved", summary: { solved: 7, failed: 3 } }));
    rerender(<Practice server={ended} fetchMotifs={noMotifs} createBoard={spyBoard} />);
    expect(screen.getByTestId("summary").textContent).toContain("7 solved, 3 failed");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(ended.send).toHaveBeenCalledWith({ type: "end_training", activity_id: 4 });
  });
});

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

describe("grading on drop", () => {
  it("sends a drop as try_move, and never as exploration", () => {
    const server = api(card());
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    (boardMove as (from: string, to: string) => void)("e2", "e4");
    expect(server.send).toHaveBeenCalledWith({ type: "try_move", uci: "e2e4", activity_id: 4 });
    expect(server.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "explore" }));
  });

  it("says Not it, try again after a wrong try and puts the piece back on the served square", () => {
    boards.length = 0;
    const { rerender } = render(
      <Practice server={api(puzzle())} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    expect(screen.getByRole("status").textContent).toBe("Your move");
    const before = boards.length;
    const missed = puzzle({ tries: 1, last_try: { uci: "e2e4", san: "e4", correct: false } });
    rerender(<Practice server={api(missed)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("status").textContent).toBe("Not it, try again");
    expect(boards.length).toBeGreaterThan(before);
    expect(boards.at(-1)).toEqual({ movableColor: "white", fen: START_FEN });
  });

  it("drops the try-again line once a right try moves the puzzle on", () => {
    const next = puzzle({
      status: "in_progress",
      tries: 1,
      last_try: { uci: "e2e4", san: "e4", correct: true },
    });
    render(<Practice server={api(next)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("status").textContent).toBe("Correct, keep going");
  });

  it("offers Solution while open, sends show_solution, and has no Answer, Take back or Reset", () => {
    const server = api(card());
    const { rerender } = render(
      <Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    for (const name of [/^Answer/, "Take back", "Reset"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Solution" }));
    expect(server.send).toHaveBeenCalledWith({ type: "show_solution", activity_id: 4 });
    rerender(<Practice server={api(answeredCard)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.queryByRole("button", { name: "Solution" })).toBeNull();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("plays the solution line on the board one move every 600 ms, then stays on the last", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      boards.length = 0;
      const gaveUp = puzzle({
        ...failed,
        last_move: null,
        expected: { uci: "e2e4", san: "e4" },
        gave_up: true,
        solution_line: ["e2e4", "e7e5"],
      });
      render(<Practice server={api(gaveUp)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
      expect(boards.at(-1)?.fen).toBe(START_FEN);
      act(() => {
        vi.advanceTimersByTime(599);
      });
      expect(boards.at(-1)?.fen).toBe(START_FEN);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(boards.at(-1)?.fen).toBe(AFTER_E4);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(boards.at(-1)?.fen).toBe(AFTER_E5);
      const settled = boards.length;
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(boards.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the exploration trail and the timer", () => {
  it("lists every step newest last once the item is over, with back markers and offsets", () => {
    const afterUndo = card({
      ...failed,
      exploring: { fen: START_FEN, line_san: [], trail: looked.slice(0, 3) },
    });
    render(<Practice server={api(afterUndo)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    const items = within(screen.getByRole("region", { name: /What you looked at/ })).getAllByRole(
      "listitem",
    );
    expect(items.map((item) => item.textContent)).toEqual([
      "e4after 2s",
      "e4 e5after 5s",
      "e4 e5 \u2014 backafter 6s",
    ]);
  });

  it("marks a reset against the line it cleared", () => {
    const reset = card({
      ...failed,
      exploring: {
        fen: START_FEN,
        line_san: [],
        trail: [
          { seq: 1, at_ms: 1000, kind: "move", line_san: ["e4"] },
          { seq: 2, at_ms: 3000, kind: "reset", line_san: [] },
        ],
      },
    });
    render(<Practice server={api(reset)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByText("e4 \u2014 reset")).toBeTruthy();
  });

  it("leaves the trail out when nothing was explored", () => {
    render(<Practice server={api(card(failed))} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.queryByRole("region", { name: /What you looked at/ })).toBeNull();
  });

  it("counts the elapsed time from served_at on the client clock", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      vi.setSystemTime(new Date("2026-03-01T00:02:45.000Z"));
      render(<Practice server={api(card())} createBoard={spyBoard} fetchMotifs={noMotifs} />);
      expect(screen.getByRole("timer").textContent).toBe("2:45");
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByRole("timer").textContent).toBe("2:48");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("rating a card", () => {
  const rate = () =>
    render(<Practice server={api(answeredCard)} createBoard={spyBoard} fetchMotifs={noMotifs} />);

  it("says in words and days what each grade means, from the rating preview", () => {
    rate();
    const buttons = within(screen.getByRole("group", { name: "Rate your recall" })).getAllByRole(
      "button",
    );
    expect(buttons.map((button) => button.textContent)).toEqual([
      "0Blank \u2014 no idea4 h",
      "1Wrong, recognised it4 h",
      "2Wrong, nearly there4 h",
      "3Right, with effort1 d",
      "4Right, hesitated1 d",
      "5Easy3 d",
    ]);
  });

  it("writes minutes for a short interval", () => {
    expect(formatInterval(0.17)).toBe("10 min");
    expect(formatInterval(0.001)).toBe("1 min");
    expect(formatInterval(5)).toBe("5 h");
    expect(formatInterval(48)).toBe("2 d");
    expect(formatInterval(36)).toBe("2 d");
  });

  it("rates by clicking a button", () => {
    const server = api(answeredCard);
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.click(screen.getByRole("button", { name: /^4 Right, hesitated/ }));
    expect(server.send).toHaveBeenCalledWith({
      type: "rate_card",
      exposure_id: "ex-1",
      quality: 4,
      activity_id: 4,
    });
  });

  it("rates with the keys 0 to 5, except while typing", () => {
    const server = api(answeredCard);
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.keyDown(document.body, { key: "2" });
    expect(server.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "rate_card", quality: 2 }),
    );
    vi.mocked(server.send).mockClear();
    const field = document.body.appendChild(document.createElement("textarea"));
    fireEvent.keyDown(field, { key: "3" });
    fireEvent.keyDown(document.body, { key: "6" });
    fireEvent.keyDown(document.body, { key: "1", ctrlKey: true });
    expect(server.send).not.toHaveBeenCalled();
    field.remove();
  });

  it("stops listening for the keys once the card is rated", () => {
    const server = api(card({ ...answeredCard, status: "rated" }));
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.keyDown(document.body, { key: "2" });
    expect(server.send).not.toHaveBeenCalled();
    expect(screen.getByText("Rated")).toBeTruthy();
  });

  it("pre-selects the suggested rating and still rates any other", () => {
    const server = api(card({ ...failed, suggested_quality: 2 }));
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    const group = screen.getByRole("group", { name: "Rate your recall" });
    const pressed = within(group)
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed.map((button) => button.textContent?.charAt(0))).toEqual(["2"]);
    expect(document.activeElement).toBe(pressed[0]);
    fireEvent.click(screen.getByRole("button", { name: /^5 Easy/ }));
    expect(server.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "rate_card", quality: 5 }),
    );
  });

  it("pre-selects 4 for a first-try right card and 0 for a given-up one", () => {
    const pressedOf = () =>
      within(screen.getByRole("group", { name: "Rate your recall" }))
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-pressed") === "true")
        .map((button) => button.textContent?.charAt(0));
    const right = card({ status: "solved", input_enabled: false, suggested_quality: 4 });
    const { unmount } = render(
      <Practice server={api(right)} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    expect(pressedOf()).toEqual(["4"]);
    unmount();
    render(<Practice server={api(answeredCard)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(pressedOf()).toEqual(["0"]);
  });

  it("shows Right with the played move for a solved puzzle, and no rating", () => {
    const solved = puzzle({
      status: "solved",
      last_try: { uci: "e2e4", san: "e4", correct: true },
    });
    render(<Practice server={api(solved)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByText("Right e4")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Rate your recall" })).toBeNull();
  });
});

describe("a coach demo over training", () => {
  function demoActivity(): DemoActivity {
    return {
      kind: "demo",
      activity_id: 9,
      orientation: "white",
      fen: START_FEN,
      turn: "white",
      last_move: null,
      legal_moves: [],
      input_enabled: false,
      pending: "none",
      returns_to: "training",
      moves_played: ["e4"],
    };
  }

  it("renders the demo board with a Back to session button that leaves the demo", () => {
    boards.length = 0;
    const server = api(demoActivity() as unknown as TrainingActivity);
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(boards.at(-1)?.fen).toBe(START_FEN);
    const back = screen.getByRole("button", { name: "Back to session" });
    expect(back).toBeTruthy();
    fireEvent.click(back);
    expect(server.send).toHaveBeenCalledWith({ type: "leave_demo", activity_id: 9 });
  });

  it("keeps the hub hidden while the demo is on the board", () => {
    const server = api(demoActivity() as unknown as TrainingActivity);
    render(<Practice server={server} {...hubProps} createBoard={spyBoard} />);
    expect(screen.queryByRole("button", { name: "Review 4 cards" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back to session" })).toBeTruthy();
  });

  it("ignores a demo that does not return to training", async () => {
    const other: ActivityState = { ...demoActivity(), returns_to: null };
    const server = api(other as unknown as TrainingActivity);
    render(<Practice server={server} {...hubProps} createBoard={spyBoard} />);
    expect(screen.queryByRole("button", { name: "Back to session" })).toBeNull();
    expect(await screen.findByRole("button", { name: "Review 4 cards" })).toBeTruthy();
  });
});

// The page as the browser builds it: a socket, the bootstrap frame, and the screen on top.
function Connected() {
  const server = useServer({ url: "ws://test/api/ws", createSocket: createFakeSocket });
  return <Practice server={server} {...hubProps} />;
}

describe("a paused session", () => {
  const paused: PausedTraining = {
    run_id: 3,
    mode: "puzzles",
    motif: "fork",
    color: null,
    position: 2,
    size: 5,
    solved: 1,
    failed: 1,
  };

  function bootInto(activity: TrainingActivity | null, pausedTraining: PausedTraining | null) {
    FakeSocket.reset();
    render(<Connected />);
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        transcript: [],
        activity,
        paused_training: pausedTraining,
      }),
    );
    return FakeSocket.latest;
  }

  it("shows the resume card from a bootstrap carrying a paused run", async () => {
    bootInto(null, paused);
    const resume = await screen.findByRole("region", { name: "Paused session" });
    expect(within(resume).getByText("Resume: Puzzles · 3 of 5")).toBeTruthy();
    expect(within(resume).getByText("1 right, 1 missed so far")).toBeTruthy();
  });

  it("sends resume_training and discard_training from its buttons", async () => {
    const socket = bootInto(null, paused);
    const resume = await screen.findByRole("region", { name: "Paused session" });
    fireEvent.click(within(resume).getByRole("button", { name: "Resume" }));
    fireEvent.click(within(resume).getByRole("button", { name: "Discard" }));
    expect(socket.sent.map((frame) => (frame as { type: string }).type)).toEqual([
      "resume_training",
      "discard_training",
    ]);
  });

  it("leaves the card out with no paused run, and while the board is training", async () => {
    bootInto(null, null);
    await screen.findByRole("region", { name: "Due cards" });
    expect(screen.queryByRole("region", { name: "Paused session" })).toBeNull();
    cleanup();
    bootInto(card(), paused);
    expect(screen.queryByRole("region", { name: "Due cards" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Paused session" })).toBeNull();
  });

  it("drops the card once an activity update says nothing is paused", async () => {
    const socket = bootInto(null, paused);
    await screen.findByRole("region", { name: "Paused session" });
    act(() => socket.receive({ type: "activity", state: null, paused_training: null }));
    expect(screen.queryByRole("region", { name: "Paused session" })).toBeNull();
  });
});

describe("finishing a queue", () => {
  it("sends end_training after the summary and lands on the hub with the last-session line", () => {
    window.localStorage.clear();
    const last = puzzle({ status: "solved" });
    if (last.item.kind === "puzzle") {
      last.item.position_in_queue = 5;
      last.item.queue_length = 5;
    }
    const server = api(last);
    const { rerender } = render(<Practice server={server} {...hubProps} createBoard={spyBoard} />);
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(server.send).toHaveBeenCalledWith({ type: "next_training_item", activity_id: 4 });

    const finished = api(puzzle({ status: "solved", summary: { solved: 5, failed: 0 } }));
    rerender(<Practice server={finished} {...hubProps} createBoard={spyBoard} />);
    expect(finished.send).toHaveBeenCalledWith({ type: "end_training", activity_id: 4 });

    rerender(<Practice server={api(null)} {...hubProps} createBoard={spyBoard} />);
    expect(screen.queryByTestId("summary")).toBeNull();
    expect(screen.getByTestId("last-session").textContent).toContain("5 solved, 0 failed");
    expect(screen.getByRole("region", { name: "Due cards" })).toBeTruthy();
    window.localStorage.clear();
  });
});

describe("ending a session", () => {
  it("asks first, keeps the item on Cancel and ends on End", () => {
    const server = api(card());
    render(<Practice server={server} fetchMotifs={noMotifs} createBoard={spyBoard} />);
    fireEvent.click(screen.getByRole("button", { name: "End training" }));
    const dialog = screen.getByRole("dialog", { name: "End training" });
    expect(dialog.textContent).toContain("End this session? What you answered is kept.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(server.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "end_training" }));
    expect(screen.getByRole("heading", { name: "Practice › Due cards · 1 of 3" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "End training" }));
    const confirm = screen.getByRole("dialog", { name: "End training" });
    fireEvent.click(within(confirm).getByRole("button", { name: "End" }));
    expect(server.send).toHaveBeenCalledWith({ type: "end_training", activity_id: 4 });
  });
});

describe("a right card answer", () => {
  const solvedCard = card({
    status: "solved",
    input_enabled: false,
    legal_moves: [],
    last_move: { from: "d2", to: "d4" },
    expected: { uci: "d2d4", san: "d4" },
    exploring: { fen: START_FEN, line_san: [], trail: looked },
    last_try: { uci: "d2d4", san: "d4", correct: true },
  });

  it("reads Right with the played move and no Expected line", () => {
    render(<Practice server={api(solvedCard)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByText("Right d4")).toBeTruthy();
    expect(screen.queryByText(/Expected/)).toBeNull();
  });

  it("says how many wrong tries it took when the first try missed", () => {
    const retried = card({ ...solvedCard, tries: 2 });
    render(<Practice server={api(retried)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByText("After 2 wrong tries")).toBeTruthy();
  });

  it("keeps the rating group visible and Next enabled", () => {
    render(<Practice server={api(solvedCard)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("group", { name: "Rate your recall" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("hint", () => {
  it("sends hint from the button", () => {
    const server = api(card());
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.click(screen.getByRole("button", { name: "Hint" }));
    expect(server.send).toHaveBeenCalledWith({ type: "hint", activity_id: 4 });
  });

  it("renders the highlight and clears it after a try", () => {
    boards.length = 0;
    const { rerender } = render(
      <Practice
        server={api(card({ hint_square: "d2" }))}
        createBoard={spyBoard}
        fetchMotifs={noMotifs}
      />,
    );
    expect(boards.at(-1)?.hint).toEqual({ d2: "hint" });
    rerender(
      <Practice
        server={api(card({ hint_square: null }))}
        createBoard={spyBoard}
        fetchMotifs={noMotifs}
      />,
    );
    expect(boards.at(-1)?.hint).toBeUndefined();
  });
});

describe("explore mode", () => {
  it("routes drops to explore while exploring and never to try_move", () => {
    const server = api(card());
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    (boardMove as (from: string, to: string) => void)("e2", "e4");
    expect(server.send).toHaveBeenCalledWith({
      type: "explore",
      kind: "move",
      uci: "e2e4",
      activity_id: 4,
    });
    const calls = vi.mocked(server.send).mock.calls.map((args) => args[0]);
    expect(calls.filter((call) => (call as { uci?: string }).uci === "e2e4")).toEqual([
      { type: "explore", kind: "move", uci: "e2e4", activity_id: 4 },
    ]);
    expect(boards.at(-1)?.movableColor).toBe("both");
  });

  it("sends take back and reset through explore", () => {
    const server = api(card());
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    fireEvent.click(screen.getByRole("button", { name: "Take back" }));
    expect(server.send).toHaveBeenCalledWith({ type: "explore", kind: "undo", activity_id: 4 });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(server.send).toHaveBeenCalledWith({ type: "explore", kind: "reset", activity_id: 4 });
  });

  it("back to puzzle sends reset and restores graded drops", () => {
    const server = api(card({ exploring: { fen: AFTER_E4, line_san: ["e4"], trail: [] } }));
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to puzzle" }));
    expect(server.send).toHaveBeenCalledWith({ type: "explore", kind: "reset", activity_id: 4 });
    vi.mocked(server.send).mockClear();
    (boardMove as (from: string, to: string) => void)("d2", "d4");
    expect(server.send).toHaveBeenCalledWith({ type: "try_move", uci: "d2d4", activity_id: 4 });
    expect(server.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "explore" }));
  });
});
