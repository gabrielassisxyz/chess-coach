import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ActivityState,
  type DemoActivity,
  type MetOpening,
  type OpeningDrill,
  type OpeningDrillsResponse,
  type PuzzleRatingHistoryResponse,
  type RepertoireSummary,
  type RepertoiresResponse,
  type ThemeStatsResponse,
  type TrainingActivity,
  UNNAMED_OPENING,
} from "@chess-coach/shared";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BoardFactory, MOVE_PAUSE_MS } from "../src/components/Board.js";
import { PracticeHub, type PracticeHubProps } from "../src/components/PracticeHub.js";
import { type ServerApi, useServer } from "../src/hooks/useServer.js";
import { Practice } from "../src/screens/Practice.js";
import { formatInterval, NONE, nextBatchParts, trainingView } from "../src/state/practice.js";
import { PRACTICE_PAGE_STORAGE_KEY } from "../src/state/practice-page.js";
import {
  fetchPuzzleRatingHistoryFromServer,
  ratingSparklinePoints,
} from "../src/state/puzzle-rating-api.js";
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
  openPracticePage,
  progressOf,
  repertoireActivity,
  repertoireList,
} from "./practice-fixtures.js";

afterEach(cleanup);
// The hub stores the page it shows, which would open the next test's hub on it.
afterEach(() => {
  window.localStorage.removeItem(PRACTICE_PAGE_STORAGE_KEY);
  vi.unstubAllGlobals();
});

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

const ratingHistoryOf = (
  ratings: readonly number[] = [1408, 1412, 1410, 1418, 1422, 1428, 1432],
  change = (ratings.at(-1) ?? 0) - (ratings[0] ?? 0),
): PuzzleRatingHistoryResponse => ({
  current: ratings.at(-1) ?? 1200,
  points: ratings.map((rating, index) => ({
    day: `2026-02-${String(23 + index).padStart(2, "0")}`,
    rating,
  })),
  low: Math.min(...ratings),
  high: Math.max(...ratings),
  change,
});

const overviewThemeStatsOf = (
  overall: { played: number; first_try: number } = { played: 64, first_try: 41 },
  overallPrevious: { played: number; first_try: number } | null = { played: 50, first_try: 30 },
): ThemeStatsResponse => ({
  days: "30",
  overall: { ...overall, rating_avg: 1410, performance: 1420 },
  overall_previous: overallPrevious
    ? { ...overallPrevious, rating_avg: 1385, performance: 1390 }
    : null,
  themes: [],
  improvement_areas: [],
  strengths: [],
  unranked: 0,
});

const hubProps = {
  fetchProgress: async () => progressOf(),
  fetchMotifs: async () => motifCounts,
  fetchRepertoires: async () => [],
  fetchRepertoireList: async () => ({ repertoires: [], met: [] }),
  fetchOpeningDrills: async () => ({ white: [], black: [] }),
  fetchRatingHistory: async () => ratingHistoryOf(),
  fetchThemeStats: async () => overviewThemeStatsOf(),
};

const practiceNav = (): HTMLElement =>
  screen.getByRole("navigation", { name: "Practice sections" });

describe("the hub", () => {
  it("shows the due numbers and 7-day forecast from the progress summary", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-01T12:00:00") });
    try {
      render(<Practice server={api(null)} {...hubProps} />);
      const due = await screen.findByRole("region", { name: "Due cards" });
      expect(await within(due).findByText("4", { selector: "strong" })).toBeTruthy();
      expect(due.textContent).toContain("due now · from 3 games");
      expect(within(due).getByText("Blunders").nextSibling?.textContent).toBe("2");
      expect(within(due).getByText("Mistakes").nextSibling?.textContent).toBe("1");
      expect(within(due).getByText("Teaching").nextSibling?.textContent).toBe("1");
      expect(within(due).queryByText("Inaccuracies")).toBeNull();
      expect(within(due).getByText("Next batch 3").nextSibling?.textContent).toMatch(
        /^(today|tomorrow|[A-Z][a-z]{2}) \d\d:\d\d$/,
      );
      // The share remembered moved to its tile, so the card no longer repeats it.
      expect(within(due).queryByText("Remembered, 30 days")).toBeNull();
      expect(due.textContent).not.toContain("83%");
      expect(within(due).getByRole("button", { name: "Review 4 cards" })).toBeTruthy();

      expect(within(due).getByText("Coming up · next 7 days")).toBeTruthy();
      const columns = [...due.querySelectorAll(".practice-forecast__day")] as HTMLElement[];
      expect(columns.length).toBe(7);
      expect(columns.map((c) => c.querySelector(".practice-forecast__count")?.textContent)).toEqual(
        ["4", "1", "0", "2", "0", "0", "0"],
      );
      expect(columns.map((c) => c.querySelector(".practice-forecast__label")?.textContent)).toEqual(
        ["Today", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      );
      expect(
        columns.map(
          (c) => (c.querySelector(".practice-forecast__bar") as HTMLElement).style.height,
        ),
      ).toEqual(["40px", "10px", "2px", "20px", "2px", "2px", "2px"]);
      expect(columns.map((c) => c.getAttribute("data-today"))).toEqual([
        "true",
        "false",
        "false",
        "false",
        "false",
        "false",
        "false",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws 2 px bars for the 7-day forecast when every day is zero", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-04T12:00:00") });
    try {
      render(
        <Practice
          server={api(null)}
          {...hubProps}
          fetchProgress={async () => progressOf({ due_now: 0, due_next_7d: [0, 0, 0, 0, 0, 0, 0] })}
        />,
      );
      const due = await screen.findByRole("region", { name: "Due cards" });
      await within(due).findByText("Coming up · next 7 days");
      const columns = [...due.querySelectorAll(".practice-forecast__day")] as HTMLElement[];
      expect(columns.map((c) => c.querySelector(".practice-forecast__label")?.textContent)).toEqual(
        ["Today", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"],
      );
      expect(
        columns.map(
          (c) => (c.querySelector(".practice-forecast__bar") as HTMLElement).style.height,
        ),
      ).toEqual(["2px", "2px", "2px", "2px", "2px", "2px", "2px"]);
    } finally {
      vi.useRealTimers();
    }
  });

  const tileElementOf = (label: string): HTMLElement =>
    screen.getByText(label, { selector: "dt" }).closest(".practice-tile") as HTMLElement;

  // The value beside each tile's label, and the line under it where the tile has one.
  const tileOf = (label: string): string[] => {
    const term = screen.getByText(label, { selector: "dt" });
    const values = [];
    for (let node = term.nextElementSibling; node; node = node.nextElementSibling) {
      values.push(node.textContent ?? "");
    }
    return values;
  };

  it("shows all four overview tiles with streak bars, rating change, solved first try and cards remembered", async () => {
    const progress = progressOf({ correct_rate_30d: 0.836, correct_rate_7d: 0.5, total: 38 }, 1432);
    const history = ratingHistoryOf([1408, 1412, 1410, 1418, 1422, 1428, 1432], 24);
    render(
      <Practice
        server={api(null)}
        {...hubProps}
        fetchProgress={async () => progress}
        fetchRatingHistory={async () => history}
      />,
    );
    const streak = await screen.findByText("Day streak");
    const tiles = streak.closest("dl") as HTMLElement;
    expect([...tiles.children].map((tile) => tile.querySelector("dt")?.textContent)).toEqual([
      "Day streak",
      "Puzzle rating",
      "Solved first try",
      "Cards remembered",
    ]);

    await within(tileElementOf("Puzzle rating")).findByText("7 days");
    await within(tileElementOf("Solved first try")).findByText("30 days");

    expect(tileOf("Day streak")).toEqual(["2 days · best 11", ""]);
    const streakBars = [
      ...within(tileElementOf("Day streak")).getByLabelText("Last 7 days").children,
    ] as HTMLElement[];
    expect(streakBars.map((bar) => bar.getAttribute("data-active"))).toEqual([
      "false",
      "false",
      "false",
      "false",
      "false",
      "true",
      "true",
    ]);
    expect(streakBars.map((bar) => bar.getAttribute("data-today"))).toEqual([
      "false",
      "false",
      "false",
      "false",
      "false",
      "false",
      "true",
    ]);

    expect(tileOf("Puzzle rating")).toEqual(["1432 ▲ 24 7 days", ""]);
    expect(
      tileElementOf("Puzzle rating")
        .querySelector(".practice-tile__delta")
        ?.getAttribute("data-direction"),
    ).toBe("up");
    const polyline = tileElementOf("Puzzle rating").querySelector("polyline");
    expect(polyline?.getAttribute("points")).toBe(
      "0.0,25.0 33.3,21.3 66.7,23.2 100.0,15.8 133.3,12.2 166.7,6.7 200.0,3.0",
    );
    expect(ratingSparklinePoints([{ day: "2026-02-23", rating: 1400 }])).toBeNull();

    expect(tileOf("Solved first try")).toEqual(["64% ▲ 4 30 days", ""]);
    expect(
      tileElementOf("Solved first try")
        .querySelector(".practice-tile__delta")
        ?.getAttribute("data-direction"),
    ).toBe("up");
    const solvedFill = tileElementOf("Solved first try").querySelector(
      ".practice-tile__split-solved",
    ) as HTMLElement;
    expect(solvedFill.style.width).toBe("64%");

    expect(tileOf("Cards remembered")).toEqual(["84% ▲ 9 30 days", "38 cards in rotation"]);
    expect(
      tileElementOf("Cards remembered")
        .querySelector(".practice-tile__delta")
        ?.getAttribute("data-direction"),
    ).toBe("up");
  });

  it("shows downward deltas in red for rating, solved first try and cards remembered", async () => {
    const progress = progressOf({
      correct_rate_30d: 0.7,
      correct_rate_prev_30d: 0.75,
      total: 12,
    });
    render(
      <Practice
        server={api(null)}
        {...hubProps}
        fetchProgress={async () => progress}
        fetchRatingHistory={async () =>
          ratingHistoryOf([1500, 1495, 1490, 1488, 1485, 1484, 1482], -18)
        }
        fetchThemeStats={async () =>
          overviewThemeStatsOf({ played: 60, first_try: 30 }, { played: 60, first_try: 33 })
        }
      />,
    );

    await screen.findByText("Puzzle rating");
    await within(tileElementOf("Puzzle rating")).findByText("▼ 18");
    expect(
      tileElementOf("Puzzle rating")
        .querySelector(".practice-tile__delta")
        ?.getAttribute("data-direction"),
    ).toBe("down");

    await within(tileElementOf("Solved first try")).findByText("▼ 5");
    expect(
      tileElementOf("Solved first try")
        .querySelector(".practice-tile__delta")
        ?.getAttribute("data-direction"),
    ).toBe("down");

    expect(tileOf("Cards remembered")).toEqual(["70% ▼ 5 30 days", "12 cards in rotation"]);
    expect(
      tileElementOf("Cards remembered")
        .querySelector(".practice-tile__delta")
        ?.getAttribute("data-direction"),
    ).toBe("down");
  });

  it("draws no arrow when delta is zero or the earlier window has no data, and shows singular units", async () => {
    const progress = {
      ...progressOf({ correct_rate_30d: null, correct_rate_prev_30d: null, total: 1 }),
      streak_days: 1,
      streak_best: 1,
      activity_7d: [false, false, false, false, false, true, false],
    };
    const view = render(
      <Practice
        server={api(null)}
        {...hubProps}
        fetchProgress={async () => progress}
        fetchRatingHistory={async () =>
          ratingHistoryOf([1400, 1400, 1400, 1400, 1400, 1400, 1400], 0)
        }
        fetchThemeStats={async () => overviewThemeStatsOf({ played: 10, first_try: 6 }, null)}
      />,
    );
    await screen.findByText("Puzzle rating");
    await within(tileElementOf("Puzzle rating")).findByText("7 days");
    await within(tileElementOf("Solved first try")).findByText("30 days");

    expect(tileOf("Day streak")).toEqual(["1 day · best 1", ""]);
    const bars = [
      ...within(tileElementOf("Day streak")).getByLabelText("Last 7 days").children,
    ] as HTMLElement[];
    expect(bars.at(-1)?.getAttribute("data-active")).toBe("false");
    expect(bars.at(-1)?.getAttribute("data-today")).toBe("true");
    expect(tileOf("Puzzle rating")).toEqual(["1200 7 days", ""]);
    expect(tileElementOf("Puzzle rating").querySelector(".practice-tile__delta")).toBeNull();
    expect(tileOf("Solved first try")).toEqual(["60% 30 days", ""]);
    expect(tileElementOf("Solved first try").querySelector(".practice-tile__delta")).toBeNull();
    expect(tileOf("Cards remembered")).toEqual([NONE, "1 card in rotation"]);
    expect(tileElementOf("Cards remembered").querySelector(".practice-tile__delta")).toBeNull();
    view.unmount();

    const emptyStats = vi.fn(async () =>
      overviewThemeStatsOf({ played: 0, first_try: 0 }, { played: 0, first_try: 0 }),
    );
    const secondView = render(
      <Practice
        server={api(null)}
        {...hubProps}
        fetchProgress={async () =>
          progressOf({ correct_rate_30d: 0.8, correct_rate_prev_30d: null, total: 10 })
        }
        fetchThemeStats={emptyStats}
      />,
    );
    await screen.findByText("Solved first try");
    await waitFor(() => expect(emptyStats).toHaveBeenCalled());
    expect(tileOf("Solved first try")).toEqual([NONE]);
    expect(tileElementOf("Solved first try").querySelector(".practice-tile__split")).toBeNull();
    expect(tileOf("Cards remembered")).toEqual(["80% 30 days", "10 cards in rotation"]);
    expect(tileElementOf("Cards remembered").querySelector(".practice-tile__delta")).toBeNull();
    secondView.unmount();

    render(
      <Practice
        server={api(null)}
        {...hubProps}
        fetchProgress={async () =>
          progressOf({ correct_rate_30d: 0.8, correct_rate_prev_30d: 0.8, total: 10 })
        }
        fetchThemeStats={async () =>
          overviewThemeStatsOf({ played: 10, first_try: 6 }, { played: 10, first_try: 6 })
        }
      />,
    );
    await screen.findByText("Solved first try");
    await within(tileElementOf("Solved first try")).findByText("60%");
    expect(tileElementOf("Solved first try").querySelector(".practice-tile__delta")).toBeNull();
    expect(tileOf("Cards remembered")).toEqual(["80% 30 days", "10 cards in rotation"]);
    expect(tileElementOf("Cards remembered").querySelector(".practice-tile__delta")).toBeNull();
  });

  it("keeps the numbers it has when rating history or theme statistics fail, without showing an alert", async () => {
    const progress = progressOf({ correct_rate_30d: 0.836, total: 38 }, 1432);
    render(
      <Practice
        server={api(null)}
        {...hubProps}
        fetchProgress={async () => progress}
        fetchRatingHistory={async () => {
          throw new Error("rating down");
        }}
        fetchThemeStats={async () => {
          throw new Error("stats down");
        }}
      />,
    );

    await screen.findByText("Puzzle rating");
    await waitFor(() => {
      expect(tileOf("Puzzle rating")).toEqual(["1432"]);
    });
    expect(tileElementOf("Puzzle rating").querySelector(".practice-tile__delta")).toBeNull();
    expect(tileElementOf("Puzzle rating").querySelector("svg")).toBeNull();
    expect(tileOf("Solved first try")).toEqual([NONE]);
    expect(tileElementOf("Solved first try").querySelector(".practice-tile__split")).toBeNull();
    expect(tileElementOf("Solved first try").querySelector(".practice-tile__delta")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("fetches /api/puzzles/rating/history for the chosen window, parses the schema and rejects errors", async () => {
    const payload = ratingHistoryOf();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => payload })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ bad: true }) })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPuzzleRatingHistoryFromServer("7")).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/puzzles/rating/history?days=7");
    await expect(fetchPuzzleRatingHistoryFromServer("30")).rejects.toThrow();
    await expect(fetchPuzzleRatingHistoryFromServer("90")).rejects.toThrow(
      "puzzle rating history: 503",
    );
  });

  it("draws no tile while the numbers load or after they failed, and the Due cards card says so", async () => {
    const view = render(
      <Practice server={api(null)} {...hubProps} fetchProgress={() => new Promise(() => {})} />,
    );
    const loading = await screen.findByRole("region", { name: "Due cards" });
    expect(within(loading).getByRole("status").textContent).toBe("Loading your cards.");
    expect(screen.queryByText("Day streak")).toBeNull();
    expect(screen.queryByText("Cards remembered")).toBeNull();
    view.unmount();

    render(
      <Practice
        server={api(null)}
        {...hubProps}
        fetchProgress={async () => {
          throw new Error("down");
        }}
      />,
    );
    const failed = await screen.findByRole("region", { name: "Due cards" });
    expect((await within(failed).findByRole("alert")).textContent).toBe(
      "Your card numbers could not be loaded.",
    );
    expect(screen.queryByText("Day streak")).toBeNull();
    expect(screen.queryByText("Puzzle rating")).toBeNull();
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

  it("starts the chosen motif with no size to choose or to send", async () => {
    const server = api(null);
    render(<Practice server={server} {...hubProps} />);
    await screen.findByRole("radio", { name: /fork/i });
    expect(screen.queryByRole("group", { name: "Drill size" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /fork/i }));
    fireEvent.click(screen.getByRole("button", { name: "Start Fork" }));
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "puzzles",
      motif: "fork",
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
    openPracticePage("Openings");
    const card = await screen.findByRole("region", { name: "Openings" });
    expect(within(card).getByText("Italian Opening")).toBeTruthy();
    await within(card).findByText("7 positions");
    fireEvent.click(within(card).getByRole("button", { name: "Drill" }));
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "puzzles",
      motif: "opening-italian",
    });
  });

  it("disables the Italian drill at 0 with the generate hint", async () => {
    render(<Practice server={api(null)} {...hubProps} />);
    openPracticePage("Openings");
    const card = await screen.findByRole("region", { name: "Openings" });
    const drill = within(card).getByRole("button", { name: "Drill" }) as HTMLButtonElement;
    expect(drill.disabled).toBe(true);
    expect(within(card).getByText("Generate the Italian drill first")).toBeTruthy();
  });

  it("starts the due-card review with no size", async () => {
    const server = api(null);
    render(<Practice server={server} {...hubProps} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review 4 cards" }));
    expect(server.send).toHaveBeenCalledWith({ type: "start_training", mode: "srs" });
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
    const before = fetchHealth.mock.calls.length;
    fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchHealth.mock.calls.length).toBeGreaterThan(before));
    openPracticePage("Openings");
    const openings = await screen.findByRole("region", { name: "Openings" });
    expect(
      (within(openings).getByRole("button", { name: "Drill" }) as HTMLButtonElement).disabled,
    ).toBe(true);
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

  // A card born from a puzzle of several moves: after a right move the server plays the reply and
  // the card stays open at the next step. Built in a function, since the positions it names are
  // declared further down this file.
  const repliedCard = (): TrainingActivity =>
    card({
      status: "in_progress",
      fen: AFTER_E5,
      last_move: { from: "e7", to: "e5" },
      legal_moves: legalMovesOf(AFTER_E5),
      exploring: { fen: AFTER_E5, line_san: [], trail: [] },
      last_try: { uci: "e2e4", san: "e4", correct: true },
      moves: playedE4E5,
    });

  it("shows the reply on the board after a right move and keeps the card open at its heading", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      boards.length = 0;
      const { rerender } = render(
        <Practice server={api(card())} createBoard={spyBoard} fetchMotifs={noMotifs} />,
      );
      dropOnPracticeBoard("e2", "e4");
      rerender(
        <Practice server={api(repliedCard())} createBoard={spyBoard} fetchMotifs={noMotifs} />,
      );
      expect(boards.at(-1)?.fen).toBe(AFTER_E4);
      act(() => {
        vi.advanceTimersByTime(MOVE_PAUSE_MS);
      });
      expect(boards.at(-1)).toEqual({ movableColor: "white", fen: AFTER_E5, hint: {} });
      expect(screen.getByRole("heading", { name: "Card 1 of 3" })).toBeTruthy();
      expect(screen.getByRole("status").textContent).toBe("Best move");
      expect(screen.getByRole("list", { name: "Moves" }).textContent).toMatch(/e4.*e5/);
      expect(screen.getByRole("button", { name: "View solution" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers the rating and Continue only after the last move of the line", () => {
    const { rerender } = render(
      <Practice server={api(repliedCard())} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    expect(screen.queryByRole("group", { name: "Rate your recall" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue training" })).toBeNull();
    const solved = card({
      status: "solved",
      fen: AFTER_NF3,
      turn: "black",
      input_enabled: false,
      legal_moves: [],
      last_move: { from: "g1", to: "f3" },
      exploring: { fen: AFTER_NF3, line_san: [], trail: [] },
      last_try: { uci: "g1f3", san: "Nf3", correct: true },
      moves: [...playedE4E5, { ply: 2, uci: "g1f3", san: "Nf3", by: "student" }],
      suggested_quality: 4,
    });
    rerender(<Practice server={api(solved)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("heading", { name: "Card 1 of 3" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Rate your recall" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Solved");
    expect(document.querySelector(".state-card")?.textContent).toContain("2 moves");
  });
});

describe("a puzzle on the board", () => {
  it("never offers a rating, before or after the answer", () => {
    for (const status of ["prompt", "in_progress", "solved", "failed"] as const) {
      const { unmount } = render(
        <Practice server={api(puzzle({ status }))} createBoard={spyBoard} fetchMotifs={noMotifs} />,
      );
      expect(screen.getByRole("heading", { name: "Puzzle 2" })).toBeTruthy();
      expect(screen.queryByRole("group", { name: "Rate your recall" })).toBeNull();
      unmount();
    }
  });

  it("heads an item of a queue with a length with its total", () => {
    const fixed = puzzle();
    if (fixed.item.kind === "puzzle") fixed.item.queue_length = 10;
    render(<Practice server={api(fixed)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("heading", { name: "Puzzle 2 of 10" })).toBeTruthy();
  });

  it("hides the motif for an Any-motif run while open and names it after the item ends", () => {
    const open = puzzle({ status: "prompt" });
    const { unmount } = render(
      <Practice server={api(open)} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    const heading = screen.getByRole("heading", { name: "Puzzle 2" });
    expect(heading.textContent).not.toContain("fork");
    expect(heading.textContent).not.toContain("Fork");
    expect(screen.queryByText("Fork")).toBeNull();
    unmount();
    const ended = puzzle({ status: "solved" });
    render(<Practice server={api(ended)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("heading", { name: "Puzzle 2" })).toBeTruthy();
    expect(screen.getByText("Fork")).toBeTruthy();
  });

  it("keeps the motif in the heading for a single-motif run", () => {
    const open = puzzle({ status: "prompt", run_motif: "fork" });
    const { unmount } = render(
      <Practice server={api(open)} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    expect(screen.getByRole("heading", { name: "Puzzle 2" })).toBeTruthy();
    expect(screen.getByText("Fork")).toBeTruthy();
    unmount();
    const ended = puzzle({ status: "solved", run_motif: "fork" });
    render(<Practice server={api(ended)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
    expect(screen.getByRole("heading", { name: "Puzzle 2" })).toBeTruthy();
    expect(screen.getAllByText("Fork")).toHaveLength(1);
  });

  it("reads Italian Opening for an italian drill", () => {
    const open = puzzle({ status: "prompt", run_motif: "opening-italian" });
    const { unmount } = render(
      <Practice server={api(open)} createBoard={spyBoard} fetchMotifs={noMotifs} />,
    );
    expect(screen.getByRole("heading", { name: "Puzzle 2" })).toBeTruthy();
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
    if (last.item.kind === "puzzle") {
      last.item.position_in_queue = 10;
      last.item.queue_length = 10;
    }
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

  it("never offers Finish training on a queue without a length, at any position", () => {
    for (const position of [10, 11, 25]) {
      const answered = puzzle({ status: "solved" });
      if (answered.item.kind === "puzzle") answered.item.position_in_queue = position;
      const server = api(answered);
      const { unmount } = render(
        <Practice server={server} fetchMotifs={noMotifs} createBoard={spyBoard} />,
      );
      expect(screen.queryByRole("button", { name: "Finish training" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Continue training" }));
      expect(server.send).toHaveBeenCalledWith({ type: "next_training_item", activity_id: 4 });
      unmount();
    }
  });

  it("draws one segment per item served, none pending, and names the place without a total", () => {
    const served = puzzle({ queue_outcomes: ["solved", "failed", "current"] });
    if (served.item.kind === "puzzle") served.item.position_in_queue = 3;
    render(<Practice server={api(served)} fetchMotifs={noMotifs} createBoard={spyBoard} />);
    const bar = screen.getByRole("list", { name: "Session progress: 1 solved, 1 missed, item 3" });
    const outcomes = within(bar)
      .getAllByRole("listitem")
      .map((segment) => segment.getAttribute("data-outcome"));
    expect(outcomes).toEqual(["solved", "failed", "current"]);
  });

  it("keeps a segment pending, and the total in words, on a queue with a length", () => {
    const fixed = puzzle({ queue_outcomes: ["solved", "current", "pending"] });
    if (fixed.item.kind === "puzzle") fixed.item.queue_length = 3;
    render(<Practice server={api(fixed)} fetchMotifs={noMotifs} createBoard={spyBoard} />);
    const bar = screen.getByRole("list", {
      name: "Session progress: 1 solved, 0 missed, item 2 of 3",
    });
    expect(within(bar).getAllByRole("listitem")).toHaveLength(3);
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

  it("says Not that move after a wrong try and puts the piece back on the served square after the pause", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      boards.length = 0;
      const { rerender } = render(
        <Practice server={api(puzzle())} createBoard={spyBoard} fetchMotifs={noMotifs} />,
      );
      expect(screen.getByRole("status").textContent).toBe("Your move");
      const before = boards.length;
      const missed = puzzle({ tries: 1, last_try: { uci: "e2e4", san: "e4", correct: false } });
      rerender(<Practice server={api(missed)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
      expect(screen.getByRole("status").textContent).toBe("Not that move");
      act(() => {
        vi.advanceTimersByTime(MOVE_PAUSE_MS);
      });
      expect(boards.length).toBeGreaterThan(before);
      expect(boards.at(-1)).toEqual({ movableColor: "white", fen: START_FEN, hint: {} });
    } finally {
      vi.useRealTimers();
    }
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

const listedRepertoires = async () => repertoireList;

// The page as the browser builds it: a socket, the bootstrap frame, and the screen on top.
function Connected() {
  const server = useServer({ url: "ws://test/api/ws", createSocket: createFakeSocket });
  return <Practice server={server} {...hubProps} fetchRepertoires={listedRepertoires} />;
}

// The hub starts a session with the one command of its button and nothing else.
describe("starting a session from the hub", () => {
  function bootIntoHub() {
    FakeSocket.reset();
    render(<Connected />);
    act(() => FakeSocket.latest.open());
    act(() =>
      FakeSocket.latest.receive({
        type: "bootstrap",
        conversations: { play: [], games: [], practice: [] },
        activity: null,
      }),
    );
    return FakeSocket.latest;
  }

  // Waits for every part of the hub that decides a button's state, on the page each part is on.
  async function hubReady(): Promise<void> {
    await screen.findByRole("button", { name: "Review 4 cards" });
    openPracticePage("Openings");
    await screen.findByRole("heading", { name: "Italian Game" });
    await screen.findByText("Generate the Italian drill first");
  }

  it.each([
    ["Review 4 cards", "Overview", { type: "start_training", mode: "srs" }],
    ["Start any motif", "Overview", { type: "start_training", mode: "puzzles" }],
    [
      "Recommended 10",
      "Openings",
      { type: "start_training", mode: "repertoire", repertoire_id: 3, scope: "recommended" },
    ],
  ])("sends the start of %s and nothing else", async (name, page, command) => {
    const socket = bootIntoHub();
    await hubReady();
    openPracticePage(page);
    fireEvent.click(screen.getByRole("button", { name }));
    // The socket stamps each frame with a command id of its own.
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject(command);
    expect(socket.sent[0]).not.toHaveProperty("size");
  });
});

describe("finishing a queue", () => {
  const ended = () => puzzle({ status: "solved", summary: { solved: 5, failed: 0 } });

  function lastItemServer(): ServerApi {
    const last = puzzle({ status: "solved" });
    if (last.item.kind === "puzzle") {
      last.item.position_in_queue = 5;
      last.item.queue_length = 5;
    }
    return api(last);
  }

  it("sends end_training once after the summary and lands on the hub with no last-session line", () => {
    const server = lastItemServer();
    const { rerender } = render(<Practice server={server} {...hubProps} createBoard={spyBoard} />);
    fireEvent.click(screen.getByRole("button", { name: "Finish training" }));
    expect(server.send).toHaveBeenCalledWith({ type: "next_training_item", activity_id: 4 });

    const finished = api(ended());
    rerender(<Practice server={finished} {...hubProps} createBoard={spyBoard} />);
    // The same ended item arriving again must not end the run a second time.
    rerender(
      <Practice server={{ ...finished, activity: ended() }} {...hubProps} createBoard={spyBoard} />,
    );
    expect(finished.send).toHaveBeenCalledTimes(1);
    expect(finished.send).toHaveBeenCalledWith({ type: "end_training", activity_id: 4 });

    rerender(<Practice server={api(null)} {...hubProps} createBoard={spyBoard} />);
    expect(screen.queryByTestId("summary")).toBeNull();
    expect(screen.queryByTestId("last-session")).toBeNull();
    expect(screen.queryByText(/Last session/)).toBeNull();
    expect(screen.getByRole("region", { name: "Due cards" })).toBeTruthy();
  });

  it("neither reads nor writes a tally of the queue in the browser", () => {
    const touched: string[] = [];
    const reads = vi.spyOn(Storage.prototype, "getItem");
    const writes = vi.spyOn(Storage.prototype, "setItem");
    try {
      const { rerender } = render(
        <Practice server={lastItemServer()} {...hubProps} createBoard={spyBoard} />,
      );
      rerender(<Practice server={api(ended())} {...hubProps} createBoard={spyBoard} />);
      rerender(<Practice server={api(null)} {...hubProps} createBoard={spyBoard} />);
      touched.push(
        ...reads.mock.calls.map(([key]) => key),
        ...writes.mock.calls.map(([key]) => key),
      );
    } finally {
      reads.mockRestore();
      writes.mockRestore();
    }
    expect(touched.filter((key) => key.includes("last-session"))).toEqual([]);
  });
});

// What the student decided the hub does without stays out of the web's sources, so a screen
// cannot bring it back unseen.
describe("what the hub no longer carries", () => {
  const sourceDir = join(import.meta.dirname, "../src");
  const sourceFiles = readdirSync(sourceDir, { recursive: true, encoding: "utf8" }).filter((file) =>
    /\.(tsx?|css)$/.test(file),
  );

  it.each([
    ["the commands that resume or discard a paused run", /(resume|discard)_training/],
    ["the stored tally of the last session", /last-?session/i],
    ["the card that offered a paused run", /resumeLabelOf|ResumeCard|resume-actions/],
    ["the three-column grid the hub was before its pages", /practice__(hub|chooser)\b/],
    ["the choice of a drill size", /DRILL_SIZES|DrillSize|practice__sizes?\b|Drill size/],
  ])("leaves %s out of every source file", (_what, pattern) => {
    const offenders = sourceFiles.filter((file) =>
      pattern.test(readFileSync(join(sourceDir, file), "utf8")),
    );
    expect(offenders).toEqual([]);
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

  it("ends a session of a queue without a length the same way", () => {
    const server = api(puzzle());
    render(<Practice server={server} fetchMotifs={noMotifs} createBoard={spyBoard} />);
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

const AFTER_NF3 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2";

describe("what the board shows at once, with no pause", () => {
  const stepButton = (name: string): HTMLButtonElement =>
    screen.getByRole("button", { name }) as HTMLButtonElement;
  const repliedE5 = () => puzzleAfterE5({ last_try: { uci: "e2e4", san: "e4", correct: true } });

  // Each case renders `from`, hands the board `drop`, publishes `to`, and expects no set() after.
  function settlesAtOnce(from: TrainingActivity, drop: [string, string], to: TrainingActivity) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      boards.length = 0;
      const { rerender } = render(
        <Practice server={api(from)} createBoard={spyBoard} fetchMotifs={noMotifs} />,
      );
      dropOnPracticeBoard(...drop);
      rerender(<Practice server={api(to)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
      const shown = boards.at(-1);
      const settled = boards.length;
      act(() => {
        vi.advanceTimersByTime(MOVE_PAUSE_MS * 3);
      });
      expect(boards.length).toBe(settled);
      return shown;
    } finally {
      vi.useRealTimers();
    }
  }

  it("shows the move that solves a puzzle at once", () => {
    const solvedNow = puzzleAfterE5({
      status: "solved",
      fen: AFTER_NF3,
      turn: "black",
      last_move: { from: "g1", to: "f3" },
      legal_moves: [],
      input_enabled: false,
      exploring: { fen: AFTER_NF3, line_san: [], trail: [] },
      last_try: { uci: "g1f3", san: "Nf3", correct: true },
      moves: [...playedE4E5, { ply: 2, uci: "g1f3", san: "Nf3", by: "student" }],
    });
    expect(settlesAtOnce(puzzleAfterE5(), ["g1", "f3"], solvedNow)).toEqual({
      movableColor: undefined,
      fen: AFTER_NF3,
      hint: {},
    });
  });

  it("shows the move that answers a card at once", () => {
    const right = card({
      status: "solved",
      fen: AFTER_E4,
      turn: "black",
      input_enabled: false,
      legal_moves: [],
      last_move: { from: "e2", to: "e4" },
      exploring: { fen: AFTER_E4, line_san: [], trail: [] },
      last_try: { uci: "e2e4", san: "e4", correct: true },
      moves: [{ ply: 0, uci: "e2e4", san: "e4", by: "student" }],
    });
    expect(settlesAtOnce(card(), ["e2", "e4"], right)).toEqual({
      movableColor: undefined,
      fen: AFTER_E4,
      hint: {},
    });
  });

  it("shows a move explored on an open item at once", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      boards.length = 0;
      const server = api(puzzle());
      const { rerender } = render(
        <Practice server={server} createBoard={spyBoard} fetchMotifs={noMotifs} />,
      );
      fireEvent.click(stepButton("Explore"));
      dropOnPracticeBoard("e2", "e4");
      expect(server.send).toHaveBeenCalledWith({
        type: "explore",
        kind: "move",
        uci: "e2e4",
        activity_id: 4,
      });
      const explored = puzzle({
        turn: "black",
        last_move: { from: "e2", to: "e4" },
        legal_moves: legalMovesOf(AFTER_E4),
        exploring: { fen: AFTER_E4, line_san: ["e4"], trail: [] },
      });
      rerender(<Practice server={api(explored)} createBoard={spyBoard} fetchMotifs={noMotifs} />);
      expect(boards.at(-1)).toEqual({ movableColor: "both", fen: AFTER_E4, hint: {} });
      const settled = boards.length;
      act(() => {
        vi.advanceTimersByTime(MOVE_PAUSE_MS * 3);
      });
      expect(boards.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a pause for Explore and for a step back through the moves", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      boards.length = 0;
      const { rerender } = render(
        <Practice server={api(puzzle())} createBoard={spyBoard} fetchMotifs={noMotifs} />,
      );
      dropOnPracticeBoard("e2", "e4");
      rerender(
        <Practice server={api(repliedE5())} createBoard={spyBoard} fetchMotifs={noMotifs} />,
      );
      expect(boards.at(-1)?.fen).toBe(AFTER_E4);
      fireEvent.click(stepButton("First move"));
      expect(boards.at(-1)).toEqual({ movableColor: undefined, fen: START_FEN, hint: {} });
      fireEvent.click(stepButton("Last move"));
      fireEvent.click(stepButton("Explore"));
      expect(boards.at(-1)).toEqual({ movableColor: "both", fen: AFTER_E5, hint: {} });
    } finally {
      vi.useRealTimers();
    }
  });
});

const noop = (): void => {};

// The hub on its Openings page, where the openings menu is.
function renderHub(props: Partial<PracticeHubProps> = {}) {
  const view = render(
    <PracticeHub
      progress={{ status: "ready", value: progressOf() }}
      motifs={{ status: "ready", value: motifCounts }}
      repertoires={{ status: "ready", value: repertoireList }}
      engineMissing={false}
      starting={null}
      failure={null}
      onStart={noop}
      onStartRepertoire={noop}
      {...props}
    />,
  );
  openPracticePage("Openings");
  return view;
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
    const alert = await within(white).findByRole("alert");
    expect(alert.className).toContain("practice__failure");
    expect(alert.textContent).toBe("The openings met in your games could not be loaded.");
    expect(within(white).queryByText("Met in your games")).toBeNull();
    expect(within(white).getByRole("heading", { name: "Italian Game" })).toBeTruthy();
    // The three starts of the one drill, its Coverage, and Try again; no Add for an unreadable opening.
    expect(within(white).getAllByRole("button")).toHaveLength(5);
    expect(within(white).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("retries only the met-openings list when Try again is pressed inside White openings", async () => {
    let resolveSecond: (value: RepertoiresResponse) => void = () => undefined;
    const secondCall = new Promise<RepertoiresResponse>((resolve) => {
      resolveSecond = resolve;
    });
    const fetchRepertoireList = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(secondCall);
    const fetchProgress = vi.fn(hubProps.fetchProgress);
    const fetchMotifs = vi.fn(hubProps.fetchMotifs);
    const fetchRepertoires = vi.fn(async () => repertoireList);
    const fetchOpeningDrills = vi.fn(hubProps.fetchOpeningDrills);

    render(
      <Practice
        server={api(null)}
        fetchProgress={fetchProgress}
        fetchMotifs={fetchMotifs}
        fetchRepertoires={fetchRepertoires}
        fetchRepertoireList={fetchRepertoireList}
        fetchOpeningDrills={fetchOpeningDrills}
      />,
    );
    openPracticePage("Openings");

    await screen.findByRole("heading", { name: "Italian Game" });
    const white = await whiteOpenings();
    const alert = await within(white).findByRole("alert");
    expect(alert.className).toContain("practice__failure");
    expect(alert.textContent).toBe("The openings met in your games could not be loaded.");

    fireEvent.click(within(white).getByRole("button", { name: "Try again" }));
    expect(within(white).getByRole("status").textContent).toBe(
      "Loading openings met in your games.",
    );
    expect(fetchRepertoireList).toHaveBeenCalledTimes(2);
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    expect(fetchMotifs).toHaveBeenCalledTimes(1);
    expect(fetchRepertoires).toHaveBeenCalledTimes(1);
    expect(fetchOpeningDrills).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSecond(listing([scandinavian]));
      await secondCall;
    });
    expect(within(white).queryByRole("alert")).toBeNull();
    const list = await within(white).findByRole("list", { name: "Openings met in your games" });
    expect(within(list).getByText("Scandinavian Defense")).toBeTruthy();
  });

  it("offers Try again when the run ended but the list could not be read again", async () => {
    let resolveThird: (value: RepertoiresResponse) => void = () => undefined;
    const thirdCall = new Promise<RepertoiresResponse>((resolve) => {
      resolveThird = resolve;
    });
    const reads = [
      async () => listing([scandinavian]),
      async () => {
        throw new Error("down");
      },
      () => thirdCall,
    ];
    const fetchRepertoireList = vi.fn(async () => {
      const next = reads.shift();
      if (!next) throw new Error("unexpected read");
      return next();
    });
    renderHub({ fetchRepertoireList, addOpening: async () => ({ truncated: false }) });
    const white = await whiteOpenings();
    fireEvent.click(
      await within(white).findByRole("button", { name: "Add Scandinavian Defense, 1.e4 d5" }),
    );
    const status = await within(white).findByText("Scandinavian Defense is built.");
    expect(status.getAttribute("role")).toBe("status");
    const alert = await within(white).findByRole("alert");
    expect(alert.className).toContain("practice__failure");
    expect(alert.textContent).toBe("The openings list could not be loaded.");
    expect(within(white).queryByText(/Reload the page/)).toBeNull();

    fireEvent.click(within(white).getByRole("button", { name: "Try again" }));
    expect(
      within(white)
        .getAllByRole("status")
        .some((item) => item.textContent === "Loading openings."),
    ).toBe(true);
    expect(fetchRepertoireList).toHaveBeenCalledTimes(3);

    await act(async () => {
      resolveThird(
        listing([{ ...scandinavian, repertoire_id: 7 }], [...repertoireList, scandinavianDrill]),
      );
      await thirdCall;
    });
    expect(within(white).queryByRole("alert")).toBeNull();
    expect(
      await within(white).findByText("Scandinavian Defense is built. Its drill is listed above."),
    ).toBeTruthy();
    expect(within(white).getByRole("heading", { name: "Scandinavian Defense" })).toBeTruthy();
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
    openPracticePage("Openings");
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
    openPracticePage("Openings");
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

  it("lists no drill until they are read, and offers Try again in Openings when they could not be", async () => {
    const fetchRepertoireList = async () => listing([]);
    renderHub({ openingDrills: { status: "loading" }, onStartOpening: noop, fetchRepertoireList });
    const openingsLoading = await screen.findByRole("region", { name: "Openings" });
    expect(within(openingsLoading).getByRole("status").textContent).toBe(
      "Loading positions from your games.",
    );
    const white = await whiteOpenings();
    await settle();
    expect(within(white).queryByRole("list", { name: /^Positions from your games/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Black openings" })).toBeNull();
    cleanup();

    const retry = vi.fn();
    renderHub({
      openingDrills: { status: "failed", retry },
      onStartOpening: noop,
      fetchRepertoireList,
    });
    const openings = await screen.findByRole("region", { name: "Openings" });
    const alert = within(openings).getByRole("alert");
    expect(alert.className).toContain("practice__failure");
    expect(alert.textContent).toBe("The positions from your games could not be loaded.");
    fireEvent.click(within(openings).getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "Black openings" })).toBeNull();
  });

  it("retries only opening drills when Try again is pressed inside the Openings card", async () => {
    let resolveSecond: (value: OpeningDrillsResponse) => void = () => undefined;
    const secondCall = new Promise<OpeningDrillsResponse>((resolve) => {
      resolveSecond = resolve;
    });
    const fetchOpeningDrills = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(secondCall);
    const fetchProgress = vi.fn(hubProps.fetchProgress);
    const fetchMotifs = vi.fn(hubProps.fetchMotifs);
    const fetchRepertoires = vi.fn(async () => repertoireList);
    const fetchRepertoireList = vi.fn(async () => listing([]));

    render(
      <Practice
        server={api(null)}
        fetchProgress={fetchProgress}
        fetchMotifs={fetchMotifs}
        fetchRepertoires={fetchRepertoires}
        fetchRepertoireList={fetchRepertoireList}
        fetchOpeningDrills={fetchOpeningDrills}
      />,
    );
    openPracticePage("Openings");

    const openings = await screen.findByRole("region", { name: "Openings" });
    const alert = await within(openings).findByRole("alert");
    expect(alert.className).toContain("practice__failure");
    expect(alert.textContent).toBe("The positions from your games could not be loaded.");

    fireEvent.click(within(openings).getByRole("button", { name: "Try again" }));
    expect(within(openings).getByRole("status").textContent).toBe(
      "Loading positions from your games.",
    );
    expect(fetchOpeningDrills).toHaveBeenCalledTimes(2);
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    expect(fetchMotifs).toHaveBeenCalledTimes(1);
    expect(fetchRepertoires).toHaveBeenCalledTimes(1);
    expect(fetchRepertoireList).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSecond(gameDrills);
      await secondCall;
    });
    expect(within(openings).queryByRole("alert")).toBeNull();
    expect(await screen.findByRole("region", { name: "Black openings" })).toBeTruthy();
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

  it("sends the colour and the family, and no size", async () => {
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
    openPracticePage("Openings");
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
    });
  });

  it("sends the unnamed entry of a colour as UNNAMED_OPENING, with no size", async () => {
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
    openPracticePage("Openings");
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
    openPracticePage("Openings");
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

describe("the hub's frame", () => {
  const entriesOf = (container: HTMLElement): string[] =>
    within(container)
      .getAllByRole("button")
      .map((button) => button.textContent ?? "");
  const currentEntries = (): string[] =>
    within(practiceNav())
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-current") === "page")
      .map((button) => button.textContent ?? "");
  // Only the page on screen is in the accessibility tree, so its title is the one heading at level 2.
  const pageTitle = (): string => screen.getByRole("heading", { level: 2 }).textContent ?? "";
  const openingsEntry = (): HTMLElement =>
    within(practiceNav()).getByRole("button", { name: /^Openings(,|$)/ });
  const UNBUILT = ["From my games", "Dashboard", "Openings played"];

  // An answer that counts the moves due on each side apart from the variations under it.
  const withSides = (
    white: number,
    black: number,
    met: MetOpening[] = [],
  ): RepertoiresResponse => ({
    ...listing(met),
    sides: [
      { side: "white", moves: { recommended: 4, due: white, all: 40 } },
      { side: "black", moves: { recommended: 2, due: black, all: 12 } },
    ],
  });

  it("lists Train and Stats with their entries in order, eight buttons in all", () => {
    render(<Practice server={api(null)} {...hubProps} />);
    const train = within(practiceNav()).getByRole("group", { name: "Train" });
    const stats = within(practiceNav()).getByRole("group", { name: "Stats" });
    expect(entriesOf(train)).toEqual(["Overview", "Puzzle themes", "From my games", "Openings"]);
    expect(entriesOf(stats)).toEqual([
      "Dashboard",
      "Improvement areas",
      "Strengths",
      "Openings played",
    ]);
    expect(follows(train, stats)).toBe(true);
    expect(within(practiceNav()).getAllByRole("button")).toHaveLength(8);
  });

  it("opens on Overview with nothing stored, and marks only the entry of the page on screen", () => {
    expect(window.localStorage.getItem(PRACTICE_PAGE_STORAGE_KEY)).toBeNull();
    render(<Practice server={api(null)} {...hubProps} />);
    expect(pageTitle()).toBe("Practice");
    expect(currentEntries()).toEqual(["Overview"]);
    openPracticePage("Strengths");
    expect(currentEntries()).toEqual(["Strengths"]);
  });

  it("shows the page of the entry chosen, stores the entry and puts the page back at its top", () => {
    const { container } = render(<Practice server={api(null)} {...hubProps} />);
    const scroller = screen.getByRole("region", { name: "Practice" });
    scroller.scrollTop = 480;
    container.scrollTop = 120;
    openPracticePage("Openings");
    expect(pageTitle()).toBe("Openings");
    expect(scroller.scrollTop).toBe(0);
    expect(container.scrollTop).toBe(0);
    expect(window.localStorage.getItem(PRACTICE_PAGE_STORAGE_KEY)).toBe("openings");

    scroller.scrollTop = 300;
    openPracticePage("Overview");
    expect(pageTitle()).toBe("Practice");
    expect(scroller.scrollTop).toBe(0);
    expect(screen.queryByRole("region", { name: "Openings" })).toBeNull();
    expect(window.localStorage.getItem(PRACTICE_PAGE_STORAGE_KEY)).toBe("overview");
  });

  it("shows the Overview at its Puzzle themes section for Puzzle themes, that entry being current", () => {
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      render(<Practice server={api(null)} {...hubProps} />);
      openPracticePage("Dashboard");
      scrolled.mockClear();
      openPracticePage("Puzzle themes");
      expect(pageTitle()).toBe("Practice");
      const themes = screen.getByRole("region", { name: "Puzzle themes" });
      expect(within(themes).getByRole("region", { name: "Puzzles by motif" })).toBeTruthy();
      expect(scrolled.mock.contexts).toEqual([themes]);
      expect(currentEntries()).toEqual(["Puzzle themes"]);
      expect(window.localStorage.getItem(PRACTICE_PAGE_STORAGE_KEY)).toBe("puzzle-themes");
    } finally {
      scrolled.mockRestore();
    }
  });

  it("comes back to the stored page after an item ends and after a reload", () => {
    const view = render(<Practice server={api(null)} {...hubProps} createBoard={spyBoard} />);
    openPracticePage("Openings");
    view.rerender(<Practice server={api(puzzle())} {...hubProps} createBoard={spyBoard} />);
    expect(screen.queryByRole("navigation", { name: "Practice sections" })).toBeNull();
    view.rerender(<Practice server={api(null)} {...hubProps} createBoard={spyBoard} />);
    expect(pageTitle()).toBe("Openings");
    expect(currentEntries()).toEqual(["Openings"]);

    view.unmount();
    render(<Practice server={api(null)} {...hubProps} />);
    expect(pageTitle()).toBe("Openings");
    expect(currentEntries()).toEqual(["Openings"]);
  });

  it("brings a stored Puzzle themes back to its section", () => {
    window.localStorage.setItem(PRACTICE_PAGE_STORAGE_KEY, "puzzle-themes");
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    try {
      render(<Practice server={api(null)} {...hubProps} />);
      expect(pageTitle()).toBe("Practice");
      expect(currentEntries()).toEqual(["Puzzle themes"]);
      expect(scrolled.mock.contexts).toEqual([
        screen.getByRole("region", { name: "Puzzle themes" }),
      ]);
    } finally {
      scrolled.mockRestore();
    }
  });

  it.each(["dashboards", "", "Openings"])(
    "shows Overview for a stored value that names no page: %j",
    (stored) => {
      window.localStorage.setItem(PRACTICE_PAGE_STORAGE_KEY, stored);
      render(<Practice server={api(null)} {...hubProps} />);
      expect(pageTitle()).toBe("Practice");
      expect(currentEntries()).toEqual(["Overview"]);
    },
  );

  it("draws the Overview in order: title, problem cards, tiles, Due cards, Puzzle themes", async () => {
    const missing = async () => ({
      status: "ok" as const,
      version: "test",
      ready: false,
      reason: "stockfish_missing",
    });
    const authFailure = { type: "turn_error" as const, key: "e1", message: "Not logged in" };
    render(
      <Practice
        server={{ ...api(null), items: [authFailure] }}
        {...hubProps}
        fetchHealth={missing}
      />,
    );
    const title = screen.getByRole("heading", { level: 2, name: "Practice" });
    expect(title.nextElementSibling?.textContent).toBe(
      "Pick a session. The board appears once an item starts.",
    );
    const engine = await screen.findByRole("alert", { name: "Engine missing" });
    const login = screen.getByRole("alert", { name: "Coach not logged in" });
    const tiles = (await screen.findByText("Day streak")).closest("dl") as HTMLElement;
    const due = screen.getByRole("region", { name: "Due cards" });
    const themes = screen.getByRole("region", { name: "Puzzle themes" });
    expect(within(themes).getByRole("heading", { name: "Puzzle themes" })).toBeTruthy();
    const motifs = within(themes).getByRole("region", { name: "Puzzles by motif" });
    const order = [title, engine, login, tiles, due, themes];
    for (const [index, node] of order.slice(1).entries()) {
      expect(follows(order[index] as Element, node)).toBe(true);
    }
    // The motif card keeps its rows and its start, and offers no size to choose.
    expect(within(motifs).getByRole("radio", { name: /^Fork,/ })).toBeTruthy();
    expect(within(motifs).queryByRole("group", { name: "Drill size" })).toBeNull();
    expect(within(motifs).queryByRole("button", { name: /^(5|10|20)$/ })).toBeNull();
    expect(within(motifs).getByRole("button", { name: "Start any motif" })).toBeTruthy();
  });

  it.each(UNBUILT)("says %s is not built yet, and nothing else", (name) => {
    render(<Practice server={api(null)} {...hubProps} />);
    openPracticePage(name);
    const title = screen.getByRole("heading", { level: 2 });
    expect(title.textContent).toBe(name);
    const page = title.closest(".practice-page") as HTMLElement;
    expect(page.textContent).toBe(`${name}This page is not built yet.`);
    expect(within(page).queryAllByRole("button")).toEqual([]);
    expect(currentEntries()).toEqual([name]);
    expect(screen.queryByRole("region", { name: "Due cards" })).toBeNull();
  });

  it("shows the Openings page with its title over the openings menu and the older Italian row", async () => {
    render(<Practice server={api(null)} {...hubProps} fetchRepertoires={listedRepertoires} />);
    openPracticePage("Openings");
    const title = screen.getByRole("heading", { level: 2 });
    expect(title.textContent).toBe("Openings");
    await screen.findByRole("heading", { name: "Italian Game" });
    const white = screen.getByRole("region", { name: "White openings" });
    const italian = screen.getByRole("region", { name: "Openings" });
    expect(within(italian).getByText("Italian Opening")).toBeTruthy();
    expect(follows(title, white)).toBe(true);
    expect(follows(white, italian)).toBe(true);
    expect(screen.queryByRole("region", { name: "Puzzles by motif" })).toBeNull();
  });

  it("counts on Openings the repertoire moves due now over both sides, and on no other entry", async () => {
    render(
      <Practice
        server={api(null)}
        {...hubProps}
        fetchRepertoires={listedRepertoires}
        fetchRepertoireList={async () => withSides(9, 3)}
      />,
    );
    const openings = await within(practiceNav()).findByRole("button", {
      name: "Openings, 12 moves due",
    });
    expect(openings.textContent).toBe("Openings12");
    const others = within(practiceNav())
      .getAllByRole("button")
      .filter((entry) => entry !== openings);
    expect(others).toHaveLength(7);
    for (const entry of others) expect(entry.textContent).not.toMatch(/\d/);
  });

  it("shows no count while the list loads, when it could not be read, or at 0", async () => {
    const loading = render(
      <Practice
        server={api(null)}
        {...hubProps}
        fetchRepertoires={listedRepertoires}
        fetchRepertoireList={() => new Promise<RepertoiresResponse>(() => {})}
      />,
    );
    await screen.findByRole("button", { name: "Review 4 cards" });
    await settle();
    expect(openingsEntry().textContent).toBe("Openings");
    loading.unmount();

    const failing = render(
      <Practice
        server={api(null)}
        {...hubProps}
        fetchRepertoires={listedRepertoires}
        fetchRepertoireList={async () => {
          throw new Error("down");
        }}
      />,
    );
    openPracticePage("Openings");
    // The loading card is replaced once the list has loaded, so it is found by what the list holds.
    await screen.findByRole("heading", { name: "Italian Game" });
    const white = screen.getByRole("region", { name: "White openings" });
    await within(white).findByRole("alert");
    expect(openingsEntry().textContent).toBe("Openings");
    failing.unmount();

    const read = vi.fn(async () => withSides(0, 0));
    render(
      <Practice
        server={api(null)}
        {...hubProps}
        fetchRepertoires={listedRepertoires}
        fetchRepertoireList={read}
      />,
    );
    await waitFor(() => expect(read).toHaveBeenCalled());
    await settle();
    expect(openingsEntry().textContent).toBe("Openings");
    expect(openingsEntry().getAttribute("aria-label")).toBeNull();
  });

  it("counts again from the list the openings menu reads once it has added a drill", async () => {
    const built = { ...scandinavian, repertoire_id: 7 };
    const reads = [
      withSides(9, 3, [scandinavian]),
      { ...withSides(15, 3, [built]), repertoires: [...repertoireList, scandinavianDrill] },
    ];
    renderHub({
      fetchRepertoireList: async () => reads.shift() as RepertoiresResponse,
      addOpening: async () => ({ truncated: false }),
    });
    await within(practiceNav()).findByRole("button", { name: "Openings, 12 moves due" });
    const white = await whiteOpenings();
    fireEvent.click(
      await within(white).findByRole("button", { name: "Add Scandinavian Defense, 1.e4 d5" }),
    );
    expect(
      await within(practiceNav()).findByRole("button", { name: "Openings, 18 moves due" }),
    ).toBeTruthy();
  });

  it("keeps an opening being built while another page is shown", async () => {
    let finish: () => void = noop;
    renderHub({
      fetchRepertoireList: async () => listing([scandinavian]),
      addOpening: () =>
        new Promise<AddedOpening>((resolve) => {
          finish = () => resolve({ truncated: false });
        }),
    });
    const white = await whiteOpenings();
    fireEvent.click(
      await within(white).findByRole("button", { name: "Add Scandinavian Defense, 1.e4 d5" }),
    );
    openPracticePage("Overview");
    openPracticePage("Openings");
    expect(
      within(white).getByRole("button", { name: "Building Scandinavian Defense, 1.e4 d5" }),
    ).toBeTruthy();
    await act(async () => finish());
  });

  it("shows the Starting state and a refused start on the Openings page, where it was pressed", async () => {
    const server = api(null);
    const props = { ...hubProps, fetchRepertoires: listedRepertoires };
    const view = render(<Practice server={server} {...props} />);
    openPracticePage("Openings");
    await screen.findByRole("heading", { name: "Italian Game" });
    const white = screen.getByRole("region", { name: "White openings" });
    fireEvent.click(within(white).getByRole("button", { name: "Everything due 14" }));
    expect(within(white).getByRole("button", { name: "Starting" })).toBeTruthy();
    openPracticePage("Overview");
    expect(screen.queryByRole("button", { name: "Starting" })).toBeNull();

    view.rerender(
      <Practice server={{ ...server, errorCount: 1, lastErrorCode: "empty_queue" }} {...props} />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    openPracticePage("Openings");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "No move of this opening is due right now",
    );
  });

  it("shows the Starting state and a refused start on the Overview, where it was pressed", async () => {
    const server = api(null);
    const view = render(<Practice server={server} {...hubProps} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review 4 cards" }));
    expect(
      within(screen.getByRole("region", { name: "Due cards" })).getByRole("button", {
        name: "Starting",
      }),
    ).toBeTruthy();
    openPracticePage("Openings");
    expect(screen.queryByRole("button", { name: "Starting" })).toBeNull();

    view.rerender(
      <Practice
        server={{ ...server, errorCount: 1, lastErrorCode: "empty_queue" }}
        {...hubProps}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    openPracticePage("Overview");
    expect((await screen.findByRole("alert")).textContent).toContain("Nothing is due right now");
  });
});

// The browser lays the frame out; these read the rules it is drawn with off the stylesheet.
describe("the hub's frame styles", () => {
  const STYLES = join(import.meta.dirname, "../src/styles");
  const css = readFileSync(join(STYLES, "practice-hub.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
  const phoneAt = css.indexOf("@media (max-width: 899px)");
  const desktop = css.slice(0, phoneAt);
  const phone = css.slice(phoneAt);

  // Every declaration the rules naming the selector give it, the later one winning.
  function declared(sheet: string, selector: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const [, selectors = "", body = ""] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!selectors.split(",").some((part) => part.trim() === selector)) continue;
      for (const declaration of body.split(";")) {
        const [property = "", ...value] = declaration.split(":");
        if (property.trim() !== "" && value.length > 0) {
          found[property.trim()] = value.join(":").trim();
        }
      }
    }
    return found;
  }
  const token = (name: string): string | undefined =>
    new RegExp(`${name}: ([^;]+);`).exec(tokens)?.[1];

  it("keeps the navigation 220 px wide and in view beside a column of at most 1440 px, 16 px apart", () => {
    expect(phoneAt).toBeGreaterThan(0);
    expect(declared(desktop, ".practice-nav")).toMatchObject({
      width: "220px",
      flex: "none",
      position: "sticky",
      top: "0",
    });
    expect(declared(desktop, ".practice-hub")).toMatchObject({
      display: "flex",
      gap: "var(--space-4)",
    });
    expect(token("--space-4")).toBe("1rem");
    expect(declared(desktop, ".practice-hub__pages")).toMatchObject({
      "min-width": "0",
      "max-width": "1440px",
    });
  });

  it("draws an entry 36 px high in 14 px text with a 4 px radius, the current one on the inset surface", () => {
    expect(declared(desktop, ".practice-nav__entry")).toMatchObject({
      height: "36px",
      "font-size": "var(--text-sm)",
      "border-radius": "var(--radius-sm)",
      color: "var(--text-2)",
    });
    expect(token("--text-sm")).toBe("0.875rem");
    expect(token("--radius-sm")).toBe("4px");
    expect(declared(desktop, '.practice-nav__entry[aria-current="page"]')).toMatchObject({
      background: "var(--surface-2)",
      color: "var(--text-1)",
    });
    expect(declared(desktop, ".practice-nav__label")).toMatchObject({
      "font-size": "var(--text-xs)",
      color: "var(--text-3)",
    });
    expect(token("--text-xs")).toBe("0.75rem");
  });

  it("is imported by the entry point, or the frame would have no styling", () => {
    const entry = readFileSync(join(import.meta.dirname, "../src/main.tsx"), "utf8");
    expect(entry).toContain('import "./styles/practice-hub.css";');
  });

  it("lets only the navigation scroll by itself, never a card", () => {
    const scrolling = [...desktop.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body = ""]) => /overflow|max-height/.test(body))
      .map(([, selectors = ""]) => selectors.trim());
    expect(scrolling).toEqual([".practice-nav"]);
  });

  it("stacks the hub under 900 px: a wrapping row of 44 px entries with no group label, one column of cards", () => {
    expect(declared(phone, ".practice-hub")).toMatchObject({ "flex-direction": "column" });
    expect(declared(phone, ".practice-nav")).toMatchObject({
      position: "static",
      "flex-direction": "row",
      "flex-wrap": "wrap",
    });
    expect(declared(phone, ".practice-nav__group")).toMatchObject({ display: "contents" });
    expect(declared(phone, ".practice-nav__label")).toMatchObject({ display: "none" });
    expect(declared(phone, ".practice-nav__entry")).toMatchObject({ "min-height": "44px" });
    expect(declared(desktop, ".practice-tiles")).toMatchObject({
      "grid-template-columns": "repeat(auto-fit, minmax(200px, 1fr))",
      gap: "var(--space-3)",
    });
    expect(token("--space-3")).toBe("0.75rem");
    expect(declared(desktop, '.practice-tile__delta[data-direction="up"]')).toMatchObject({
      color: "var(--quality-best)",
    });
    expect(declared(desktop, '.practice-tile__delta[data-direction="down"]')).toMatchObject({
      color: "var(--quality-blunder)",
    });
    expect(declared(desktop, ".practice-tile__streak-bars")).toMatchObject({
      gap: "var(--space-1)",
    });
    expect(token("--space-1")).toBe("0.25rem");
    expect(declared(desktop, ".practice-tile__streak-day")).toMatchObject({
      height: "6px",
      background: "var(--surface-2)",
    });
    expect(declared(desktop, '.practice-tile__streak-day[data-active="true"]')).toMatchObject({
      background: "var(--status-ready)",
    });
    expect(
      declared(desktop, '.practice-tile__streak-day[data-active="true"][data-today="true"]'),
    ).toMatchObject({
      background: "var(--accent)",
    });
    expect(declared(desktop, ".practice-tile__spark")).toMatchObject({
      height: "16px",
    });
    expect(declared(desktop, ".practice-tile__split")).toMatchObject({
      height: "6px",
    });
    expect(declared(desktop, ".practice-tile__split-solved")).toMatchObject({
      background: "var(--status-ready)",
    });
    expect(declared(desktop, ".practice-tile__split-rest")).toMatchObject({
      background: "var(--status-error)",
    });
    expect(declared(desktop, ".practice-forecast")).toMatchObject({
      "border-top": "1px solid var(--surface-2)",
    });
    expect(
      declared(desktop, '.practice-forecast__day[data-today="true"] .practice-forecast__bar'),
    ).toMatchObject({
      background: "var(--accent)",
    });
    expect(declared(phone, ".practice-tiles")).toMatchObject({
      "grid-template-columns": "repeat(2, minmax(0, 1fr))",
    });
    expect(declared(phone, ".practice-page__cards")).toMatchObject({
      "grid-template-columns": "minmax(0, 1fr)",
    });
  });
});
