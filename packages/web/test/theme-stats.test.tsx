import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PuzzleRatingWindow, ThemeStatsResponse } from "@chess-coach/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Practice } from "../src/screens/Practice.js";
import { motifLabel } from "../src/state/practice.js";
import { PRACTICE_PAGE_STORAGE_KEY } from "../src/state/practice-page.js";
import {
  fetchThemeStatsFromServer,
  firstTryBarToneOf,
  mostPlayedThemeOf,
  themeDisplayOf,
} from "../src/state/theme-stats-api.js";
import { openPracticePage, progressOf } from "./practice-fixtures.js";
import { serverApi } from "./server-api.js";

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PRACTICE_PAGE_STORAGE_KEY);
  vi.unstubAllGlobals();
});

const baseHubProps = {
  fetchMotifs: async () => [],
  fetchProgress: async () => progressOf(),
  fetchRepertoires: async () => [],
  fetchOpeningDrills: async () => ({ white: [], black: [] }),
};

function statsFixture(overrides: Partial<ThemeStatsResponse> = {}): ThemeStatsResponse {
  return {
    days: "30",
    overall: {
      played: 64,
      first_try: 41,
      rating_avg: 1410,
      performance: 1420,
    },
    overall_previous: null,
    themes: [
      {
        theme: "pin",
        played: 16,
        first_try: 8,
        rating_avg: 1290,
        performance: 1270,
        ranked: true,
      },
      {
        theme: "fork",
        played: 14,
        first_try: 10,
        rating_avg: 1490,
        performance: 1550,
        ranked: true,
      },
      {
        theme: "xRayAttack",
        played: 12,
        first_try: 7,
        rating_avg: 1360,
        performance: 1340,
        ranked: true,
      },
      {
        theme: "quietMove",
        played: 10,
        first_try: 3,
        rating_avg: 1390,
        performance: 1250,
        ranked: true,
      },
      {
        theme: "mate",
        played: 9,
        first_try: 8,
        rating_avg: 1480,
        performance: 1620,
        ranked: true,
      },
      {
        theme: "mateIn4",
        played: 5,
        first_try: 2,
        rating_avg: 1510,
        performance: 1400,
        ranked: false,
      },
    ],
    improvement_areas: ["quietMove", "pin", "xRayAttack"],
    strengths: ["mate", "fork"],
    unranked: 1,
    ...overrides,
  };
}

function visibleRows(): HTMLElement[] {
  const list = screen.getByRole("list", { name: /^(Improvement areas|Strengths)$/ });
  return within(list).getAllByRole("listitem");
}

function activePagePanel(): HTMLElement {
  const heading = screen.getByRole("heading", { level: 2 });
  return heading.closest(".practice-page") as HTMLElement;
}

describe("theme-stats API and helpers", () => {
  it("fetches /api/puzzles/themes/stats for the chosen window, parses the schema and rejects errors", async () => {
    const payload = statsFixture({ days: "90" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => payload })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ invalid: true }) })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchThemeStatsFromServer("90")).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/puzzles/themes/stats?days=90");
    await expect(fetchThemeStatsFromServer("all")).rejects.toThrow();
    await expect(fetchThemeStatsFromServer("7")).rejects.toThrow("theme stats: 503");
  });

  it("maps Lichess keys, bar tones and rankable closest themes", () => {
    expect(themeDisplayOf("mate")).toEqual({
      name: "Checkmate",
      description: "Find the forcing line that ends the game.",
    });
    expect(themeDisplayOf("mateIn4").name).toBe("Mate in 4+");
    expect(themeDisplayOf("quietMove").description).toBe("No check, no capture, but unstoppable.");
    expect(firstTryBarToneOf(70)).toBe("good");
    expect(firstTryBarToneOf(69)).toBe("mid");
    expect(firstTryBarToneOf(55)).toBe("mid");
    expect(firstTryBarToneOf(54)).toBe("low");

    const pick = mostPlayedThemeOf([
      {
        theme: "short",
        played: 18,
        first_try: 9,
        rating_avg: 1300,
        performance: 1300,
        ranked: false,
      },
      {
        theme: "capturingDefender",
        played: 6,
        first_try: 4,
        rating_avg: 1320,
        performance: 1350,
        ranked: false,
      },
    ]);
    expect(pick?.theme).toBe("capturingDefender");
  });
});

describe("Improvement areas and Strengths pages", () => {
  it("opens on 30 days, renders Improvement areas in server order with diffs, bars, subtitles and footer", async () => {
    const fetchThemeStats = vi.fn(async (days: PuzzleRatingWindow) => statsFixture({ days }));
    render(
      <Practice server={serverApi(null)} {...baseHubProps} fetchThemeStats={fetchThemeStats} />,
    );

    // Lazy until opened: overview mount does not fetch theme stats.
    expect(fetchThemeStats).not.toHaveBeenCalled();

    openPracticePage("Improvement areas");
    await waitFor(() => expect(fetchThemeStats).toHaveBeenCalledWith("30"));

    const title = screen.getByRole("heading", { level: 2, name: "Improvement areas" });
    const page = title.closest(".practice-page") as HTMLElement;
    expect(page.textContent).toContain(
      "Themes where your rating is furthest below your overall 1420. Train these first. Up to 8 themes, each with 8 or more played.",
    );

    const periodGroup = within(page).getByRole("group", { name: "Time window" });
    const periodButtons = within(periodGroup).getAllByRole("button");
    expect(periodButtons.map((b) => b.textContent)).toEqual([
      "7 days",
      "30 days",
      "90 days",
      "All",
    ]);
    expect(
      within(periodGroup).getByRole("button", { name: "30 days" }).getAttribute("aria-pressed"),
    ).toBe("true");

    const rows = visibleRows();
    expect(rows.map((r) => r.getAttribute("data-theme"))).toEqual([
      "quietMove",
      "pin",
      "xRayAttack",
    ]);

    const quietRow = rows[0] as HTMLElement;
    expect(quietRow.textContent).toContain("Quiet move");
    expect(quietRow.textContent).toContain("No check, no capture, but unstoppable.");
    expect(quietRow.textContent).toContain("10");
    expect(quietRow.textContent).toContain("1250");
    expect(quietRow.textContent).toContain("−170");
    expect(quietRow.textContent).toContain("30%");
    const quietDelta = quietRow.querySelector(".practice-themes__delta");
    expect(quietDelta?.getAttribute("data-direction")).toBe("down");
    const quietFill = quietRow.querySelector(".practice-themes__bar-fill") as HTMLElement;
    expect(quietFill.getAttribute("data-tone")).toBe("low");
    expect(quietFill.style.width).toBe("30%");
    expect(within(quietRow).getByRole("button", { name: "Train" })).toBeTruthy();

    // Check green (>= 70) and amber (55..69) thresholds cleanly on X-ray (7/12 = 58%) & Strengths.
    const xrayFill = (rows[2] as HTMLElement).querySelector(
      ".practice-themes__bar-fill",
    ) as HTMLElement;
    expect(xrayFill.getAttribute("data-tone")).toBe("mid");

    expect(page.textContent).toContain(
      "1 of the 6 themes you played have fewer than 8 puzzles and are not ranked yet.",
    );
  });

  it("renders Strengths in server order with positive signed diffs, green tones and Strengths subtitle", async () => {
    const fetchThemeStats = vi.fn(async (days: PuzzleRatingWindow) => statsFixture({ days }));
    render(
      <Practice server={serverApi(null)} {...baseHubProps} fetchThemeStats={fetchThemeStats} />,
    );

    openPracticePage("Strengths");
    await waitFor(() => expect(fetchThemeStats).toHaveBeenCalledWith("30"));

    const page = activePagePanel();
    expect(page.textContent).toContain(
      "Themes where your rating is furthest above your overall 1420. Up to 8 themes, each with 8 or more played.",
    );

    const rows = visibleRows();
    expect(rows.map((r) => r.getAttribute("data-theme"))).toEqual(["mate", "fork"]);

    const mateRow = rows[0] as HTMLElement;
    expect(mateRow.textContent).toContain("Checkmate");
    expect(mateRow.textContent).toContain("Find the forcing line that ends the game.");
    expect(mateRow.textContent).toContain("1620");
    expect(mateRow.textContent).toContain("+200");
    expect(mateRow.textContent).toContain("89%");
    expect(mateRow.querySelector(".practice-themes__delta")?.getAttribute("data-direction")).toBe(
      "up",
    );
    expect(mateRow.querySelector(".practice-themes__bar-fill")?.getAttribute("data-tone")).toBe(
      "good",
    );

    const forkFill = (rows[1] as HTMLElement).querySelector(
      ".practice-themes__bar-fill",
    ) as HTMLElement;
    // 10/14 = 71% -> green
    expect(forkFill.getAttribute("data-tone")).toBe("good");
  });

  it("fetches the chosen window when selecting 7 days, 90 days or All", async () => {
    const fetchThemeStats = vi.fn(async (days: PuzzleRatingWindow) => {
      if (days === "90") {
        return statsFixture({
          days: "90",
          overall: { played: 80, first_try: 52, rating_avg: 1450, performance: 1460 },
          improvement_areas: ["pin"],
          unranked: 2,
        });
      }
      return statsFixture({ days });
    });

    render(
      <Practice server={serverApi(null)} {...baseHubProps} fetchThemeStats={fetchThemeStats} />,
    );
    openPracticePage("Improvement areas");
    await screen.findByText("Quiet move");

    const periodGroup = within(activePagePanel()).getByRole("group", { name: "Time window" });
    fireEvent.click(within(periodGroup).getByRole("button", { name: "90 days" }));
    await waitFor(() => expect(fetchThemeStats).toHaveBeenCalledWith("90"));

    expect(
      within(periodGroup).getByRole("button", { name: "90 days" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await waitFor(() =>
      expect(visibleRows().map((r) => r.getAttribute("data-theme"))).toEqual(["pin"]),
    );
    expect(activePagePanel().textContent).toContain("your overall 1460.");
    expect(activePagePanel().textContent).toContain("2 of the 6 themes you played");

    fireEvent.click(within(periodGroup).getByRole("button", { name: "All" }));
    await waitFor(() => expect(fetchThemeStats).toHaveBeenCalledWith("all"));

    fireEvent.click(within(periodGroup).getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(fetchThemeStats).toHaveBeenCalledWith("7"));
  });

  it("names a theme the table does not hold from its key and trains that key", async () => {
    const key = "someNewLichessTheme";
    const server = serverApi(null);
    const fetchThemeStats = vi.fn(async (days: PuzzleRatingWindow) =>
      statsFixture({
        days,
        themes: [
          {
            theme: key,
            played: 12,
            first_try: 6,
            rating_avg: 1300,
            performance: 1300,
            ranked: true,
          },
        ],
        improvement_areas: [key],
        strengths: [],
        unranked: 0,
      }),
    );

    render(<Practice server={server} {...baseHubProps} fetchThemeStats={fetchThemeStats} />);
    openPracticePage("Improvement areas");
    await waitFor(() => expect(fetchThemeStats).toHaveBeenCalledWith("30"));

    const name = motifLabel(key);
    expect(name).not.toBe("");
    expect(name).not.toBe(key);
    const row = (await screen.findByText(name)).closest("li") as HTMLElement;
    expect(row.getAttribute("data-theme")).toBe(key);

    fireEvent.click(within(row).getByRole("button", { name: "Train" }));
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "puzzles",
      motif: key,
    });
  });

  it("sends start_training with mode puzzles and the row's theme when Train is pressed", async () => {
    const server = serverApi(null);
    const fetchThemeStats = vi.fn(async (days: PuzzleRatingWindow) => statsFixture({ days }));

    const view = render(
      <Practice server={server} {...baseHubProps} fetchThemeStats={fetchThemeStats} />,
    );
    openPracticePage("Improvement areas");
    await screen.findByText("X-ray");

    const xrayRow = visibleRows()[2] as HTMLElement;
    const trainBtn = within(xrayRow).getByRole("button", { name: "Train" });
    fireEvent.click(trainBtn);

    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "puzzles",
      motif: "xRayAttack",
    });
    expect(within(xrayRow).getByRole("button", { name: "Starting" })).toBeTruthy();

    // A refused start shows the alert on this page rather than leaking elsewhere.
    view.rerender(
      <Practice
        server={{
          ...server,
          errorCount: 1,
          lastError: "no puzzle matches",
          lastErrorCode: "empty_queue",
        }}
        {...baseHubProps}
        fetchThemeStats={fetchThemeStats}
      />,
    );
    expect((await within(activePagePanel()).findByRole("alert")).textContent).toContain(
      "There are no X-ray puzzles",
    );
  });

  it("shows the played-but-unranked empty state with most played rankable theme and Start a healthy mix", async () => {
    const server = serverApi(null);
    const fetchThemeStats = vi.fn(async (days: PuzzleRatingWindow) =>
      statsFixture({
        days,
        overall: { played: 7, first_try: 4, rating_avg: 1350, performance: 1380 },
        themes: [
          {
            theme: "short",
            played: 7,
            first_try: 4,
            rating_avg: 1350,
            performance: 1380,
            ranked: false,
          },
          {
            theme: "capturingDefender",
            played: 5,
            first_try: 3,
            rating_avg: 1340,
            performance: 1360,
            ranked: false,
          },
          {
            theme: "pin",
            played: 2,
            first_try: 1,
            rating_avg: 1300,
            performance: 1290,
            ranked: false,
          },
        ],
        improvement_areas: [],
        strengths: [],
        unranked: 3,
      }),
    );

    render(<Practice server={server} {...baseHubProps} fetchThemeStats={fetchThemeStats} />);
    openPracticePage("Improvement areas");

    const page = activePagePanel();
    await waitFor(() =>
      expect(page.textContent).toContain(
        "No theme is ranked yet. A theme is ranked once you have played 8 puzzles of it; your most played theme, Capture the defender, has 5.",
      ),
    );
    expect(page.textContent).not.toContain("have fewer than 8 puzzles and are not ranked yet");

    fireEvent.click(within(page).getByRole("button", { name: "Start a healthy mix" }));
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "puzzles",
    });
  });

  it("shows the no-puzzles-played empty state when overall.played is 0", async () => {
    const server = serverApi(null);
    const fetchThemeStats = vi.fn(async (days: PuzzleRatingWindow) =>
      statsFixture({
        days,
        overall: { played: 0, first_try: 0, rating_avg: null, performance: null },
        themes: [],
        improvement_areas: [],
        strengths: [],
        unranked: 0,
      }),
    );

    render(<Practice server={server} {...baseHubProps} fetchThemeStats={fetchThemeStats} />);
    openPracticePage("Strengths");

    const page = activePagePanel();
    await waitFor(() => expect(page.textContent).toContain("No puzzle played in this period yet."));
    expect(page.textContent).toContain("overall rating.");
    fireEvent.click(within(page).getByRole("button", { name: "Start a healthy mix" }));
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "puzzles",
    });
  });

  it("shows loading status then recovers from a failed fetch via Try again", async () => {
    let release!: (value: ThemeStatsResponse) => void;
    const fetchThemeStats = vi
      .fn<() => Promise<ThemeStatsResponse>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockImplementationOnce(
        () =>
          new Promise<ThemeStatsResponse>((resolve) => {
            release = resolve;
          }),
      );

    render(
      <Practice server={serverApi(null)} {...baseHubProps} fetchThemeStats={fetchThemeStats} />,
    );
    openPracticePage("Improvement areas");

    const page = activePagePanel();
    const alert = await within(page).findByRole("alert");
    expect(alert.textContent).toBe("Your theme statistics could not be loaded.");

    fireEvent.click(within(page).getByRole("button", { name: "Try again" }));
    expect(within(page).getByRole("status").textContent).toBe("Loading your theme statistics.");

    release(statsFixture());
    await within(page).findByText("Quiet move");
  });

  it("uses prototype desktop grid sizes and drops description and bar under 900 px", () => {
    const css = readFileSync(join(import.meta.dirname, "../src/styles/practice-hub.css"), "utf8");
    const phoneAt = css.indexOf("@media (max-width: 899px)");
    const desktop = css.slice(0, phoneAt);
    const phone = css.slice(phoneAt);

    expect(desktop).toContain("grid-template-columns: minmax(0, 1fr) 56px 104px 140px 104px;");
    expect(desktop).toContain("gap: var(--space-4);");
    expect(desktop).toContain("min-height: 56px;");
    expect(phone).toContain(".practice-themes__desc");
    expect(phone).toContain(".practice-themes__bar");
    expect(phone).toContain("display: none;");
    expect(phone).toContain(".practice-themes__train");
    expect(phone).toContain("min-height: 44px;");
  });
});
