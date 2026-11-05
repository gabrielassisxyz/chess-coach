import type { TrainingActivity } from "@chess-coach/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardFactory } from "../src/components/Board.js";
import type { ServerApi } from "../src/hooks/useServer.js";
import { Practice } from "../src/screens/Practice.js";
import { NONE, trainingView } from "../src/state/practice.js";
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
    summary: null,
    ...overrides,
  };
}

const failed = {
  status: "failed" as const,
  input_enabled: false,
  legal_moves: [],
  last_move: { from: "d2", to: "d4" },
  expected: { uci: "d2d4", san: "d4" },
};

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

const boards: { movableColor: unknown; fen: unknown }[] = [];
let boardMove: ((from: string, to: string) => void) | undefined;
const spyBoard: BoardFactory = (_element, config) => {
  boards.push({ movableColor: config.movable?.color, fen: config.fen });
  boardMove = config.events?.move as typeof boardMove;
  return {
    set: (next: { movable?: { color?: unknown }; fen?: unknown }) => {
      boards.push({ movableColor: next.movable?.color, fen: next.fen });
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
  it("shows the queue position and the prompt status, with no rating yet", () => {
    render(<Practice server={api(card())} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByText("Card 1 of 3")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Your move");
    expect(screen.queryByRole("group", { name: "Rate your recall" })).toBeNull();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the expected move, the rating buttons and a locked board after a miss", () => {
    boards.length = 0;
    const server = api(card(failed));
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("status").textContent).toContain("Missed");
    expect(screen.getByRole("status").textContent).toContain("Expected d4");
    expect(boards.at(-1)?.movableColor).toBeUndefined();
    const group = screen.getByRole("group", { name: "Rate your recall" });
    expect(group.querySelectorAll("button")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Rate 4" }));
    expect(server.send).toHaveBeenCalledWith({
      type: "rate_card",
      exposure_id: "ex-1",
      quality: 4,
      activity_id: 4,
    });
  });

  it("lets the student move while the card is open", () => {
    boards.length = 0;
    render(<Practice server={api(card())} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(boards.at(-1)?.movableColor).toBe("both");
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
      expect(screen.getByText("fork puzzle 2 of 10")).toBeTruthy();
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

describe("exploring before answering", () => {
  it("sends a board move as exploration and never as a grade", () => {
    const server = api(card());
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    (boardMove as (from: string, to: string) => void)("e2", "e4");
    expect(server.send).toHaveBeenCalledWith({
      type: "explore",
      kind: "move",
      uci: "e2e4",
      activity_id: 4,
    });
    expect(server.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "answer" }));
  });

  it("draws the explored position, not the served one", () => {
    boards.length = 0;
    const explored = card({
      exploring: { fen: AFTER_E4, line_san: ["e4"], trail: [] },
      turn: "black",
    });
    render(<Practice server={api(explored)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(boards.at(-1)?.fen).toBe(AFTER_E4);
  });

  it("keeps Answer disabled until something is explored, then sends the first move", () => {
    const empty = api(card());
    const { unmount } = render(
      <Practice server={empty} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    const answer = () => screen.getByRole("button", { name: "Answer" }) as HTMLButtonElement;
    expect(answer().disabled).toBe(true);
    for (const name of ["Take back", "Reset"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    unmount();

    const server = api(card({ exploring: { fen: AFTER_E4, line_san: ["e4", "e5"], trail: [] } }));
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(answer().disabled).toBe(false);
    fireEvent.click(answer());
    expect(server.send).toHaveBeenCalledWith({ type: "answer", uci: "e2e4", activity_id: 4 });
  });

  it("offers take back and reset while open, and no exploring controls once answered", () => {
    const server = api(card({ exploring: { fen: AFTER_E4, line_san: ["e4"], trail: [] } }));
    const { rerender } = render(
      <Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Take back" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(server.send).toHaveBeenCalledWith({ type: "explore", kind: "undo", activity_id: 4 });
    expect(server.send).toHaveBeenCalledWith({ type: "explore", kind: "reset", activity_id: 4 });
    rerender(<Practice server={api(card(failed))} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
  });
});
