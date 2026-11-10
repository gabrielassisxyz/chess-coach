import {
  type ActivityState,
  type DemoActivity,
  type MetOpening,
  type OpeningDrill,
  type OpeningDrillsResponse,
  type PausedTraining,
  type RepertoireSummary,
  type RepertoiresResponse,
  type TrainingActivity,
  UNNAMED_OPENING,
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
  addVariationToServer,
  fetchRepertoireListFromServer,
  fetchRepertoiresFromServer,
} from "../src/state/repertoires-api.js";
import { initialChatState } from "../src/state/transcript.js";
import { createFakeSocket, FakeSocket } from "./fake-socket.js";
import { legalMovesOf, START_FEN } from "./fixtures.js";
import {
  CLASSICAL_VARIATION,
  italianRepertoire,
  motifCounts,
  progressOf,
  repertoireActivity,
  repertoireList,
} from "./practice-fixtures.js";

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
const boardOrientations: unknown[] = [];
let boardMove: ((from: string, to: string) => void) | undefined;
const spyBoard: BoardFactory = (_element, config) => {
  let fen = String(config.fen);
  const custom = config.highlight?.custom as Map<string, string> | undefined;
  boards.push({
    movableColor: config.movable?.color,
    fen: config.fen,
    hint: custom ? Object.fromEntries(custom) : undefined,
  });
  boardOrientations.push(config.orientation);
  boardMove = config.events?.move as typeof boardMove;
  return {
    set: (next: {
      movable?: { color?: unknown };
      fen?: unknown;
      highlight?: { custom?: Map<string, string> };
      orientation?: unknown;
    }) => {
      if (next.fen) fen = String(next.fen);
      const nextCustom = next.highlight?.custom as Map<string, string> | undefined;
      boards.push({
        movableColor: next.movable?.color,
        fen: next.fen,
        hint: nextCustom ? Object.fromEntries(nextCustom) : undefined,
      });
      boardOrientations.push(next.orientation);
    },
    getFen: () => fen.split(" ")[0],
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
    for (const name of ["Review 4 cards", "Start any motif"]) {
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
const AFTER_NC6 = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
const AFTER_BC4 = "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3";
const AFTER_BC5 = "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
const AFTER_D4 = "r1bqkbnr/pppp1ppp/2n5/4p3/3PP3/5N2/PPP2PPP/RNBQKB1R b KQkq - 0 3";

const playedE4E5: NonNullable<TrainingActivity["moves"]> = [
  { ply: 0, uci: "e2e4", san: "e4", by: "student" },
  { ply: 1, uci: "e7e5", san: "e5", by: "reply" },
];

function puzzleAfterE5(overrides: Partial<TrainingActivity> = {}): TrainingActivity {
  return puzzle({
    status: "in_progress",
    fen: AFTER_E5,
    turn: "white",
    last_move: { from: "e7", to: "e5" },
    legal_moves: legalMovesOf(AFTER_E5),
    moves: playedE4E5,
    exploring: { fen: AFTER_E5, line_san: [], trail: [] },
    ...overrides,
  });
}

function exploredPuzzle(
  line: string[] = ["Nf3", "Nc6", "Bc4", "Bc5"],
  fen = AFTER_BC5,
): TrainingActivity {
  return puzzleAfterE5({
    turn: fen.split(" ")[1] === "b" ? "black" : "white",
    legal_moves: legalMovesOf(fen),
    exploring: { fen, line_san: line, trail: [] },
  });
}

function dropOnPracticeBoard(from: string, to: string): void {
  act(() => (boardMove as (from: string, to: string) => void)(from, to));
}

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
  const stepButton = (name: string): HTMLButtonElement =>
    screen.getByRole("button", { name }) as HTMLButtonElement;

  it("steps across item and explored moves with arrows and all four buttons", () => {
    boards.length = 0;
    render(
      <Practice server={api(exploredPuzzle())} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    fireEvent.click(stepButton("Explore"));
    expect(stepButton("Next move").disabled).toBe(true);
    expect(stepButton("Last move").disabled).toBe(true);

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(boards.at(-1)?.fen).toBe(AFTER_BC4);
    expect(stepButton("Next move").disabled).toBe(false);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(boards.at(-1)?.fen).toBe(AFTER_BC5);

    fireEvent.click(stepButton("Previous move"));
    expect(boards.at(-1)?.fen).toBe(AFTER_BC4);
    fireEvent.click(stepButton("First move"));
    expect(boards.at(-1)?.fen).toBe(START_FEN);
    expect(stepButton("First move").disabled).toBe(true);
    expect(stepButton("Previous move").disabled).toBe(true);
    fireEvent.click(stepButton("Next move"));
    expect(boards.at(-1)?.fen).toBe(AFTER_E4);
    fireEvent.click(stepButton("Last move"));
    expect(boards.at(-1)?.fen).toBe(AFTER_BC5);
    expect(stepButton("Next move").disabled).toBe(true);
  });

  it("flips the board with f while exploring", () => {
    boardOrientations.length = 0;
    render(
      <Practice server={api(puzzleAfterE5())} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    fireEvent.click(stepButton("Explore"));
    expect(boardOrientations.at(-1)).toBe("white");
    fireEvent.keyDown(window, { key: "f" });
    expect(boardOrientations.at(-1)).toBe("black");
  });

  it("undoes the open explored suffix before sending a new branch move", () => {
    boards.length = 0;
    const server = api(exploredPuzzle());
    const { rerender } = render(
      <Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    fireEvent.click(stepButton("Explore"));
    fireEvent.click(stepButton("Previous move"));
    fireEvent.click(stepButton("Previous move"));
    expect(boards.at(-1)?.fen).toBe(AFTER_NC6);

    vi.mocked(server.send).mockClear();
    dropOnPracticeBoard("d2", "d4");
    expect(vi.mocked(server.send).mock.calls.map(([command]) => command)).toEqual([
      { type: "explore", kind: "undo", activity_id: 4 },
      { type: "explore", kind: "undo", activity_id: 4 },
      { type: "explore", kind: "move", uci: "d2d4", activity_id: 4 },
    ]);
    rerender(
      <Practice
        server={api(exploredPuzzle(["Nf3", "Nc6", "d4"], AFTER_D4))}
        createBoard={spyBoard}
        fetchMotifs={noMotifs}
      />,
    );
    expect(boards.at(-1)?.fen).toBe(AFTER_D4);
    expect(screen.getByText("Nf3 Nc6 d4")).toBeTruthy();
    expect(stepButton("Next move").disabled).toBe(true);
  });

  it("replaces the ended item's local suffix without sending a command", () => {
    boards.length = 0;
    const server = api(puzzleAfterE5({ status: "solved", input_enabled: false, legal_moves: [] }));
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.click(stepButton("Explore"));
    for (const [from, to] of [
      ["g1", "f3"],
      ["b8", "c6"],
      ["f1", "c4"],
      ["f8", "c5"],
    ] as const) {
      dropOnPracticeBoard(from, to);
    }
    expect(screen.getByText("Nf3 Nc6 Bc4 Bc5")).toBeTruthy();
    fireEvent.click(stepButton("Previous move"));
    fireEvent.click(stepButton("Previous move"));
    expect(boards.at(-1)?.fen).toBe(AFTER_NC6);

    vi.mocked(server.send).mockClear();
    dropOnPracticeBoard("d2", "d4");
    expect(server.send).not.toHaveBeenCalled();
    expect(screen.getByText("Nf3 Nc6 d4")).toBeTruthy();
    expect(boards.at(-1)?.fen).toBe(AFTER_D4);
    expect(stepButton("Next move").disabled).toBe(true);
    fireEvent.click(stepButton("First move"));
    dropOnPracticeBoard("e2", "e4");
    expect(server.send).not.toHaveBeenCalled();
    expect(screen.getByText("Nf3 Nc6 d4")).toBeTruthy();
  });

  it("keeps the item's earlier positions read-only in Explore", () => {
    boards.length = 0;
    const server = api(exploredPuzzle());
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.click(stepButton("Explore"));
    fireEvent.click(stepButton("First move"));
    expect(boards.at(-1)?.movableColor).toBeUndefined();
    vi.mocked(server.send).mockClear();
    dropOnPracticeBoard("e2", "e4");
    expect(server.send).not.toHaveBeenCalled();
    fireEvent.click(stepButton("Next move"));
    dropOnPracticeBoard("e7", "e5");
    expect(server.send).not.toHaveBeenCalled();
    fireEvent.click(stepButton("Next move"));
    expect(boards.at(-1)?.fen).toBe(AFTER_E5);
    expect(boards.at(-1)?.movableColor).toBe("both");
    dropOnPracticeBoard("g1", "f3");
    expect(vi.mocked(server.send).mock.calls.map(([command]) => command)).toEqual([
      { type: "explore", kind: "undo", activity_id: 4 },
      { type: "explore", kind: "undo", activity_id: 4 },
      { type: "explore", kind: "undo", activity_id: 4 },
      { type: "explore", kind: "undo", activity_id: 4 },
      { type: "explore", kind: "move", uci: "g1f3", activity_id: 4 },
    ]);
  });

  it("still steps and blocks drops through the item outside Explore", () => {
    boards.length = 0;
    const server = api(puzzleAfterE5());
    render(<Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    fireEvent.click(stepButton("Previous move"));
    expect(boards.at(-1)?.fen).toBe(AFTER_E4);
    expect(boards.at(-1)?.movableColor).toBeUndefined();
    dropOnPracticeBoard("e7", "e5");
    expect(server.send).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(boards.at(-1)?.fen).toBe(AFTER_E5);
    dropOnPracticeBoard("g1", "f3");
    expect(server.send).toHaveBeenCalledWith({ type: "try_move", uci: "g1f3", activity_id: 4 });
  });

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

const ITALIAN_LINE = ["e4", "e5", "Nf3", "Nc6", "Bc4"];
const PIANISSIMO = "Giuoco Pianissimo (4.d3)";
const pianissimoDrill: RepertoireSummary = {
  id: 4,
  side: "white",
  group_name: "Italian Game",
  variation_name: PIANISSIMO,
  moves: { recommended: 6, due: 9, all: 20 },
};
const levelDrills = [...repertoireList, pianissimoDrill, scandinavianDrill];

// The answer for two Italian variations and a Scandinavian one: the levels count a move their
// variations share once, so their numbers are not the sums of the rows under them.
const levelListing = (overrides: Partial<RepertoiresResponse> = {}): RepertoiresResponse => ({
  repertoires: levelDrills,
  groups: [
    { side: "white", group_name: "Italian Game", moves: { recommended: 10, due: 18, all: 45 } },
    {
      side: "white",
      group_name: "Scandinavian Defense",
      moves: { recommended: 4, due: 6, all: 12 },
    },
  ],
  sides: [{ side: "white", moves: { recommended: 10, due: 22, all: 55 } }],
  met: [],
  branches: [],
  ...overrides,
});

const renderLevels = (props: Partial<PracticeHubProps> = {}) =>
  renderHub({
    repertoires: { status: "ready", value: levelDrills },
    fetchRepertoireList: async () => levelListing(),
    ...props,
  });

describe("the openings menu at each level", () => {
  it("starts every White opening, every Italian variation or one variation, each with its counts", async () => {
    const onStartRepertoire = vi.fn();
    renderLevels({ onStartRepertoire });
    const white = await whiteOpenings();
    fireEvent.click(
      await within(white).findByRole("button", { name: "Recommended 10, every White opening" }),
    );
    fireEvent.click(
      within(white).getByRole("button", {
        name: "Everything due 18, every variation of Italian Game",
      }),
    );
    fireEvent.click(within(white).getByRole("button", { name: "All moves 20" }));
    expect(onStartRepertoire.mock.calls).toEqual([
      [3, "recommended", "side"],
      [3, "due", "group"],
      [4, "all"],
    ]);
    expect(within(white).getByText("Every opening")).toBeTruthy();
    expect(within(white).getByText("Every variation")).toBeTruthy();
  });

  it("offers no group starts for an opening with one variation", async () => {
    renderLevels();
    const white = await whiteOpenings();
    await within(white).findByText("Every variation");
    expect(within(white).getAllByText("Every variation")).toHaveLength(1);
    expect(
      within(white).queryByRole("button", { name: /every variation of Scandinavian Defense/ }),
    ).toBeNull();
  });

  it("offers no level starts before the server has counted the levels", async () => {
    const read = vi.fn(async () => levelListing({ groups: undefined, sides: undefined }));
    renderLevels({ fetchRepertoireList: read });
    const white = await whiteOpenings();
    await waitFor(() => expect(read).toHaveBeenCalled());
    await settle();
    expect(within(white).queryByText("Every variation")).toBeNull();
    expect(within(white).queryByText("Every opening")).toBeNull();
    expect(within(white).getByRole("button", { name: "All moves 20" })).toBeTruthy();
  });

  it("marks the pressed level start as starting and not the same scope of its variation", async () => {
    renderLevels({
      starting: { mode: "repertoire", motif: "due", repertoireId: 3, level: "group" },
    });
    const white = await whiteOpenings();
    expect(
      await within(white).findByRole("button", {
        name: "Starting, every variation of Italian Game",
      }),
    ).toBeTruthy();
    expect(within(white).getByRole("button", { name: "Everything due 14" })).toBeTruthy();
    expect(within(white).queryByRole("button", { name: "Starting" })).toBeNull();
  });

  it("sends the level with the start of a group", async () => {
    const server = api(null);
    render(
      <Practice
        server={server}
        {...hubProps}
        fetchRepertoires={async () => levelDrills}
        fetchRepertoireList={async () => levelListing()}
      />,
    );
    // The loading card is replaced once the list has loaded, so it is found by what the list holds.
    await screen.findByRole("heading", { name: "Italian Game" });
    const white = screen.getByRole("region", { name: "White openings" });
    fireEvent.click(
      await within(white).findByRole("button", {
        name: "Everything due 18, every variation of Italian Game",
      }),
    );
    expect(server.send).toHaveBeenCalledTimes(1);
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "repertoire",
      repertoire_id: 3,
      scope: "due",
      level: "group",
    });
  });
});

const EVANS = "Evans Gambit (4.b4)";
const KNIGHT_ATTACK = "Two Knights Defense, Knight Attack (4.Ng5)";

// The Italian's first variation stored alone, and the book's other White moves where it goes.
const branchListing = (heldD3: number | null = null): RepertoiresResponse =>
  levelListing({
    repertoires:
      heldD3 === null
        ? [...repertoireList, scandinavianDrill]
        : [...repertoireList, { ...pianissimoDrill, id: heldD3 }, scandinavianDrill],
    branches: [
      {
        group_name: "Italian Game",
        line: [...ITALIAN_LINE, "Bc5"],
        choices: [
          { san: "c3", variation_name: CLASSICAL_VARIATION, repertoire_id: 3 },
          { san: "d3", variation_name: PIANISSIMO, repertoire_id: heldD3 },
          { san: "b4", variation_name: EVANS, repertoire_id: null },
        ],
      },
      {
        group_name: "Italian Game",
        line: [...ITALIAN_LINE, "Nf6"],
        choices: [
          {
            san: "d3",
            variation_name: "Two Knights Defense, Modern Bishop's Opening (4.d3)",
            repertoire_id: 3,
          },
          { san: "Ng5", variation_name: KNIGHT_ATTACK, repertoire_id: null },
        ],
      },
    ],
  });

describe("adding a variation at a branch point", () => {
  it("lists the book's White moves at each branch point of the Italian, with their names, once opened", async () => {
    renderHub({ fetchRepertoireList: async () => branchListing() });
    const white = await whiteOpenings();
    const toggle = await within(white).findByRole("button", { name: "Add a variation" });
    expect(within(white).getAllByRole("button", { name: "Add a variation" })).toHaveLength(1);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(white).queryByText(EVANS)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const afterBc5 = within(white).getByRole("list", { name: "White's moves after 3...Bc5" });
    expect(
      within(afterBc5)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([`${CLASSICAL_VARIATION}In your repertoire`, `${PIANISSIMO}Add`, `${EVANS}Add`]);
    expect(within(white).getByText("1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5")).toBeTruthy();
    const afterNf6 = within(white).getByRole("list", { name: "White's moves after 3...Nf6" });
    // 4.d3 is the first variation's own move against 3...Nf6, under another name than its own.
    expect(within(afterNf6).getByText(`Played in ${CLASSICAL_VARIATION}`)).toBeTruthy();
    expect(within(afterNf6).getByRole("button", { name: `Add ${KNIGHT_ATTACK}` })).toBeTruthy();
  });

  it("posts the branch of a choice with Add and shows the new variation when the run ends", async () => {
    let finish: () => void = noop;
    const addVariation = vi.fn(
      (_branch: readonly string[]) =>
        new Promise<AddedOpening>((resolve) => {
          finish = () => resolve({ truncated: false });
        }),
    );
    const reads = [branchListing(), branchListing(9)];
    const fetchRepertoireList = vi.fn(async () => reads.shift() as RepertoiresResponse);
    renderHub({ fetchRepertoireList, addVariation });
    const white = await whiteOpenings();
    fireEvent.click(await within(white).findByRole("button", { name: "Add a variation" }));
    fireEvent.click(within(white).getByRole("button", { name: `Add ${PIANISSIMO}` }));
    expect(addVariation).toHaveBeenCalledTimes(1);
    expect(addVariation).toHaveBeenCalledWith([...ITALIAN_LINE, "Bc5", "d3"]);

    // While the run goes on no other move can be added and the list says so.
    const building = within(white).getByRole("button", { name: `Building ${PIANISSIMO}` });
    expect((building as HTMLButtonElement).disabled).toBe(true);
    const other = within(white).getByRole("button", { name: `Add ${EVANS}` });
    expect((other as HTMLButtonElement).disabled).toBe(true);
    expect(within(white).getByRole("status").textContent).toContain("Building the drill");

    await act(async () => finish());
    expect(
      await within(white).findByText(`${PIANISSIMO} is built. Its drill is listed above.`),
    ).toBeTruthy();
    // The new variation has its own starts, and its move is held now.
    expect(within(white).getByRole("button", { name: "All moves 20" })).toBeTruthy();
    expect(within(white).queryByRole("button", { name: `Add ${PIANISSIMO}` })).toBeNull();
    expect(
      (within(white).getByRole("button", { name: `Add ${EVANS}` }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(fetchRepertoireList).toHaveBeenCalledTimes(2);
  });

  it("says why when the server refuses the branch, and offers the move again", async () => {
    const addVariation = vi.fn(async (_branch: readonly string[]) => {
      throw new Error("Classical Variation (4.c3) does not reach the position of 4.b4");
    });
    renderHub({ fetchRepertoireList: async () => branchListing(), addVariation });
    const white = await whiteOpenings();
    fireEvent.click(await within(white).findByRole("button", { name: "Add a variation" }));
    fireEvent.click(within(white).getByRole("button", { name: `Add ${EVANS}` }));
    expect((await within(white).findByRole("alert")).textContent).toBe(
      "Classical Variation (4.c3) does not reach the position of 4.b4",
    );
    expect(within(white).getByRole("button", { name: `Add ${EVANS}` })).toBeTruthy();
  });
});

describe("the call behind a new variation", () => {
  afterEach(() => vi.unstubAllGlobals());

  const answering = (status: number, body: string) => {
    const fetched = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(body, { status }),
    );
    vi.stubGlobal("fetch", fetched);
    return fetched;
  };

  it("posts the branch to the repertoire source of the generator", async () => {
    const fetched = answering(200, JSON.stringify({ repertoire: { truncated: true } }));
    await expect(addVariationToServer([...ITALIAN_LINE, "Bc5", "d3"])).resolves.toEqual({
      truncated: true,
    });
    const [url, init] = fetched.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/openings/generate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      sources: ["repertoire"],
      branch: [...ITALIAN_LINE, "Bc5", "d3"],
    });
  });

  it("fails with the message the server gave when it refuses the branch", async () => {
    answering(
      409,
      JSON.stringify({ error: "branch_refused", message: "4.c3 is already the move" }),
    );
    await expect(addVariationToServer([...ITALIAN_LINE, "Bc5", "c3"])).rejects.toThrow(
      "4.c3 is already the move",
    );
  });
});

const alekhineDrill: RepertoireSummary = {
  id: 8,
  side: "white",
  group_name: "Alekhine Defense",
  variation_name: "Modern Variation (2.e5)",
  moves: { recommended: 3, due: 4, all: 9 },
};
const foundDrills = [...repertoireList, scandinavianDrill, alekhineDrill];
const NOTHING_TO_DRILL = { moves: { recommended: 0, due: 0, all: 0 } };
const FOUND_START = "every added opening found in your games";

// The Italian the student chose, two units built from openings the games met, and two openings met
// that have no unit yet. The mixed drill of the two units counts a move they share once.
const foundListing = (overrides: Partial<RepertoiresResponse> = {}): RepertoiresResponse => ({
  repertoires: foundDrills,
  groups: [
    { side: "white", group_name: "Italian Game", moves: italianRepertoire.moves },
    { side: "white", group_name: "Scandinavian Defense", moves: scandinavianDrill.moves },
    { side: "white", group_name: "Alekhine Defense", moves: alekhineDrill.moves },
  ],
  sides: [{ side: "white", moves: { recommended: 10, due: 24, all: 59 } }],
  found: { moves: { recommended: 7, due: 9, all: 20 } },
  met: [
    { ...scandinavian, repertoire_id: 7 },
    { ...alekhine, repertoire_id: 8 },
    { ...caroKann, repertoire_id: null },
    unnamed,
  ],
  branches: [],
  ...overrides,
});

const renderFound = (props: Partial<PracticeHubProps> = {}) =>
  renderHub({
    repertoires: { status: "ready", value: foundDrills },
    fetchRepertoireList: async () => foundListing(),
    ...props,
  });

const foundSection = (white: HTMLElement): Promise<HTMLElement> =>
  within(white).findByRole("region", { name: "Found in your games" });

// Whether the second node follows the first in the document, which is the order the student reads.
const follows = (first: Element, second: Element): boolean =>
  (first.compareDocumentPosition(second) & 4) !== 0;

describe("the openings found in your games", () => {
  it("lists the added units, then the openings still to add, then the mixed starts with their counts", async () => {
    renderFound();
    const white = await whiteOpenings();
    const found = await foundSection(white);
    expect(
      within(found)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Found in your games", "Scandinavian Defense", "Alekhine Defense"]);

    const toAdd = within(found).getByRole("list", { name: "Openings met in your games" });
    expect(
      within(toAdd)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["Caro-Kann Defense1.e4 c61 gameAdd", "1.e4 e5 2.Nf3 Bc51 gameAdd"]);
    const alekhineMenu = within(found).getByRole("heading", { name: "Alekhine Defense" });
    const starts = within(found).getByRole("button", { name: `Recommended 7, ${FOUND_START}` });
    expect(follows(alekhineMenu, toAdd)).toBe(true);
    expect(follows(toAdd, starts)).toBe(true);
    expect(within(found).getByText("Every added opening, mixed")).toBeTruthy();
    for (const name of [`Everything due 9, ${FOUND_START}`, `All moves 20, ${FOUND_START}`]) {
      expect((within(found).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    }
  });

  it("gives each added unit the menu of any opening, with its own starts", async () => {
    renderFound();
    const found = await foundSection(await whiteOpenings());
    expect(within(found).getByText("Mieses-Kotroc Variation (2.exd5)")).toBeTruthy();
    expect(within(found).getByText("Modern Variation (2.e5)")).toBeTruthy();
    for (const name of ["Recommended 4", "Everything due 6", "Recommended 3", "All moves 9"]) {
      expect(within(found).getByRole("button", { name })).toBeTruthy();
    }
    expect(within(found).getAllByRole("button", { name: /^Coverage of / })).toHaveLength(2);
  });

  it("keeps the Italian out of the section, in the menu of chosen openings above it", async () => {
    renderFound();
    const white = await whiteOpenings();
    const found = await foundSection(white);
    expect(within(found).queryByRole("heading", { name: "Italian Game" })).toBeNull();
    expect(within(found).queryByText(CLASSICAL_VARIATION)).toBeNull();
    const italian = within(white).getByRole("heading", { name: "Italian Game" });
    expect(follows(italian, found)).toBe(true);
  });

  it("starts every added opening mixed from the first of them, whichever scope is pressed", async () => {
    const onStartRepertoire = vi.fn();
    renderFound({ onStartRepertoire });
    const found = await foundSection(await whiteOpenings());
    for (const name of ["Recommended 7", "Everything due 9", "All moves 20"]) {
      fireEvent.click(within(found).getByRole("button", { name: `${name}, ${FOUND_START}` }));
    }
    expect(onStartRepertoire.mock.calls).toEqual([
      [7, "recommended", "found"],
      [7, "due", "found"],
      [7, "all", "found"],
    ]);
  });

  it("marks the pressed mixed start as starting and not the same scope of an opening in it", async () => {
    renderFound({
      starting: { mode: "repertoire", motif: "due", repertoireId: 7, level: "found" },
    });
    const found = await foundSection(await whiteOpenings());
    expect(
      await within(found).findByRole("button", { name: `Starting, ${FOUND_START}` }),
    ).toBeTruthy();
    expect(within(found).getByRole("button", { name: "Everything due 6" })).toBeTruthy();
    expect(within(found).queryByRole("button", { name: "Starting" })).toBeNull();
  });

  it("shows only the openings to add, and no starts, while no unit was built from one", async () => {
    renderFound({
      repertoires: { status: "ready", value: repertoireList },
      fetchRepertoireList: async () =>
        foundListing({
          repertoires: repertoireList,
          found: NOTHING_TO_DRILL,
          met: [scandinavian, alekhine],
        }),
    });
    const white = await whiteOpenings();
    const found = await foundSection(white);
    expect(
      within(found)
        .getAllByRole("heading")
        .map((heading) => heading.textContent),
    ).toEqual(["Found in your games"]);
    expect(
      within(found)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Add", "Add"]);
    expect(within(found).queryByText("Every added opening, mixed")).toBeNull();
    expect(within(white).queryByRole("button", { name: new RegExp(FOUND_START) })).toBeNull();
  });

  it("offers no mixed starts before the server has counted them, and no section with nothing met", async () => {
    const read = vi.fn(async () => foundListing({ found: undefined }));
    renderFound({ fetchRepertoireList: read });
    const found = await foundSection(await whiteOpenings());
    expect(within(found).getByRole("heading", { name: "Scandinavian Defense" })).toBeTruthy();
    expect(within(found).queryByText("Every added opening, mixed")).toBeNull();
    cleanup();

    const none = vi.fn(async () => foundListing({ repertoires: repertoireList, met: [] }));
    renderFound({
      repertoires: { status: "ready", value: repertoireList },
      fetchRepertoireList: none,
    });
    const white = await whiteOpenings();
    await waitFor(() => expect(none).toHaveBeenCalled());
    await settle();
    expect(within(white).queryByRole("region", { name: "Found in your games" })).toBeNull();
    expect(within(white).queryByText("Found in your games")).toBeNull();
  });

  it("moves a root into the section with its menu when its run ends, ahead of the roots still to add", async () => {
    let finish: () => void = noop;
    const addOpening = vi.fn(
      (_root: readonly string[]) =>
        new Promise<AddedOpening>((resolve) => {
          finish = () => resolve({ truncated: false });
        }),
    );
    const reads = [
      foundListing({
        repertoires: repertoireList,
        found: NOTHING_TO_DRILL,
        met: [scandinavian, alekhine],
      }),
      foundListing({
        repertoires: [...repertoireList, scandinavianDrill],
        found: { moves: scandinavianDrill.moves },
        met: [{ ...scandinavian, repertoire_id: 7 }, alekhine],
      }),
    ];
    const fetchRepertoireList = vi.fn(async () => reads.shift() as RepertoiresResponse);
    renderFound({
      repertoires: { status: "ready", value: repertoireList },
      fetchRepertoireList,
      addOpening,
    });
    const white = await whiteOpenings();
    const found = await foundSection(white);
    fireEvent.click(
      await within(found).findByRole("button", { name: "Add Scandinavian Defense, 1.e4 d5" }),
    );
    expect(within(found).queryByRole("heading", { name: "Scandinavian Defense" })).toBeNull();

    await act(async () => finish());
    const menu = await within(found).findByRole("heading", { name: "Scandinavian Defense" });
    const toAdd = within(found).getByRole("list", { name: "Openings met in your games" });
    expect(within(toAdd).getAllByRole("listitem")).toHaveLength(1);
    expect(follows(menu, toAdd)).toBe(true);
    // One added opening is enough for the mixed starts, and they close the section.
    const starts = within(found).getByRole("button", { name: `Recommended 4, ${FOUND_START}` });
    expect(follows(toAdd, starts)).toBe(true);
    expect(within(found).getAllByRole("heading")).toHaveLength(2);
  });

  it("sends the found level with the start, from the first added opening", async () => {
    const server = api(null);
    render(
      <Practice
        server={server}
        {...hubProps}
        fetchRepertoires={async () => foundDrills}
        fetchRepertoireList={async () => foundListing()}
      />,
    );
    // The loading card is replaced once the list has loaded, so it is found by what the list holds.
    await screen.findByRole("heading", { name: "Scandinavian Defense" });
    const white = screen.getByRole("region", { name: "White openings" });
    fireEvent.click(
      await within(white).findByRole("button", { name: `Everything due 9, ${FOUND_START}` }),
    );
    expect(server.send).toHaveBeenCalledTimes(1);
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "repertoire",
      repertoire_id: 7,
      scope: "due",
      level: "found",
    });
  });
});

describe("the variation of the move in play", () => {
  const drillOf = (name: string, id: number, group?: string): TrainingActivity =>
    repertoireActivity({
      training: {
        item: {
          kind: "repertoire",
          repertoire_id: id,
          variation_name: name,
          ...(group === undefined ? {} : { group_name: group }),
          fen: START_FEN,
          position_in_queue: 1,
          queue_length: 3,
        },
      },
      drill: { repertoire_id: id, level: group === undefined ? "group" : "found" },
    });

  it("names the opening beside the variation, and follows both from one unit to the next", () => {
    const listed = async () => foundDrills;
    const view = render(
      <Practice
        server={api(drillOf(scandinavianDrill.variation_name, 7, "Scandinavian Defense"))}
        createBoard={spyBoard}
        fetchRepertoires={listed}
      />,
    );
    const line = screen.getByTestId("item-variation");
    expect(within(line).getByTestId("item-opening").textContent).toBe("Scandinavian Defense");
    expect(within(line).getByText("Mieses-Kotroc Variation (2.exd5)")).toBeTruthy();
    expect(line.textContent).toBe(
      "OpeningScandinavian DefenseVariationMieses-Kotroc Variation (2.exd5)",
    );

    view.rerender(
      <Practice
        server={api(drillOf(alekhineDrill.variation_name, 8, "Alekhine Defense"))}
        createBoard={spyBoard}
        fetchRepertoires={listed}
      />,
    );
    expect(
      within(screen.getByTestId("item-variation")).getByTestId("item-opening").textContent,
    ).toBe("Alekhine Defense");
    expect(
      within(screen.getByTestId("item-variation")).getByText("Modern Variation (2.e5)"),
    ).toBeTruthy();
  });

  it("names only the variation for an item that carries no opening", () => {
    render(
      <Practice
        server={api(drillOf(CLASSICAL_VARIATION, 3))}
        createBoard={spyBoard}
        fetchRepertoires={async () => levelDrills}
      />,
    );
    expect(screen.queryByTestId("item-opening")).toBeNull();
    expect(screen.getByTestId("item-variation").textContent).toBe(
      `Variation${CLASSICAL_VARIATION}`,
    );
  });

  it("names the variation whose move is asked, and follows it from move to move", () => {
    const listed = async () => levelDrills;
    const view = render(
      <Practice
        server={api(drillOf(CLASSICAL_VARIATION, 3))}
        createBoard={spyBoard}
        fetchRepertoires={listed}
      />,
    );
    expect(
      within(screen.getByTestId("item-variation")).getByText(CLASSICAL_VARIATION),
    ).toBeTruthy();
    view.rerender(
      <Practice
        server={api(drillOf(PIANISSIMO, 4))}
        createBoard={spyBoard}
        fetchRepertoires={listed}
      />,
    );
    expect(within(screen.getByTestId("item-variation")).getByText(PIANISSIMO)).toBeTruthy();
  });

  it("shows no variation line for an item that names none", () => {
    render(
      <Practice
        server={api(repertoireActivity())}
        createBoard={spyBoard}
        fetchRepertoires={async () => levelDrills}
      />,
    );
    expect(screen.queryByTestId("item-variation")).toBeNull();
  });
});

const drill = (
  opening: string,
  positions: number,
  attempts = 0,
  firstTry = 0,
  repertoireId: number | null = null,
): OpeningDrill => ({
  opening,
  positions,
  attempts_30d: attempts,
  first_try_30d: firstTry,
  repertoire_id: repertoireId,
});

const readyDrills = (value: OpeningDrillsResponse) => ({ status: "ready" as const, value });

// Italian Game has a menu, Scandinavian Defense was met in games and has none yet, and the rest have
// neither. The student also plays the Sicilian as Black, and each colour has positions with no name.
const gameDrills: OpeningDrillsResponse = {
  white: [
    drill("Italian Game", 12, 3, 2, 3),
    drill("Sicilian Defense", 9, 6, 4),
    drill("Scandinavian Defense", 4),
    drill(UNNAMED_OPENING, 5, 2, 1),
  ],
  black: [drill("Sicilian Defense", 8, 4, 1), drill(UNNAMED_OPENING, 2)],
};

const blackOpenings = (): Promise<HTMLElement> =>
  screen.findByRole("region", { name: "Black openings" });

function renderDrills(props: Partial<PracticeHubProps> = {}) {
  const onStartOpening = vi.fn();
  renderHub({
    openingDrills: readyDrills(gameDrills),
    onStartOpening,
    fetchRepertoireList: async () => listing([scandinavian]),
    ...props,
  });
  return onStartOpening;
}

const plainRows = async (white: HTMLElement, side = "White"): Promise<HTMLElement[]> =>
  within(
    await within(white).findByRole("list", { name: `Positions from your games as ${side}` }),
  ).getAllByRole("listitem");

describe("the opening drills from your games", () => {
  it("shows an opening once: in its menu, on its row of games met, or on a row of its own", async () => {
    renderDrills();
    const white = await whiteOpenings();
    const [sicilian, other] = (await plainRows(white)) as [HTMLElement, HTMLElement];

    // Italian Game has a menu, so its drill is a line there and no row of its own.
    const italian = within(white)
      .getByRole("heading", { name: "Italian Game" })
      .closest(".repertoire-menu__opening") as HTMLElement;
    expect(within(italian).getByText("Positions from your games (12)")).toBeTruthy();
    expect(within(italian).getByText("67% · 2 of 3")).toBeTruthy();
    expect(within(white).getAllByText("Italian Game")).toHaveLength(1);

    // Scandinavian Defense was met in games and has no menu: its drill joins that row.
    const met = within(white).getByRole("list", { name: "Openings met in your games" });
    const metRow = within(met).getByRole("listitem");
    expect(within(metRow).getByText("Scandinavian Defense")).toBeTruthy();
    expect(within(metRow).getByText("Positions from your games (4)")).toBeTruthy();
    expect(within(white).getAllByText("Scandinavian Defense")).toHaveLength(1);

    // The others have a row each, the unnamed positions last.
    expect(within(sicilian).getByText("Sicilian Defense")).toBeTruthy();
    expect(within(sicilian).getByText("9 positions")).toBeTruthy();
    expect(within(sicilian).getByText("67% · 4 of 6")).toBeTruthy();
    expect(within(other).getByText("Other positions")).toBeTruthy();
    expect(within(other).getByText("5 positions")).toBeTruthy();
    expect(within(other).getByText("50% · 1 of 2")).toBeTruthy();
    expect(within(white).getAllByText("Sicilian Defense")).toHaveLength(1);
    expect(await plainRows(white)).toHaveLength(2);
  });

  it("lists Black's families under a Black openings heading, apart from White's", async () => {
    renderDrills();
    const black = await blackOpenings();
    expect(within(black).getByRole("heading", { name: "Black openings" })).toBeTruthy();
    const [sicilian, other] = (await plainRows(black, "Black")) as [HTMLElement, HTMLElement];
    expect(within(sicilian).getByText("Sicilian Defense")).toBeTruthy();
    expect(within(sicilian).getByText("8 positions")).toBeTruthy();
    expect(within(sicilian).getByText("25% · 1 of 4")).toBeTruthy();
    expect(within(other).getByText("Other positions")).toBeTruthy();
    expect(within(other).getByText("2 positions")).toBeTruthy();
    // The Sicilian appears once in each colour, and Black has no menu to hold it.
    expect(within(black).getAllByText("Sicilian Defense")).toHaveLength(1);
    expect(within(black).queryByRole("heading", { name: "Italian Game" })).toBeNull();
  });

  it("shows a family with no attempt in the last 30 days with its positions and no rate", async () => {
    renderDrills();
    const white = await whiteOpenings();
    const black = await blackOpenings();
    const [, blackOther] = (await plainRows(black, "Black")) as [HTMLElement, HTMLElement];
    expect(within(blackOther).getByText("2 positions")).toBeTruthy();
    expect(blackOther.textContent).not.toContain("%");
    const metRow = within(
      within(white).getByRole("list", { name: "Openings met in your games" }),
    ).getByRole("listitem");
    const metLine = within(metRow).getByText("Positions from your games (4)").parentElement;
    expect(metLine?.textContent).not.toContain("%");
    expect(within(metRow).getByText("3 games")).toBeTruthy();
  });

  it("starts the drill of the family whose button is pressed", async () => {
    const onStartOpening = renderDrills();
    const white = await whiteOpenings();
    await plainRows(white);
    for (const name of [
      "Drill Italian Game as White",
      "Drill Scandinavian Defense as White",
      "Drill Sicilian Defense as White",
      "Drill other positions as White",
    ]) {
      fireEvent.click(within(white).getByRole("button", { name }));
    }
    const black = await blackOpenings();
    fireEvent.click(within(black).getByRole("button", { name: "Drill Sicilian Defense as Black" }));
    fireEvent.click(within(black).getByRole("button", { name: "Drill other positions as Black" }));
    expect(onStartOpening.mock.calls).toEqual([
      ["white", "Italian Game"],
      ["white", "Scandinavian Defense"],
      ["white", "Sicilian Defense"],
      ["white", UNNAMED_OPENING],
      ["black", "Sicilian Defense"],
      ["black", UNNAMED_OPENING],
    ]);
  });

  it("marks the drill that is starting and holds every other start until it has", async () => {
    renderDrills({ starting: { mode: "openings", motif: "white", opening: "Sicilian Defense" } });
    const white = await whiteOpenings();
    await plainRows(white);
    const mine = within(white).getByRole("button", { name: "Starting Sicilian Defense as White" });
    expect(mine.textContent).toBe("Starting");
    for (const button of within(white).getAllByRole("button", { name: /^Drill / })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    // The same family as Black is another drill, so it is not the one starting.
    const black = await blackOpenings();
    expect(
      within(black).getByRole("button", { name: "Drill Sicilian Defense as Black" }),
    ).toBeTruthy();
  });

  it("disables the starts while the engine is missing", async () => {
    renderDrills({ engineMissing: true });
    const white = await whiteOpenings();
    await plainRows(white);
    const buttons = [
      ...within(white).getAllByRole("button", { name: /^Drill / }),
      ...within(await blackOpenings()).getAllByRole("button", { name: /^Drill / }),
    ];
    // The Italian line, the Scandinavian row of games met and two rows of White, then two of Black.
    expect(buttons).toHaveLength(6);
    for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists the drills of the openings met in games as rows of their own while that list is unread", async () => {
    renderDrills({
      fetchRepertoireList: async (): Promise<RepertoiresResponse> => {
        throw new Error("down");
      },
    });
    const white = await whiteOpenings();
    const rows = await plainRows(white);
    // Nothing is met as far as the page knows, so Scandinavian Defense is a row like the others.
    expect(rows).toHaveLength(3);
    expect(within(white).getAllByText("Scandinavian Defense")).toHaveLength(1);
  });

  it("holds the rows back until the openings met in games have been read", async () => {
    let read: (value: RepertoiresResponse) => void = noop;
    renderDrills({
      fetchRepertoireList: () =>
        new Promise<RepertoiresResponse>((resolve) => {
          read = resolve;
        }),
    });
    const white = await whiteOpenings();
    await settle();
    expect(within(white).queryByRole("list", { name: /^Positions from your games/ })).toBeNull();
    expect(within(white).queryByText("Positions from your games (12)")).toBeNull();
    await act(async () => read(listing([scandinavian])));
    expect(await plainRows(white)).toHaveLength(2);
    expect(within(white).getByText("Positions from your games (12)")).toBeTruthy();
  });

  it("puts the drills of a colour with no stored opening in a card of their own", async () => {
    renderDrills({ repertoires: { status: "ready", value: [] } });
    const white = await whiteOpenings();
    expect(within(white).getByText(/No opening is stored yet/)).toBeTruthy();
    const rows = await plainRows(white);
    expect(rows).toHaveLength(4);
    expect(screen.getAllByRole("region", { name: "White openings" })).toHaveLength(1);
    expect(within(white).getAllByText("Italian Game")).toHaveLength(1);
  });

  it("lists no drill until they are read, and says so when they could not be", async () => {
    const fetchRepertoireList = async () => listing([]);
    renderHub({ openingDrills: { status: "loading" }, onStartOpening: noop, fetchRepertoireList });
    const white = await whiteOpenings();
    await settle();
    expect(within(white).queryByRole("list", { name: /^Positions from your games/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Black openings" })).toBeNull();
    cleanup();

    renderHub({ openingDrills: { status: "failed" }, onStartOpening: noop, fetchRepertoireList });
    const openings = await screen.findByRole("region", { name: "Openings" });
    expect(within(openings).getByRole("status").textContent).toBe(
      "The positions from your games could not be loaded. Reload the page to try again.",
    );
    expect(screen.queryByRole("region", { name: "Black openings" })).toBeNull();
  });

  it("offers the colours no row of the whole drill, only the families", async () => {
    renderDrills();
    await plainRows(await whiteOpenings());
    expect(screen.queryByRole("button", { name: /^Drill as / })).toBeNull();
    expect(screen.queryByText("Common positions")).toBeNull();
  });
});

describe("starting an opening drill from the screen", () => {
  const readDrills = async () => gameDrills;

  it("sends the colour, the family and the drill size", async () => {
    const server = api(null);
    render(
      <Practice
        server={server}
        {...hubProps}
        fetchRepertoires={async () => repertoireList}
        fetchRepertoireList={async () => listing([scandinavian])}
        fetchOpeningDrills={readDrills}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "20" }));
    // The loading card is replaced once the list has loaded, so the menu is found by what it holds.
    await screen.findByRole("heading", { name: "Italian Game" });
    const white = screen.getByRole("region", { name: "White openings" });
    await plainRows(white);
    fireEvent.click(within(white).getByRole("button", { name: "Drill Sicilian Defense as White" }));
    expect(server.send).toHaveBeenLastCalledWith({
      type: "start_training",
      mode: "openings",
      color: "white",
      opening: "Sicilian Defense",
      size: 20,
    });
  });

  it("sends the unnamed entry of a colour as UNNAMED_OPENING, at the default size", async () => {
    const server = api(null);
    render(
      <Practice
        server={server}
        {...hubProps}
        fetchRepertoires={async () => repertoireList}
        fetchRepertoireList={async () => listing([scandinavian])}
        fetchOpeningDrills={readDrills}
      />,
    );
    await screen.findByRole("heading", { name: "Italian Game" });
    fireEvent.click(
      within(await blackOpenings()).getByRole("button", { name: "Drill other positions as Black" }),
    );
    expect(server.send).toHaveBeenCalledTimes(1);
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "openings",
      color: "black",
      opening: UNNAMED_OPENING,
      size: 10,
    });
  });

  it("tells the student to reload when the opening is no longer in the drill", async () => {
    const server = api(null);
    const props = {
      ...hubProps,
      fetchRepertoires: async () => repertoireList,
      fetchRepertoireList: async () => listing([scandinavian]),
      fetchOpeningDrills: readDrills,
    };
    const view = render(<Practice server={server} {...props} />);
    // The loading card is replaced once the list has loaded, so the menu is found by what it holds.
    await screen.findByRole("heading", { name: "Italian Game" });
    const white = screen.getByRole("region", { name: "White openings" });
    await plainRows(white);
    fireEvent.click(within(white).getByRole("button", { name: "Drill Sicilian Defense as White" }));
    expect(
      within(white).getByRole("button", { name: "Starting Sicilian Defense as White" }),
    ).toBeTruthy();

    const refused: ServerApi = {
      ...server,
      errorCount: 1,
      lastErrorCode: "unknown_opening",
      lastError: "no white opening drill is named Sicilian Defense",
    };
    view.rerender(<Practice server={refused} {...props} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "That opening has no positions to drill any more. Reload the page to see the current list.",
    );
    expect(
      within(await whiteOpenings()).getByRole("button", {
        name: "Drill Sicilian Defense as White",
      }),
    ).toBeTruthy();
  });
});
