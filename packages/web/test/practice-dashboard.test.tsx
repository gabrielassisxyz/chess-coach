import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  PlayedOpeningsResponse,
  PlayedWindow,
  PuzzleRatingHistoryResponse,
  PuzzleRatingPoint,
  PuzzleRatingWindow,
  ThemeStatsEntry,
  ThemeStatsResponse,
} from "@chess-coach/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Practice } from "../src/screens/Practice.js";
import { NEEDS_ENGINE_TEXT, NONE } from "../src/state/practice.js";
import { PRACTICE_PAGE_STORAGE_KEY } from "../src/state/practice-page.js";
import { ratingChartAxis, ratingChartPoints } from "../src/state/puzzle-rating-api.js";
import {
  noPlayedColour,
  openPracticePage,
  playedColour,
  playedOpening,
  playedVariation,
  progressOf,
} from "./practice-fixtures.js";
import { serverApi } from "./server-api.js";

function themeEntry(overrides: Partial<ThemeStatsEntry> & { theme: string }): ThemeStatsEntry {
  return {
    played: 12,
    first_try: 8,
    rating_avg: 1450,
    performance: 1450,
    ranked: true,
    ...overrides,
  };
}

function makeDailyPoints(
  count: number,
  endDay = "2026-06-10",
  startRating = 1480,
): PuzzleRatingPoint[] {
  const endMs = Date.parse(`${endDay}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(endMs - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10);
    return { day, rating: startRating + index * 2 };
  });
}

function makeHistory(
  overrides: Partial<PuzzleRatingHistoryResponse> = {},
): PuzzleRatingHistoryResponse {
  const points = overrides.points ?? makeDailyPoints(30);
  const ratings = points.map((p) => p.rating);
  return {
    current: points.at(-1)?.rating ?? 1505,
    points,
    low: Math.min(...ratings),
    high: Math.max(...ratings),
    change: (points.at(-1)?.rating ?? 1505) - (points[0]?.rating ?? 1505),
    ...overrides,
  };
}

function makeThemeStats(overrides: Partial<ThemeStatsResponse> = {}): ThemeStatsResponse {
  const themes: ThemeStatsEntry[] = overrides.themes ?? [
    themeEntry({ theme: "fork", played: 18, first_try: 10, rating_avg: 1380, performance: 1380 }),
    themeEntry({ theme: "pin", played: 14, first_try: 7, rating_avg: 1410, performance: 1410 }),
    themeEntry({ theme: "skewer", played: 11, first_try: 7, rating_avg: 1430, performance: 1430 }),
    themeEntry({
      theme: "backRankMate",
      played: 10,
      first_try: 6,
      rating_avg: 1450,
      performance: 1450,
    }),
    themeEntry({
      theme: "discoveredAttack",
      played: 9,
      first_try: 6,
      rating_avg: 1470,
      performance: 1470,
    }),
    themeEntry({
      theme: "hangingPiece",
      played: 9,
      first_try: 5,
      rating_avg: 1490,
      performance: 1490,
    }),
    themeEntry({
      theme: "deflection",
      played: 15,
      first_try: 13,
      rating_avg: 1620,
      performance: 1620,
    }),
    themeEntry({
      theme: "mateIn2",
      played: 16,
      first_try: 13,
      rating_avg: 1590,
      performance: 1590,
    }),
    themeEntry({
      theme: "doubleCheck",
      played: 12,
      first_try: 9,
      rating_avg: 1560,
      performance: 1560,
    }),
    themeEntry({
      theme: "attraction",
      played: 10,
      first_try: 8,
      rating_avg: 1545,
      performance: 1545,
    }),
    themeEntry({
      theme: "clearance",
      played: 9,
      first_try: 7,
      rating_avg: 1530,
      performance: 1530,
    }),
    themeEntry({
      theme: "sacrifice",
      played: 8,
      first_try: 6,
      rating_avg: 1520,
      performance: 1520,
    }),
  ];
  return {
    days: "30",
    overall: { played: 120, first_try: 82, rating_avg: 1500, performance: 1505 },
    overall_previous: { played: 95, first_try: 60, rating_avg: 1465, performance: 1470 },
    themes,
    improvement_areas: [
      "fork",
      "pin",
      "skewer",
      "backRankMate",
      "discoveredAttack",
      "hangingPiece",
    ],
    strengths: ["deflection", "mateIn2", "doubleCheck", "attraction", "clearance", "sacrifice"],
    unranked: 2,
    ...overrides,
  };
}

// The games counted by opening: White chose Italian Game (20) and King's Pawn Game (2) and met
// Scandinavian Defense (4), Busch-Gass Gambit (1) and Petrov's Defense (2); Black chose Queen's Gambit
// Declined (8) and Slav Defense (4) and met London System (5). The Slav ties the Scandinavian at four.
const PLAYED = {
  white: playedColour(
    [
      playedOpening("Italian Game", "1.e4 e5 2.Nf3 Nc6 3.Bc4", [
        playedVariation("Italian Game: Giuoco Pianissimo", [6, 1, 2]),
        playedVariation("Italian Game: Two Knights Defense", [5, 1, 5]),
      ]),
      playedOpening("King's Pawn Game", "1.e4 e5", [
        playedVariation("King's Pawn Game", [2, 0, 0]),
      ]),
    ],
    [
      playedOpening("Scandinavian Defense", "1.e4 d5", [
        playedVariation("Scandinavian Defense", [3, 0, 1]),
      ]),
      playedOpening("Busch-Gass Gambit", "1.e4 e5 2.Nf3 Bc5", [
        playedVariation("Busch-Gass Gambit", [0, 0, 1]),
      ]),
      playedOpening("Petrov's Defense", "1.e4 e5 2.Nf3 Nf6", [
        playedVariation("Petrov's Defense", [1, 0, 1]),
      ]),
    ],
  ),
  black: playedColour(
    [
      playedOpening("Queen's Gambit Declined", "1.d4 d5 2.c4 e6", [
        playedVariation("Queen's Gambit Declined: Exchange Variation", [2, 1, 5]),
      ]),
      playedOpening("Slav Defense", "1.d4 d5 2.c4 c6", [
        playedVariation("Slav Defense", [2, 1, 1]),
      ]),
    ],
    [
      playedOpening("London System", "1.d4 d5 2.Bf4", [
        playedVariation("London System", [2, 1, 2]),
      ]),
    ],
  ),
} satisfies PlayedOpeningsResponse;

const NO_PLAYED: PlayedOpeningsResponse = { white: noPlayedColour, black: noPlayedColour };

function renderPractice(
  options: {
    send?: () => boolean;
    fetchThemeStats?: (days: PuzzleRatingWindow) => Promise<ThemeStatsResponse>;
    fetchRatingHistory?: (days: PuzzleRatingWindow) => Promise<PuzzleRatingHistoryResponse>;
    fetchOpeningsPlayed?: (days: PlayedWindow) => Promise<PlayedOpeningsResponse>;
    dueNow?: number;
    engineMissing?: boolean;
  } = {},
) {
  const send = (options.send ?? (() => true)) as unknown as ReturnType<typeof serverApi>["send"];
  const fetchOpeningsPlayed =
    options.fetchOpeningsPlayed ?? vi.fn(async (_days: PlayedWindow) => PLAYED);
  const fetchThemeStats =
    options.fetchThemeStats ?? vi.fn(async (days: PuzzleRatingWindow) => makeThemeStats({ days }));
  const fetchRatingHistory =
    options.fetchRatingHistory ??
    vi.fn(async (days: PuzzleRatingWindow) => {
      const count = days === "7" ? 7 : days === "90" ? 90 : days === "all" ? 45 : 30;
      return makeHistory({ points: makeDailyPoints(count, "2026-06-10", 1460) });
    });

  const view = render(
    <Practice
      server={serverApi(null, { send })}
      fetchProgress={async () => progressOf({ due_now: options.dueNow ?? 4 })}
      fetchRepertoires={async () => []}
      fetchRepertoireList={async () => ({ repertoires: [], met: [] })}
      fetchHealth={async () => ({
        status: "ok",
        version: "test",
        ready: !(options.engineMissing ?? false),
        ...(options.engineMissing ? { reason: "stockfish_missing" as const } : {}),
      })}
      fetchThemeStats={fetchThemeStats}
      fetchRatingHistory={fetchRatingHistory}
      fetchOpeningsPlayed={fetchOpeningsPlayed}
    />,
  );
  return { view, send, fetchThemeStats, fetchRatingHistory, fetchOpeningsPlayed };
}

afterEach(() => {
  cleanup();
  localStorage.removeItem(PRACTICE_PAGE_STORAGE_KEY);
});

// The hub keeps every page mounted, so the Overview's tiles stay in the document while the
// Dashboard is shown. Scope Dashboard reads to its own root.
function dashboardRoot(): HTMLElement {
  const title = screen.getByRole("heading", { level: 2, name: "Dashboard" });
  return title.closest(".practice-dashboard") as HTMLElement;
}

describe("PracticeDashboard", () => {
  it("loads lazily on first visit, renders header and defaults to 30 days", async () => {
    const { fetchThemeStats, fetchRatingHistory, fetchOpeningsPlayed } = renderPractice();

    // Overview calls each once (theme stats for 30d, rating history for 7d). Dashboard waits until opened.
    await waitFor(() => {
      expect(fetchThemeStats).toHaveBeenCalledTimes(1);
      expect(fetchRatingHistory).toHaveBeenCalledTimes(1);
    });
    expect(fetchOpeningsPlayed).not.toHaveBeenCalled();

    openPracticePage("Dashboard");

    await waitFor(() => {
      expect(fetchThemeStats).toHaveBeenCalledTimes(2);
      expect(fetchRatingHistory).toHaveBeenCalledTimes(2);
      expect(fetchOpeningsPlayed).toHaveBeenCalledTimes(1);
    });
    expect(fetchThemeStats).toHaveBeenLastCalledWith("30");
    expect(fetchRatingHistory).toHaveBeenLastCalledWith("30");
    expect(fetchOpeningsPlayed).toHaveBeenLastCalledWith("30");

    const title = screen.getByRole("heading", { level: 2, name: "Dashboard" });
    expect(title.nextElementSibling?.textContent).toBe(
      "An overview of your puzzles and openings. Each block opens its own page.",
    );

    const period = screen.getByRole("group", { name: "Time window" });
    const buttons = within(period).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["7 days", "30 days", "90 days", "All"]);
    expect(
      within(period).getByRole("button", { name: "30 days" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(period).getByRole("button", { name: "7 days" }).getAttribute("aria-pressed"),
    ).toBe("false");
    // The Openings played page keeps its title and its own period control to itself until opened.
    expect(screen.queryByRole("heading", { level: 2, name: "Openings played" })).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "Openings played" })).toBeTruthy();
  });

  it("renders KPI tiles with upward, downward, absent deltas, split bar, and Due cards Review link", async () => {
    const send = vi.fn(() => true);
    const fetchThemeStats = vi.fn(async (days: PuzzleRatingWindow) => {
      if (days === "7") {
        return makeThemeStats({
          days: "7",
          overall: { played: 24, first_try: 12, rating_avg: 1440, performance: 1450 },
          overall_previous: { played: 30, first_try: 20, rating_avg: 1470, performance: 1480 },
        });
      }
      if (days === "90") {
        return makeThemeStats({
          days: "90",
          overall: { played: 200, first_try: 150, rating_avg: 1495, performance: 1500 },
          overall_previous: { played: 180, first_try: 130, rating_avg: 1495, performance: 1500 },
        });
      }
      return makeThemeStats({ days });
    });

    renderPractice({ send, fetchThemeStats, dueNow: 7 });
    openPracticePage("Dashboard");

    // 30d: upward arrow (+35) and 68% solved first try (82/120 = 68.33 -> 68)
    const board = dashboardRoot();
    const ratingValue = await within(board).findByText("1505");
    const perfTile = ratingValue.closest(".practice-tile") as HTMLElement;
    const upArrow = perfTile.querySelector(".practice-tile__delta");
    expect(upArrow?.getAttribute("data-direction")).toBe("up");
    expect(upArrow?.textContent).toBe("\u25b2 35");

    const playedTile = within(board)
      .getByText("Played", { selector: "dt" })
      .closest(".practice-tile") as HTMLElement;
    expect(within(playedTile).getByText("120")).toBeTruthy();

    const solvedTile = within(board)
      .getByText("Solved first try", { selector: "dt" })
      .closest(".practice-tile") as HTMLElement;
    expect(within(solvedTile).getByText("68%")).toBeTruthy();
    const solvedBar = solvedTile.querySelector(".practice-tile__split-solved") as HTMLElement;
    expect(solvedBar.style.width).toBe("68%");

    const dueTile = within(board)
      .getByText("Due cards", { selector: "dt" })
      .closest(".practice-tile") as HTMLElement;
    expect(within(dueTile).getByText("7")).toBeTruthy();
    fireEvent.click(within(dueTile).getByRole("button", { name: "Review" }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "start_training", mode: "srs" }),
    );

    // Switch to 7 days: downward arrow (-30)
    fireEvent.click(within(board).getByRole("button", { name: "7 days" }));
    await within(perfTile).findByText("1450");
    const downArrow = perfTile.querySelector(".practice-tile__delta");
    expect(downArrow?.getAttribute("data-direction")).toBe("down");
    expect(downArrow?.textContent).toBe("\u25bc 30");
    // Due cards count persists across periods
    expect(within(dueTile).getByText("7")).toBeTruthy();

    // Switch to 90 days: zero delta -> no arrow
    fireEvent.click(within(board).getByRole("button", { name: "90 days" }));
    await within(perfTile).findByText("1500");
    expect(perfTile.querySelector(".practice-tile__delta")).toBeNull();

    // Switch to All -> no arrow even with overall_previous set
    fireEvent.click(within(board).getByRole("button", { name: "All" }));
    await waitFor(() => expect(fetchThemeStats).toHaveBeenLastCalledWith("all"));
    await within(perfTile).findByText("1505");
    expect(perfTile.querySelector(".practice-tile__delta")).toBeNull();
  });

  it("hides Review button when due_now is zero", async () => {
    renderPractice({ dueNow: 0 });
    openPracticePage("Dashboard");

    const board = dashboardRoot();
    const dueTile = (await within(board).findByText("Due cards", { selector: "dt" })).closest(
      ".practice-tile",
    ) as HTMLElement;
    await within(dueTile).findByText("0");
    expect(within(dueTile).queryByRole("button", { name: "Review" })).toBeNull();
  });

  it("renders the Puzzle rating SVG chart with endpoints, period axis labels, and all-time start date", async () => {
    const fetchRatingHistory = vi.fn(async (days: PuzzleRatingWindow) => {
      if (days === "7")
        return makeHistory({
          points: makeDailyPoints(7, "2026-06-10", 1490),
          low: 1490,
          high: 1502,
          current: 1502,
        });
      if (days === "all") {
        return makeHistory({
          points: [
            { day: "2026-01-15", rating: 1400 },
            { day: "2026-06-10", rating: 1550 },
          ],
          low: 1400,
          high: 1550,
          current: 1550,
        });
      }
      return makeHistory({
        points: makeDailyPoints(30, "2026-06-10", 1450),
        low: 1450,
        high: 1508,
        current: 1500,
      });
    });

    renderPractice({ fetchRatingHistory });
    openPracticePage("Dashboard");

    const board = dashboardRoot();
    const chartCard = within(board).getByRole("region", { name: "Puzzle rating" });
    const current = await within(chartCard).findByText("1500", {
      selector: ".practice-dashboard__rating-current",
    });
    expect(current).toBeTruthy();
    expect(within(chartCard).getByText("low 1450 \u00b7 high 1508")).toBeTruthy();
    expect(within(chartCard).getByText("30 days ago")).toBeTruthy();
    expect(within(chartCard).getByText("today")).toBeTruthy();

    const svg = within(chartCard).getByRole("img", { name: "Puzzle rating over time" });
    expect(svg.getAttribute("viewBox")).toBe("0 0 600 120");
    expect(svg.getAttribute("preserveAspectRatio")).toBe("none");
    expect(svg.querySelector("text")).toBeNull();
    const gridlines = svg.querySelectorAll("line");
    expect(gridlines.length).toBeGreaterThanOrEqual(2);
    expect(gridlines.length).toBeLessThanOrEqual(5);
    for (const gridline of gridlines) {
      expect(gridline.getAttribute("stroke")).toBe("var(--surface-2)");
      expect(gridline.getAttribute("x1")).toBe("0");
      expect(gridline.getAttribute("x2")).toBe("600");
    }
    const yaxis = chartCard.querySelector(".practice-dashboard__chart-yaxis") as HTMLElement;
    expect(yaxis).toBeTruthy();
    expect(svg.querySelector(".practice-dashboard__chart-yaxis-value")).toBeNull();
    expect(within(yaxis).getByText("1450")).toBeTruthy();
    expect(within(yaxis).getByText("1500")).toBeTruthy();
    const polyline = svg.querySelector("polyline");
    expect(polyline?.getAttribute("stroke")).toBe("var(--accent)");
    expect(polyline?.getAttribute("stroke-width")).toBe("2");
    expect(polyline?.getAttribute("points")?.split(" ")).toHaveLength(30);

    // Switch to 7 days
    fireEvent.click(within(board).getByRole("button", { name: "7 days" }));
    expect(await within(chartCard).findByText("7 days ago")).toBeTruthy();

    // Switch to All -> left axis shows formatted first day date
    fireEvent.click(within(board).getByRole("button", { name: "All" }));
    expect(await within(chartCard).findByText("15 Jan 2026")).toBeTruthy();
  });

  it("draws a flat midline polyline without NaN when rating history has one day", () => {
    expect(ratingChartPoints([{ day: "2026-06-10", rating: 1500 }])).toBe("0.0,60.0 600.0,60.0");
  });

  it("renders Y axis values 1200 to 1600 for a 1200 to 1534 series at the axis heights", async () => {
    const ratings = Array.from({ length: 30 }, (_, index) => Math.round(1200 + (334 * index) / 29));
    const points = ratings.map((rating, index) => ({
      day: new Date(Date.parse("2026-06-10T00:00:00Z") - (29 - index) * 86_400_000)
        .toISOString()
        .slice(0, 10),
      rating,
    }));
    expect(ratingChartAxis(points)).toEqual([1200, 1300, 1400, 1500, 1600]);
    const fetchRatingHistory = vi.fn(async () => makeHistory({ points }));
    renderPractice({ fetchRatingHistory });
    openPracticePage("Dashboard");

    const board = dashboardRoot();
    const chartCard = within(board).getByRole("region", { name: "Puzzle rating" });
    const yaxis = (await within(chartCard).findByText("1600")).closest(
      ".practice-dashboard__chart-yaxis",
    ) as HTMLElement;
    expect(yaxis).toBeTruthy();
    for (const value of ["1200", "1300", "1400", "1500", "1600"]) {
      expect(within(yaxis).getByText(value)).toBeTruthy();
    }
    const svg = within(chartCard).getByRole("img", { name: "Puzzle rating over time" });
    const gridlines = svg.querySelectorAll("line");
    expect(gridlines).toHaveLength(5);
    const polyline = svg.querySelector("polyline");
    const coords = polyline?.getAttribute("points")?.split(" ") ?? [];
    expect(coords).toHaveLength(30);
    expect(coords[0]).toBe("0.0,112.0");
    expect(coords[coords.length - 1]?.split(",")[1]).toBe("25.2");
  });

  it("renders Y axis values 1500 to 1575 for a flat 1534 series at the height of 1534", async () => {
    const points = Array.from({ length: 10 }, (_, index) => ({
      day: new Date(Date.parse("2026-06-10T00:00:00Z") - (9 - index) * 86_400_000)
        .toISOString()
        .slice(0, 10),
      rating: 1534,
    }));
    expect(ratingChartAxis(points)).toEqual([1500, 1525, 1550, 1575]);
    const fetchRatingHistory = vi.fn(async () => makeHistory({ points }));
    renderPractice({ fetchRatingHistory });
    openPracticePage("Dashboard");

    const board = dashboardRoot();
    const chartCard = within(board).getByRole("region", { name: "Puzzle rating" });
    const yaxis = (await within(chartCard).findByText("1575")).closest(
      ".practice-dashboard__chart-yaxis",
    ) as HTMLElement;
    expect(yaxis).toBeTruthy();
    for (const value of ["1500", "1525", "1550", "1575"]) {
      expect(within(yaxis).getByText(value)).toBeTruthy();
    }
    const svg = within(chartCard).getByRole("img", { name: "Puzzle rating over time" });
    expect(svg.querySelectorAll("line")).toHaveLength(4);
    const polyline = svg.querySelector("polyline");
    const coords = polyline?.getAttribute("points")?.split(" ") ?? [];
    expect(coords).toHaveLength(10);
    for (const pair of coords) {
      expect(pair.split(",")[1]).toBe("64.9");
    }
  });

  it("keeps Y axis values as HTML outside the stretched SVG with a fixed size", async () => {
    renderPractice();
    openPracticePage("Dashboard");

    const board = dashboardRoot();
    const chartCard = within(board).getByRole("region", { name: "Puzzle rating" });
    const svg = await within(chartCard).findByRole("img", {
      name: "Puzzle rating over time",
    });
    expect(svg.getAttribute("preserveAspectRatio")).toBe("none");
    expect(svg.querySelector("text")).toBeNull();
    const yaxis = chartCard.querySelector(".practice-dashboard__chart-yaxis") as HTMLElement;
    expect(yaxis).toBeTruthy();
    expect(yaxis.closest("svg")).toBeNull();
    expect(svg.querySelector(".practice-dashboard__chart-yaxis-value")).toBeNull();

    const cssPath = join(__dirname, "..", "src", "styles", "practice-hub.css");
    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain(".practice-dashboard__chart-yaxis {");
    expect(css).toContain("font-size: var(--text-xs);");
    const [, ...rest] = css.split("@media (max-width: 899px)");
    const mobile = rest.join("@media (max-width: 899px)");
    expect(mobile).not.toContain(".practice-dashboard__chart-yaxis-value {");
    expect(mobile).not.toMatch(/\.practice-dashboard__chart-yaxis\s*\{[^}]*font-size/);
  });

  it("caps Improvement areas and Strengths at five rows without Train buttons and navigates on See all", async () => {
    renderPractice();
    openPracticePage("Dashboard");

    const areasCard = screen.getByRole("region", { name: "Improvement areas" });
    const strengthsCard = screen.getByRole("region", { name: "Strengths" });

    expect(await within(areasCard).findByText("Furthest below your 1505")).toBeTruthy();
    expect(within(strengthsCard).getByText("Furthest above your 1505")).toBeTruthy();

    const areasRows = within(areasCard).getAllByRole("listitem");
    const strengthsRows = within(strengthsCard).getAllByRole("listitem");
    expect(areasRows).toHaveLength(5);
    expect(strengthsRows).toHaveLength(5);

    // Sixth item from the response stays off Dashboard; no Train button in rows
    expect(within(areasCard).queryByText("Hanging piece")).toBeNull();
    expect(within(areasCard).queryByRole("button", { name: "Train" })).toBeNull();
    expect(within(areasRows[0] as HTMLElement).getByText("−125")).toBeTruthy();
    expect(within(strengthsRows[0] as HTMLElement).getByText("+115")).toBeTruthy();

    // See all navigates to the respective theme detail page
    fireEvent.click(within(areasCard).getByRole("button", { name: "See all" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Improvement areas" }),
    ).toBeTruthy();

    openPracticePage("Dashboard");
    fireEvent.click(within(strengthsCard).getByRole("button", { name: "See all" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Strengths" })).toBeTruthy();
  });

  it("shows empty-period copy, unranked copy, and Start a healthy mix when no theme rows apply", async () => {
    const send = vi.fn(() => true);
    const fetchThemeStats = async (days: PuzzleRatingWindow) => {
      if (days === "30") {
        return makeThemeStats({
          days: "30",
          overall: { played: 0, first_try: 0, rating_avg: null, performance: null },
          overall_previous: null,
          themes: [],
          improvement_areas: [],
          strengths: [],
          unranked: 0,
        });
      }
      if (days === "7") {
        return makeThemeStats({
          days: "7",
          overall: { played: 5, first_try: 3, rating_avg: 1485, performance: 1490 },
          overall_previous: null,
          themes: [
            themeEntry({
              theme: "fork",
              played: 5,
              first_try: 3,
              rating_avg: 1485,
              performance: 1490,
              ranked: false,
            }),
          ],
          improvement_areas: [],
          strengths: [],
          unranked: 1,
        });
      }
      return makeThemeStats({
        days,
        overall: { played: 12, first_try: 8, rating_avg: 1485, performance: 1490 },
        themes: [
          themeEntry({
            theme: "fork",
            played: 12,
            first_try: 8,
            rating_avg: 1485,
            performance: 1490,
            ranked: true,
          }),
        ],
        improvement_areas: [],
        strengths: [],
        unranked: 0,
      });
    };

    renderPractice({ send, fetchThemeStats });
    openPracticePage("Dashboard");

    const board = dashboardRoot();
    const areasCard = within(board).getByRole("region", { name: "Improvement areas" });
    const strengthsCard = within(board).getByRole("region", { name: "Strengths" });
    expect(await within(areasCard).findByText("No puzzle played in this period yet.")).toBeTruthy();
    expect(within(strengthsCard).getByText("No puzzle played in this period yet.")).toBeTruthy();

    const playedTile = within(board)
      .getByText("Played", { selector: "dt" })
      .closest(".practice-tile") as HTMLElement;
    const ratingTile = within(board)
      .getByText("Performance rating", { selector: "dt" })
      .closest(".practice-tile") as HTMLElement;
    const solvedTile = within(board)
      .getByText("Solved first try", { selector: "dt" })
      .closest(".practice-tile") as HTMLElement;
    expect(within(playedTile).getByText(NONE)).toBeTruthy();
    expect(within(ratingTile).getByText(NONE)).toBeTruthy();
    expect(within(solvedTile).getByText(NONE)).toBeTruthy();
    expect(solvedTile.querySelector(".practice-tile__split")).toBeNull();

    // 7 days: unranked message naming most played theme + count
    fireEvent.click(within(board).getByRole("button", { name: "7 days" }));
    expect(
      await within(areasCard).findByText(
        "No theme is ranked yet. A theme is ranked once you have played 8 puzzles of it; your most played theme, Fork, has 5.",
      ),
    ).toBeTruthy();

    fireEvent.click(within(areasCard).getByRole("button", { name: "Start a healthy mix" }));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "start_training", mode: "puzzles" }),
    );

    // 90 days: ranked themes exist, neither below nor above
    fireEvent.click(within(board).getByRole("button", { name: "90 days" }));
    expect(
      await within(areasCard).findByText("No ranked theme sits below your overall rating yet."),
    ).toBeTruthy();
    expect(
      within(strengthsCard).getByText("No ranked theme sits above your overall rating yet."),
    ).toBeTruthy();
  });

  it("recovers independently when theme stats or rating history fails and offers Try again", async () => {
    let failStats = true;
    let failHistory = true;
    const fetchThemeStats = vi.fn(async () => {
      if (failStats) throw new Error("stats down");
      return makeThemeStats();
    });
    const fetchRatingHistory = vi.fn(async () => {
      if (failHistory) throw new Error("history down");
      return makeHistory();
    });

    renderPractice({ fetchThemeStats, fetchRatingHistory });
    openPracticePage("Dashboard");

    const board = dashboardRoot();
    const areasCard = within(board).getByRole("region", { name: "Improvement areas" });
    const chartCard = within(board).getByRole("region", { name: "Puzzle rating" });

    expect(
      await within(areasCard).findByText("Your theme statistics could not be loaded."),
    ).toBeTruthy();
    expect(
      await within(chartCard).findByText("Your rating history could not be loaded."),
    ).toBeTruthy();

    failStats = false;
    fireEvent.click(within(areasCard).getByRole("button", { name: "Try again" }));
    expect(await within(areasCard).findByText("Fork")).toBeTruthy();
    // Rating history stays failed until retried independently
    expect(within(chartCard).getByText("Your rating history could not be loaded.")).toBeTruthy();

    failHistory = false;
    fireEvent.click(within(chartCard).getByRole("button", { name: "Try again" }));
    expect(
      await within(chartCard).findByRole("img", { name: "Puzzle rating over time" }),
    ).toBeTruthy();
  });

  it("disables training start buttons and explains why when Stockfish is missing", async () => {
    renderPractice({ engineMissing: true, dueNow: 3 });
    openPracticePage("Dashboard");

    const board = dashboardRoot();
    expect(await within(board).findByText(NEEDS_ENGINE_TEXT)).toBeTruthy();
    const review = within(board).getByRole("button", { name: "Review" }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
  });

  it("defines desktop side-by-side grids and single-column <= 899 px responsive layout cleanly", () => {
    const cssPath = join(__dirname, "..", "src", "styles", "practice-hub.css");
    const css = readFileSync(cssPath, "utf8");
    const [desktop = "", ...rest] = css.split("@media (max-width: 899px)");
    const mobile = rest.join("@media (max-width: 899px)");

    expect(desktop).toContain(
      ".practice-dashboard__tiles {\n  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));",
    );
    expect(desktop).toContain(
      ".practice-dashboard__themes {\n  display: grid;\n  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));",
    );
    expect(desktop).toContain(
      ".practice-dashboard__chart {\n  display: block;\n  width: 100%;\n  height: 140px;",
    );
    expect(desktop).toContain("grid-template-columns: minmax(0, 1fr) 40px 96px 104px;");
    expect(desktop).toContain("min-height: 48px;");

    expect(mobile).toContain(
      ".practice-dashboard__tiles,\n  .practice-dashboard__themes {\n    grid-template-columns: minmax(0, 1fr);",
    );
    expect(mobile).toContain(".practice-dashboard__link {");
    expect(mobile).toContain("min-height: 44px;");
  });

  it("moves the dashboard rules to one column at the same 899 px breakpoint as the other pages", () => {
    const css = readFileSync(join(__dirname, "..", "src", "styles", "practice-hub.css"), "utf8");
    const rule = css.indexOf(".practice-dashboard__tiles,\n  .practice-dashboard__themes {");
    expect(rule).toBeGreaterThan(-1);
    const query = css.slice(css.lastIndexOf("@media", rule)).split("{")[0];
    expect((query ?? "").trim()).toBe("@media (max-width: 899px)");
  });
});

describe("the Openings played card of the Dashboard", () => {
  const cardOf = (): HTMLElement =>
    within(dashboardRoot()).getByRole("region", { name: "Openings played" });
  const text = (row: Element, selector: string): string | undefined =>
    row.querySelector(selector)?.textContent ?? undefined;

  it("lists the four openings with the most games across both colours and both lists, each with its side", async () => {
    renderPractice();
    openPracticePage("Dashboard");

    const card = cardOf();
    expect(within(card).getByText("Most frequent in your games · win / draw / loss")).toBeTruthy();
    const list = await within(card).findByRole("list", { name: "Most played openings" });
    const rows = within(list).getAllByRole("listitem");

    // The Slav ties the Scandinavian at four games, and the stable order keeps White's list first.
    expect(rows.map((row) => text(row, ".played-top__name"))).toEqual([
      "Italian Game",
      "Queen's Gambit Declined",
      "London System",
      "Scandinavian Defense",
    ]);
    expect(rows.map((row) => text(row, ".played-top__side"))).toEqual([
      "as White",
      "as Black",
      "as Black",
      "as White",
    ]);
    expect(rows.map((row) => text(row, ".played-top__games"))).toEqual([
      "20 games",
      "8 games",
      "5 games",
      "4 games",
    ]);
    expect(rows.map((row) => text(row, ".played-score"))).toEqual([
      "Score 60%",
      "Score 31%",
      "Score 50%",
      "Score 75%",
    ]);
    expect(
      rows.map((row) => row.querySelector(".played-score")?.getAttribute("data-tone")),
    ).toEqual(["mid", "low", "low", "good"]);
    const bar = within(rows[0] as HTMLElement).getByRole("img", {
      name: "11 won, 2 drawn, 7 lost",
    });
    expect(
      [...bar.querySelectorAll<HTMLElement>(".played-bar__part")].map(
        (part) => part.dataset.outcome,
      ),
    ).toEqual(["won", "drawn", "lost"]);
  });

  it("reads the Dashboard's period and again whenever it changes", async () => {
    const fetchOpeningsPlayed = vi.fn(
      async (days: PlayedWindow): Promise<PlayedOpeningsResponse> =>
        days === "7" ? { white: PLAYED.white, black: noPlayedColour } : PLAYED,
    );
    renderPractice({ fetchOpeningsPlayed });
    openPracticePage("Dashboard");
    const card = cardOf();
    await within(card).findByRole("list", { name: "Most played openings" });
    expect(fetchOpeningsPlayed).toHaveBeenLastCalledWith("30");

    fireEvent.click(within(dashboardRoot()).getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(fetchOpeningsPlayed).toHaveBeenLastCalledWith("7"));
    await waitFor(() =>
      expect(
        within(card)
          .getAllByRole("listitem")
          .map((row) => text(row, ".played-top__name")),
      ).toEqual(["Italian Game", "Scandinavian Defense", "King's Pawn Game", "Petrov's Defense"]),
    );

    fireEvent.click(within(dashboardRoot()).getByRole("button", { name: "All" }));
    await waitFor(() => expect(fetchOpeningsPlayed).toHaveBeenLastCalledWith("all"));
  });

  it("opens the Openings played page with See all", async () => {
    renderPractice();
    openPracticePage("Dashboard");
    const card = cardOf();
    await within(card).findByRole("list", { name: "Most played openings" });

    fireEvent.click(within(card).getByRole("button", { name: "See all" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Openings played" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Dashboard" })).toBeNull();
  });

  it("says No game in this period yet. when no game was played, keeping the card and its link", async () => {
    renderPractice({ fetchOpeningsPlayed: async () => NO_PLAYED });
    openPracticePage("Dashboard");

    const card = cardOf();
    expect(await within(card).findByText("No game in this period yet.")).toBeTruthy();
    expect(within(card).queryByRole("list")).toBeNull();
    expect(within(card).getByRole("button", { name: "See all" })).toBeTruthy();
  });

  it("says the openings could not be loaded, reads again on Try again and leaves the other cards alone", async () => {
    let failing = true;
    const fetchOpeningsPlayed = vi.fn(
      async (_days: PlayedWindow): Promise<PlayedOpeningsResponse> => {
        if (failing) throw new Error("down");
        return PLAYED;
      },
    );
    renderPractice({ fetchOpeningsPlayed });
    openPracticePage("Dashboard");

    const card = cardOf();
    expect((await within(card).findByRole("alert")).textContent).toBe(
      "Your openings could not be loaded.",
    );
    const areas = within(dashboardRoot()).getByRole("region", { name: "Improvement areas" });
    expect(await within(areas).findByText("Fork")).toBeTruthy();

    failing = false;
    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(await within(card).findByRole("list", { name: "Most played openings" })).toBeTruthy();
    expect(within(card).queryByRole("alert")).toBeNull();
  });
});

describe("the design checklist", () => {
  const checklist = readFileSync(join(import.meta.dirname, "../DESIGN-CHECK.md"), "utf8");

  it("records the Dashboard in the Practice and Phone columns with its 48 px theme rows", () => {
    const record = checklist
      .split("\n- ")
      .find((item) => item.startsWith("**Dashboard** (`Practice` and `Phone` columns)"));
    expect(record).toBeDefined();
    expect(record).toContain("`48px` theme rows");
    expect(record).toContain("Puzzle rating");
    expect(record).toContain("Under 900 px");
    expect(record).toContain("Y axis");
    expect(record).toContain("gridline");
  });
});
