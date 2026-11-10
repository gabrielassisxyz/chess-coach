import type {
  ActivityState,
  DemoActivity,
  MetOpening,
  PausedTraining,
  RepertoireSummary,
  RepertoiresResponse,
  TrainingActivity,
} from "@chess-coach/shared";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardFactory } from "../src/components/Board.js";
import { PracticeHub, type PracticeHubProps } from "../src/components/PracticeHub.js";
import { type ServerApi, useServer } from "../src/hooks/useServer.js";
import { Practice } from "../src/screens/Practice.js";
import { formatInterval, nextBatchParts, trainingView } from "../src/state/practice.js";
import {
  type AddedOpening,
  addOpeningToServer,
  fetchRepertoireListFromServer,
  fetchRepertoiresFromServer,
} from "../src/state/repertoires-api.js";
import { initialChatState } from "../src/state/transcript.js";
import { createFakeSocket, FakeSocket } from "./fake-socket.js";
import { legalMovesOf, START_FEN } from "./fixtures.js";
import { motifCounts, progressOf, repertoireList } from "./practice-fixtures.js";

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
    lastMessageAt: null,
    tab: "play",
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
      expect(await within(due).findByText("4")).toBeTruthy();
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

  it("lists the fourteen Lichess motifs with descriptions plus the six library choices, each once", async () => {
    const motifs = async () => [...motifCounts, { motif: "opening-italian", count: 7 }];
    render(<Practice server={api(null)} {...hubProps} fetchMotifs={motifs} />);
    const card = await screen.findByRole("region", { name: "Puzzles by motif" });
    await within(card).findByRole("radio", { name: /hanging piece/i });
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
      const matches = await within(card).findAllByRole("radio", {
        name: new RegExp(`^${label},`, "i"),
      });
      expect(matches).toHaveLength(1);
    }
    expect(
      within(card)
        .getByRole("radio", { name: /hanging piece/i })
        .closest("label")?.textContent,
    ).toContain("An undefended piece, free to capture.");
    expect(
      (within(card).getByRole("radio", { name: /hanging piece/i }) as HTMLInputElement).disabled,
    ).toBe(false);
    expect(card.textContent).not.toContain("smothered-mate");
    expect(card.textContent).not.toContain("tactics");
    expect(within(card).queryByRole("radio", { name: /opening-white/ })).toBeNull();
    expect(within(card).queryByRole("radio", { name: /italian/i })).toBeNull();
  });

  it("starts the chosen motif at the chosen size", async () => {
    const server = api(null);
    render(<Practice server={server} {...hubProps} />);
    await screen.findByRole("radio", { name: /fork/i });
    fireEvent.click(screen.getByRole("radio", { name: /fork/i }));
    fireEvent.click(screen.getByRole("button", { name: "20" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Fork" }));
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
    const card = await screen.findByRole("region", { name: "Openings" });
    expect(within(card).getByText("Common positions")).toBeTruthy();
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

  it("shows the Italian row with its count and starts it as a puzzles drill", async () => {
    const server = api(null);
    const motifs = async () => [
      { motif: "fork", count: 28 },
      { motif: "opening-white", count: 12 },
      { motif: "opening-black", count: 0 },
      { motif: "opening-italian", count: 7 },
    ];
    render(<Practice server={server} {...hubProps} fetchMotifs={motifs} />);
    const card = await screen.findByRole("region", { name: "Openings" });
    expect(within(card).getByText("Italian Opening")).toBeTruthy();
    await within(card).findByText("7 positions");
    fireEvent.click(within(card).getByRole("button", { name: "Drill" }));
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "puzzles",
      motif: "opening-italian",
      size: 10,
    });
  });

  it("disables the Italian drill at 0 with the generate hint", async () => {
    render(<Practice server={api(null)} {...hubProps} />);
    const card = await screen.findByRole("region", { name: "Openings" });
    const drill = within(card).getByRole("button", { name: "Drill" }) as HTMLButtonElement;
    expect(drill.disabled).toBe(true);
    expect(within(card).getByText("Generate the Italian drill first")).toBeTruthy();
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

  it("explains a missing engine, disables the starts and retries the health check", async () => {
    const fetchHealth = vi.fn(missing);
    render(<Practice server={api(null)} {...hubProps} fetchHealth={fetchHealth} />);
    const card = await screen.findByRole("alert", { name: "Engine missing" });
    expect(card.textContent).toContain("Stockfish isn't running");
    for (const name of ["Review 4 cards", "Start any motif", "Drill as White", "Drill as Black"]) {
      const button = await screen.findByRole("button", { name });
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    const openings = await screen.findByRole("region", { name: "Openings" });
    expect(
      (within(openings).getByRole("button", { name: "Drill" }) as HTMLButtonElement).disabled,
    ).toBe(true);
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
    expect(screen.getByRole("heading", { name: "Card 1 of 3" })).toBeTruthy();
    expect(screen.getByText(/White to play/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Your move");
    expect(screen.queryByRole("group", { name: "Rate your recall" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue training" })).toBeNull();
  });

  it("shows the verdict, the expected move, the looked-at trail and a locked board once given up", () => {
    boards.length = 0;
    render(<Practice server={api(answeredCard)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByText("Solution shown")).toBeTruthy();
    expect(screen.getByText(/Expected d4/)).toBeTruthy();
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
    expect(
      (screen.getByRole("button", { name: "Continue training" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("a puzzle on the board", () => {
  it("never offers a rating, before or after the answer", () => {
    for (const status of ["prompt", "in_progress", "solved", "failed"] as const) {
      const { unmount } = render(
        <Practice server={api(puzzle({ status }))} createBoard={spyBoard} fetchMotifs={noMotifs} />,
      );
      expect(screen.getByRole("heading", { name: "Puzzle 2 of 10" })).toBeTruthy();
      expect(screen.queryByRole("group", { name: "Rate your recall" })).toBeNull();
      unmount();
    }
  });

  it("hides the motif for an Any-motif run while open and names it after the item ends", () => {
    const open = puzzle({ status: "prompt" });
    const { unmount } = render(
      <Practice server={api(open)} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    const heading = screen.getByRole("heading", { name: "Puzzle 2 of 10" });
    expect(heading.textContent).not.toContain("fork");
    expect(heading.textContent).not.toContain("Fork");
    expect(screen.queryByText("Fork")).toBeNull();
    unmount();
    const ended = puzzle({ status: "solved" });
    render(<Practice server={api(ended)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("heading", { name: "Puzzle 2 of 10" })).toBeTruthy();
    expect(screen.getByText("Fork")).toBeTruthy();
  });

  it("keeps the motif in the heading for a single-motif run", () => {
    const open = puzzle({ status: "prompt", run_motif: "fork" });
    const { unmount } = render(
      <Practice server={api(open)} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    expect(screen.getByRole("heading", { name: "Puzzle 2 of 10" })).toBeTruthy();
    expect(screen.getByText("Fork")).toBeTruthy();
    unmount();
    const ended = puzzle({ status: "solved", run_motif: "fork" });
    render(<Practice server={api(ended)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("heading", { name: "Puzzle 2 of 10" })).toBeTruthy();
    expect(screen.getAllByText("Fork")).toHaveLength(1);
  });

  it("reads Italian Opening for an italian drill", () => {
    const open = puzzle({ status: "prompt", run_motif: "opening-italian" });
    const { unmount } = render(
      <Practice server={api(open)} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    expect(screen.getByRole("heading", { name: "Puzzle 2 of 10" })).toBeTruthy();
    expect(screen.getByText("Italian Opening")).toBeTruthy();
    unmount();
    const ended = puzzle({ status: "solved", run_motif: "opening-italian" });
    render(<Practice server={api(ended)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByText("Italian Opening")).toBeTruthy();
    expect(screen.queryByText("Fork")).toBeNull();
  });

  it("is never rateable, even answered and carrying an exposure id", () => {
    const answered = puzzle({ status: "solved", exposure_id: "ex-9" });
    expect(trainingView(answered).canRate).toBe(false);
    expect(trainingView(card({ status: "solved" })).canRate).toBe(true);
  });

  it("offers Continue only once the puzzle is solved or failed", () => {
    const { rerender } = render(
      <Practice
        server={api(puzzle({ status: "in_progress" }))}
        fetchMotifs={noMotifs}
        createBoard={spyBoard}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Best move");
    expect(screen.queryByRole("button", { name: "Continue training" })).toBeNull();
    rerender(
      <Practice
        server={api(puzzle({ status: "solved" }))}
        fetchMotifs={noMotifs}
        createBoard={spyBoard}
      />,
    );
    const next = screen.getByRole("button", { name: "Continue training" }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
  });
});

describe("the end of the queue", () => {
  it("offers Finish training on the last item and shows the summary afterwards", () => {
    const last = puzzle({ status: "solved" });
    if (last.item.kind === "puzzle") last.item.position_in_queue = 10;
    const server = api(last);
    const { rerender } = render(
      <Practice server={server} fetchMotifs={noMotifs} createBoard={spyBoard} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Finish training" }));
    expect(server.send).toHaveBeenCalledWith({ type: "next_training_item", activity_id: 4 });

    const ended = api(puzzle({ status: "solved", summary: { solved: 7, failed: 3 } }));
    rerender(<Practice server={ended} fetchMotifs={noMotifs} createBoard={spyBoard} />);
    expect(screen.getByTestId("summary").textContent).toContain("7 solved, 3 failed");
    expect(screen.queryByRole("button", { name: "Continue training" })).toBeNull();
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

  it("says Not that move after a wrong try and puts the piece back on the served square", () => {
    boards.length = 0;
    const { rerender } = render(
      <Practice server={api(puzzle())} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    expect(screen.getByRole("status").textContent).toBe("Your move");
    const before = boards.length;
    const missed = puzzle({ tries: 1, last_try: { uci: "e2e4", san: "e4", correct: false } });
    rerender(<Practice server={api(missed)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("status").textContent).toBe("Not that move");
    expect(boards.length).toBeGreaterThan(before);
    expect(boards.at(-1)).toEqual({ movableColor: "white", fen: START_FEN, hint: {} });
  });

  it("drops the try-again line once a right try moves the puzzle on", () => {
    const next = puzzle({
      status: "in_progress",
      tries: 1,
      last_try: { uci: "e2e4", san: "e4", correct: true },
    });
    render(<Practice server={api(next)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("status").textContent).toBe("Best move");
  });

  it("offers View solution while open, sends show_solution, and has no Answer, Take back or Reset", () => {
    const server = api(card());
    const { rerender } = render(
      <Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    for (const name of [/^Answer/, "Take back", "Reset"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "View solution" }));
    expect(server.send).toHaveBeenCalledWith({ type: "show_solution", activity_id: 4 });
    rerender(<Practice server={api(answeredCard)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.queryByRole("button", { name: "View solution" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Continue training" }) as HTMLButtonElement).disabled,
    ).toBe(false);
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

  it("reads Solved for a solved puzzle, and offers no rating", () => {
    const solved = puzzle({
      status: "solved",
      last_try: { uci: "e2e4", san: "e4", correct: true },
    });
    render(<Practice server={api(solved)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("status").textContent).toBe("Solved");
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
        conversations: { play: [], games: [], practice: [] },
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
    fireEvent.click(screen.getByRole("button", { name: "Finish training" }));
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
    fireEvent.click(screen.getByRole("button", { name: "End" }));
    const dialog = screen.getByRole("dialog", { name: "End training" });
    expect(dialog.textContent).toContain("End this session? What you answered is kept.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(server.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "end_training" }));
    expect(screen.getByRole("heading", { name: "Card 1 of 3" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "End" }));
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

  it("reads Solved and no Expected line", () => {
    render(<Practice server={api(solvedCard)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("status").textContent).toBe("Solved");
    expect(screen.queryByText(/Expected/)).toBeNull();
  });

  it("says how many wrong tries it took when the first try missed", () => {
    const retried = card({ ...solvedCard, tries: 2 });
    render(<Practice server={api(retried)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByText(/1 move · 2 wrong tries/)).toBeTruthy();
  });

  it("keeps the rating group visible and Continue enabled", () => {
    render(<Practice server={api(solvedCard)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("group", { name: "Rate your recall" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Continue training" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("hint", () => {
  it("sends hint from the button", () => {
    const server = api(card());
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.click(screen.getByRole("button", { name: "Get a hint" }));
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
    expect(boards.at(-1)?.hint).toEqual({});
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

const noop = (): void => {};

function renderHub(props: Partial<PracticeHubProps> = {}) {
  return render(
    <PracticeHub
      progress={{ status: "ready", value: progressOf() }}
      motifs={{ status: "ready", value: motifCounts }}
      repertoires={{ status: "ready", value: repertoireList }}
      engineMissing={false}
      starting={null}
      failure={null}
      size={10}
      onSize={noop}
      onStart={noop}
      onStartRepertoire={noop}
      {...props}
    />,
  );
}

const scandinavian: MetOpening = {
  root: ["e4", "d5"],
  opening_name: "Scandinavian Defense",
  games: 3,
  repertoire_id: null,
};
const alekhine: MetOpening = {
  root: ["e4", "Nf6"],
  opening_name: "Alekhine Defense",
  games: 2,
  repertoire_id: null,
};
const caroKann: MetOpening = {
  root: ["e4", "c6"],
  opening_name: "Caro-Kann Defense",
  games: 1,
  repertoire_id: 5,
};
const unnamed: MetOpening = {
  root: ["e4", "e5", "Nf3", "Bc5"],
  opening_name: null,
  games: 1,
  repertoire_id: null,
};
const scandinavianDrill: RepertoireSummary = {
  id: 7,
  side: "white",
  group_name: "Scandinavian Defense",
  variation_name: "Mieses-Kotroc Variation (2.exd5)",
  moves: { recommended: 4, due: 6, all: 12 },
};

const listing = (
  met: MetOpening[],
  repertoires: RepertoireSummary[] = repertoireList,
): RepertoiresResponse => ({ repertoires, met });

const whiteOpenings = (): Promise<HTMLElement> =>
  screen.findByRole("region", { name: "White openings" });

// The list is read once after mount; this waits for that read to settle, however it ended.
const settle = (): Promise<void> => act(async () => {});

describe("the openings met in games", () => {
  it("lists under White openings each met root that has no drill, with its opening and game count", async () => {
    renderHub({
      fetchRepertoireList: async () => listing([scandinavian, alekhine, caroKann, unnamed]),
    });
    const white = await whiteOpenings();
    const list = await within(white).findByRole("list", { name: "Openings met in your games" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    const row = (index: number): HTMLElement => rows[index] as HTMLElement;
    expect(within(row(0)).getByText("Scandinavian Defense")).toBeTruthy();
    expect(within(row(0)).getByText("1.e4 d5")).toBeTruthy();
    expect(within(row(0)).getByText("3 games")).toBeTruthy();
    expect(within(row(1)).getByText("Alekhine Defense")).toBeTruthy();
    expect(within(row(1)).getByText("1.e4 Nf6")).toBeTruthy();
    expect(within(row(1)).getByText("2 games")).toBeTruthy();
    // The book has no name for it, so the line stands for the name and is not written twice.
    expect(within(row(2)).getAllByText("1.e4 e5 2.Nf3 Bc5")).toHaveLength(1);
    expect(within(row(2)).getByText("1 game")).toBeTruthy();
    expect(within(list).queryByText("Caro-Kann Defense")).toBeNull();
    expect(within(list).queryByText("1.e4 c6")).toBeNull();
  });

  it("does not list a root that already has a drill, and shows no heading when none is left", async () => {
    const read = vi.fn(async () => listing([caroKann]));
    renderHub({ fetchRepertoireList: read });
    const white = await whiteOpenings();
    await waitFor(() => expect(read).toHaveBeenCalled());
    await settle();
    expect(within(white).queryByText("Met in your games")).toBeNull();
    expect(within(white).queryByRole("list", { name: "Openings met in your games" })).toBeNull();
    expect(within(white).getByRole("heading", { name: "Italian Game" })).toBeTruthy();
  });

  it("keeps the drills it has and says what to do when the list cannot be read", async () => {
    const read = vi.fn(async (): Promise<RepertoiresResponse> => {
      throw new Error("down");
    });
    renderHub({ fetchRepertoireList: read });
    const white = await whiteOpenings();
    await waitFor(() => expect(read).toHaveBeenCalled());
    await within(white).findByText(
      "The openings met in your games could not be loaded. Reload the page to try again.",
    );
    expect(within(white).queryByText("Met in your games")).toBeNull();
    expect(within(white).getByRole("heading", { name: "Italian Game" })).toBeTruthy();
    // The three starts of the one drill, and its Coverage; no Add for an opening that could not be read.
    expect(within(white).getAllByRole("button")).toHaveLength(4);
  });

  it("says to reload when the run ended but the list could not be read again", async () => {
    const reads = [async () => listing([scandinavian])];
    const fetchRepertoireList = vi.fn(async () => {
      const next = reads.shift();
      if (!next) throw new Error("down");
      return next();
    });
    renderHub({ fetchRepertoireList, addOpening: async () => ({ truncated: false }) });
    const white = await whiteOpenings();
    fireEvent.click(
      await within(white).findByRole("button", { name: "Add Scandinavian Defense, 1.e4 d5" }),
    );
    const status = await within(white).findByText(/is built/);
    expect(status.textContent).toBe(
      "Scandinavian Defense is built. Reload the page to see its drill.",
    );
  });

  it("posts the root of the row with Add and shows the new drill's menu when the run ends", async () => {
    let finish: () => void = noop;
    const addOpening = vi.fn(
      (_root: readonly string[]) =>
        new Promise<AddedOpening>((resolve) => {
          finish = () => resolve({ truncated: false });
        }),
    );
    const reads = [
      listing([scandinavian, alekhine]),
      listing(
        [{ ...scandinavian, repertoire_id: 7 }, alekhine],
        [...repertoireList, scandinavianDrill],
      ),
    ];
    const fetchRepertoireList = vi.fn(async () => reads.shift() as RepertoiresResponse);
    renderHub({ fetchRepertoireList, addOpening });
    const white = await whiteOpenings();
    fireEvent.click(
      await within(white).findByRole("button", { name: "Add Scandinavian Defense, 1.e4 d5" }),
    );
    expect(addOpening).toHaveBeenCalledTimes(1);
    expect(addOpening).toHaveBeenCalledWith(["e4", "d5"]);

    // While the run goes on the row says so, no other root can be added, and no drill exists yet.
    const building = within(white).getByRole("button", {
      name: "Building Scandinavian Defense, 1.e4 d5",
    });
    expect(building.textContent).toBe("Building");
    expect((building as HTMLButtonElement).disabled).toBe(true);
    const other = within(white).getByRole("button", { name: "Add Alekhine Defense, 1.e4 Nf6" });
    expect((other as HTMLButtonElement).disabled).toBe(true);
    expect(within(white).getByRole("status").textContent).toContain("Building the drill");
    expect(within(white).queryByRole("heading", { name: "Scandinavian Defense" })).toBeNull();

    await act(async () => finish());
    await within(white).findByRole("heading", { name: "Scandinavian Defense" });
    expect(within(white).getByText("Mieses-Kotroc Variation (2.exd5)")).toBeTruthy();
    for (const name of ["Recommended 4", "Everything due 6", "All moves 12"]) {
      expect((within(white).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    }
    // The root has its drill now, so its row is gone; the other still waits to be added.
    expect(
      within(white).queryByRole("button", { name: /^(Add|Building) Scandinavian Defense/ }),
    ).toBeNull();
    const again = within(white).getByRole("button", { name: "Add Alekhine Defense, 1.e4 Nf6" });
    expect((again as HTMLButtonElement).disabled).toBe(false);
    expect(within(white).getByRole("status").textContent).toBe(
      "Scandinavian Defense is built. Its drill is listed above.",
    );
    expect(fetchRepertoireList).toHaveBeenCalledTimes(2);
  });

  it("starts the drill of the new menu like any other", async () => {
    const onStartRepertoire = vi.fn();
    const reads = [
      listing([scandinavian]),
      listing([{ ...scandinavian, repertoire_id: 7 }], [...repertoireList, scandinavianDrill]),
    ];
    renderHub({
      fetchRepertoireList: async () => reads.shift() as RepertoiresResponse,
      addOpening: async () => ({ truncated: false }),
      onStartRepertoire,
    });
    const white = await whiteOpenings();
    fireEvent.click(
      await within(white).findByRole("button", { name: "Add Scandinavian Defense, 1.e4 d5" }),
    );
    fireEvent.click(await within(white).findByRole("button", { name: "All moves 12" }));
    expect(onStartRepertoire).toHaveBeenCalledWith(7, "all");
  });

  it("adds a root the book does not name, under the line", async () => {
    const addOpening = vi.fn(async (_root: readonly string[]) => ({ truncated: false }));
    renderHub({ fetchRepertoireList: async () => listing([unnamed]), addOpening });
    const white = await whiteOpenings();
    fireEvent.click(await within(white).findByRole("button", { name: "Add 1.e4 e5 2.Nf3 Bc5" }));
    expect(addOpening).toHaveBeenCalledWith(["e4", "e5", "Nf3", "Bc5"]);
  });

  it("says why when the drill could not be built, and offers the root again", async () => {
    const addOpening = vi.fn(async (_root: readonly string[]) => {
      throw new Error("the explorer wants a Lichess API token");
    });
    renderHub({ fetchRepertoireList: async () => listing([scandinavian]), addOpening });
    const white = await whiteOpenings();
    fireEvent.click(
      await within(white).findByRole("button", { name: "Add Scandinavian Defense, 1.e4 d5" }),
    );
    const alert = await within(white).findByRole("alert");
    expect(alert.textContent).toBe("the explorer wants a Lichess API token");
    const again = await within(white).findByRole("button", {
      name: "Add Scandinavian Defense, 1.e4 d5",
    });
    expect((again as HTMLButtonElement).disabled).toBe(false);
    expect(within(white).queryByRole("status")).toBeNull();
  });

  it("waits for a start in flight before it adds", async () => {
    renderHub({
      fetchRepertoireList: async () => listing([scandinavian]),
      starting: { mode: "repertoire", motif: "due", repertoireId: 3 },
    });
    const white = await whiteOpenings();
    const add = await within(white).findByRole("button", {
      name: "Add Scandinavian Defense, 1.e4 d5",
    });
    expect((add as HTMLButtonElement).disabled).toBe(true);
  });

  // The server takes a unit as the drill of its root as soon as the root is stored, which is the
  // first seconds of a run. So after a run that stopped short, the refreshed list already names it.
  const partlyBuilt = listing(
    [{ ...scandinavian, repertoire_id: 7 }],
    [...repertoireList, scandinavianDrill],
  );

  it("says so when the run stopped at its request limit, and keeps the root on offer to carry on", async () => {
    const addOpening = vi
      .fn<(root: readonly string[]) => Promise<AddedOpening>>()
      .mockResolvedValueOnce({ truncated: true })
      .mockResolvedValueOnce({ truncated: false });
    const reads = [listing([scandinavian]), partlyBuilt, partlyBuilt];
    renderHub({
      fetchRepertoireList: async () => reads.shift() as RepertoiresResponse,
      addOpening,
    });
    const white = await whiteOpenings();
    const label = "Add Scandinavian Defense, 1.e4 d5";
    fireEvent.click(await within(white).findByRole("button", { name: label }));
    const stopped = await within(white).findByRole("alert");
    expect(stopped.textContent).toBe(
      "The run for Scandinavian Defense stopped at its request limit. Add it again to carry on.",
    );
    expect(within(white).queryByText(/is built/)).toBeNull();
    await within(white).findByRole("heading", { name: "Scandinavian Defense" });
    const again = within(white).getByRole("button", { name: label });
    expect((again as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(again);
    await within(white).findByText("Scandinavian Defense is built. Its drill is listed above.");
    expect(addOpening).toHaveBeenCalledTimes(2);
    expect(within(white).queryByRole("button", { name: /^Add Scandinavian Defense/ })).toBeNull();
    expect(within(white).queryByRole("alert")).toBeNull();
  });

  it("keeps the root on offer after a refusal even when the list already names its drill", async () => {
    const addOpening = vi.fn(async (_root: readonly string[]): Promise<AddedOpening> => {
      throw new Error("the explorer is still rate limiting after a wait");
    });
    const reads = [listing([scandinavian]), partlyBuilt];
    renderHub({
      fetchRepertoireList: async () => reads.shift() as RepertoiresResponse,
      addOpening,
    });
    const white = await whiteOpenings();
    const label = "Add Scandinavian Defense, 1.e4 d5";
    fireEvent.click(await within(white).findByRole("button", { name: label }));
    const alert = await within(white).findByRole("alert");
    expect(alert.textContent).toBe("the explorer is still rate limiting after a wait");
    const again = within(white).getByRole("button", { name: label });
    expect((again as HTMLButtonElement).disabled).toBe(false);
  });

  it("tells two roots that share a name apart by their lines", async () => {
    const inherited = (root: string[]): MetOpening => ({
      root,
      opening_name: "King's Pawn Game",
      games: 1,
      repertoire_id: null,
    });
    renderHub({
      fetchRepertoireList: async () => listing([inherited(["e4", "b5"]), inherited(["e4", "a5"])]),
    });
    const white = await whiteOpenings();
    expect(
      await within(white).findByRole("button", { name: "Add King's Pawn Game, 1.e4 b5" }),
    ).toBeTruthy();
    expect(
      within(white).getByRole("button", { name: "Add King's Pawn Game, 1.e4 a5" }),
    ).toBeTruthy();
  });
});

describe("the calls behind the openings met in games", () => {
  afterEach(() => vi.unstubAllGlobals());

  const answering = (status: number, body: string) => {
    const fetched = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(body, { status }),
    );
    vi.stubGlobal("fetch", fetched);
    return fetched;
  };

  it("posts the root to the repertoire source of the generator", async () => {
    const fetched = answering(200, "{}");
    await addOpeningToServer(["e4", "d5"]);
    expect(fetched).toHaveBeenCalledTimes(1);
    const [url, init] = fetched.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/openings/generate");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      sources: ["repertoire"],
      root: ["e4", "d5"],
    });
  });

  it("fails with the message the server gave when it refuses", async () => {
    answering(400, JSON.stringify({ error: "invalid_root", message: "the root starts with 1.e4" }));
    await expect(addOpeningToServer(["d4", "d5"])).rejects.toThrow("the root starts with 1.e4");
  });

  it("fails with the status when the answer has no message", async () => {
    answering(502, "not json");
    await expect(addOpeningToServer(["e4", "d5"])).rejects.toThrow("The server answered 502.");
  });

  it("reports whether the run stopped at its request limit", async () => {
    answering(200, JSON.stringify({ repertoire: { truncated: true } }));
    await expect(addOpeningToServer(["e4", "d5"])).resolves.toEqual({ truncated: true });
    answering(200, JSON.stringify({ repertoire: { truncated: false } }));
    await expect(addOpeningToServer(["e4", "d5"])).resolves.toEqual({ truncated: false });
    answering(200, "{}");
    await expect(addOpeningToServer(["e4", "d5"])).resolves.toEqual({ truncated: false });
  });

  it("explains a connection that ended before the run did", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(addOpeningToServer(["e4", "d5"])).rejects.toThrow(
      "The connection ended before the run did. The server may still be building the drill.",
    );
  });

  it("reads the drills and the met openings from one answer", async () => {
    const body = { repertoires: [], met: [scandinavian] };
    answering(200, JSON.stringify(body));
    await expect(fetchRepertoireListFromServer()).resolves.toEqual(body);
    answering(200, JSON.stringify(body));
    await expect(fetchRepertoiresFromServer()).resolves.toEqual([]);
  });
});
