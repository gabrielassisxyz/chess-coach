import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIX_PRACTICE_MOTIF,
  PUZZLE_THEME_GROUPS,
  PUZZLE_THEMES,
  type ThemeStatsEntry,
  type ThemeStatsResponse,
} from "@chess-coach/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PracticeThemes, type PracticeThemesProps } from "../src/components/PracticeThemes.js";
import {
  PracticeWeakness,
  type PracticeWeaknessProps,
} from "../src/components/PracticeWeakness.js";
import type { Loaded } from "../src/hooks/useLoaded.js";
import { Practice } from "../src/screens/Practice.js";
import { startFailureText } from "../src/state/practice.js";
import { PRACTICE_PAGE_STORAGE_KEY } from "../src/state/practice-page.js";
import { progressOf } from "./practice-fixtures.js";
import { serverApi } from "./server-api.js";

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PRACTICE_PAGE_STORAGE_KEY);
  vi.unstubAllGlobals();
});

const entryOf = (
  theme: string,
  played: number,
  firstTry: number,
  performance: number,
  ranked = true,
): ThemeStatsEntry => ({
  theme,
  played,
  first_try: firstTry,
  rating_avg: performance,
  performance,
  ranked,
});

// A 30-day answer. Its first-try shares sit on the edges of the three bands (fork 70, hangingPiece
// 69, skewer 55, queenEndgame 54), `mate` is a theme the table does not hold, and seven themes are
// improvement areas, two more than the card has rows for.
function statsOf(overrides: Partial<ThemeStatsResponse> = {}): ThemeStatsResponse {
  return {
    days: "30",
    overall: { played: 64, first_try: 41, rating_avg: 1290, performance: 1281 },
    overall_previous: null,
    themes: [
      entryOf("fork", 20, 14, 1500),
      entryOf("queenEndgame", 50, 27, 1300),
      entryOf("pin", 16, 8, 1270),
      entryOf("hangingPiece", 13, 9, 1400),
      entryOf("sacrifice", 13, 5, 1103),
      entryOf("kingsideAttack", 13, 6, 1133),
      entryOf("mateIn2", 11, 5, 1237),
      entryOf("skewer", 11, 6, 1350),
      entryOf("discoveredAttack", 10, 4, 1095),
      entryOf("quietMove", 10, 3, 1250),
      entryOf("mate", 9, 8, 1620),
      entryOf("deflection", 8, 3, 1087),
      entryOf("mateIn4", 5, 2, 1400, false),
    ],
    improvement_areas: [
      "deflection",
      "discoveredAttack",
      "sacrifice",
      "kingsideAttack",
      "mateIn2",
      "quietMove",
      "pin",
    ],
    strengths: ["mate", "fork"],
    unranked: 1,
    ...overrides,
  };
}

const ready = (value: ThemeStatsResponse): Loaded<ThemeStatsResponse> => ({
  status: "ready",
  value,
});

function themesProps(overrides: Partial<PracticeThemesProps> = {}): PracticeThemesProps {
  return {
    themeStats: ready(statsOf()),
    starting: null,
    engineMissing: false,
    onStart: vi.fn(),
    themesRef: null,
    ...overrides,
  };
}

function weaknessProps(overrides: Partial<PracticeWeaknessProps> = {}): PracticeWeaknessProps {
  return {
    themeStats: ready(statsOf()),
    starting: null,
    engineMissing: false,
    onStart: vi.fn(),
    ...overrides,
  };
}

// Twelve of the thirteen entries of the answer are themes of the table; `mate` is not one of them.
const TRIED_OF_TABLE = 12;

const section = (): HTMLElement => screen.getByRole("region", { name: "Puzzle themes" });
const tileOf = (key: string): HTMLElement =>
  section().querySelector(`.theme-tile[data-theme="${key}"]`) as HTMLElement;
const statOf = (key: string): HTMLElement | null => tileOf(key).querySelector(".theme-tile__stat");
const mixCard = (): HTMLElement => within(section()).getByRole("button", { name: /^Healthy mix/ });
const weaknessCard = (): HTMLElement => screen.getByRole("region", { name: "Puzzles by weakness" });
const rowsOf = (): HTMLElement[] => within(weaknessCard()).getAllByRole("radio");

describe("the Puzzle themes section", () => {
  it("shows its title and a note counting the themes of the table that the answer lists, out of 54", () => {
    render(<PracticeThemes {...themesProps()} />);
    expect(within(section()).getByRole("heading", { name: "Puzzle themes" })).toBeTruthy();
    // `mate` is listed too, but it is not one of the 54 and adds nothing to the count.
    expect(PUZZLE_THEMES.some((entry) => entry.theme === "mate")).toBe(false);
    expect(statsOf().themes).toHaveLength(TRIED_OF_TABLE + 1);
    expect(section().querySelector(".theme-tiles__note")?.textContent).toBe(
      "Your first-try rate per theme, last 30 days · grey: not tried yet · 12 of 54 themes tried",
    );
    expect(PUZZLE_THEMES).toHaveLength(54);
  });

  it("counts none of the 54 as tried when the answer lists none", () => {
    render(
      <PracticeThemes
        {...themesProps({
          themeStats: ready(statsOf({ themes: [], improvement_areas: [], strengths: [] })),
        })}
      />,
    );
    expect(section().querySelector(".theme-tiles__note")?.textContent).toContain(
      "0 of 54 themes tried",
    );
  });

  it.each<[string, Loaded<ThemeStatsResponse> | undefined]>([
    ["is loading", { status: "loading" }],
    ["could not be read", { status: "failed", retry: vi.fn() }],
    ["was never asked for", undefined],
  ])(
    "leaves the count out of the note and every figure off the tiles while the answer %s",
    (_when, themeStats) => {
      render(<PracticeThemes {...themesProps({ themeStats })} />);
      expect(section().querySelector(".theme-tiles__note")?.textContent).toBe(
        "Your first-try rate per theme, last 30 days · grey: not tried yet",
      );
      expect(section().querySelectorAll(".theme-tile")).toHaveLength(54);
      expect(section().querySelectorAll(".theme-tile__stat")).toHaveLength(0);
      expect(within(section()).queryByText("new")).toBeNull();
      expect(within(mixCard()).queryByText(/%/)).toBeNull();
    },
  );

  it("draws the 54 tiles under the table's six groups, in the table's order", () => {
    render(<PracticeThemes {...themesProps()} />);
    const groups = within(section()).getAllByRole("group");
    for (const group of groups) {
      const heading = within(group).getByRole("heading", { level: 4 });
      expect(group.getAttribute("aria-labelledby")).toBe(heading.id);
    }
    expect(
      groups.map((group) => within(group).getByRole("heading", { level: 4 }).textContent),
    ).toEqual([...PUZZLE_THEME_GROUPS]);
    PUZZLE_THEME_GROUPS.forEach((name, index) => {
      const drawn = [...(groups[index] as HTMLElement).querySelectorAll(".theme-tile")].map(
        (tile) => tile.getAttribute("data-theme"),
      );
      const table = PUZZLE_THEMES.filter((entry) => entry.group === name).map(
        (entry) => entry.theme,
      );
      expect(drawn).toEqual(table);
      expect(table.length).toBeGreaterThan(0);
    });
    expect(section().querySelectorAll(".theme-tile")).toHaveLength(54);
  });

  it("names each tile from the table and describes it under the name", () => {
    render(<PracticeThemes {...themesProps()} />);
    for (const entry of PUZZLE_THEMES) {
      const tile = tileOf(entry.theme);
      expect(tile.querySelector(".theme-tile__name")?.textContent).toBe(entry.name);
      expect(tile.querySelector(".theme-tile__desc")?.textContent).toBe(entry.description);
    }
  });

  it("shows each listed theme's first-try share in the colour of its band, from 70 and 55", () => {
    render(<PracticeThemes {...themesProps()} />);
    const bands: [string, string, string][] = [
      ["fork", "70%", "good"],
      ["hangingPiece", "69%", "mid"],
      ["skewer", "55%", "mid"],
      ["queenEndgame", "54%", "low"],
      ["pin", "50%", "low"],
      ["deflection", "38%", "low"],
    ];
    for (const [key, text, tone] of bands) {
      expect(statOf(key)?.textContent).toBe(text);
      expect(statOf(key)?.getAttribute("data-tone")).toBe(tone);
    }
  });

  it("says new, in the faintest tone, on a theme the answer does not list, and only on those", () => {
    render(<PracticeThemes {...themesProps()} />);
    const listed = new Set(statsOf().themes.map((entry) => entry.theme));
    for (const entry of PUZZLE_THEMES) {
      const stat = statOf(entry.theme);
      if (listed.has(entry.theme)) {
        expect(stat?.textContent).not.toBe("new");
      } else {
        expect(stat?.textContent).toBe("new");
        expect(stat?.getAttribute("data-tone")).toBe("new");
      }
    }
    expect(section().querySelectorAll('.theme-tile__stat[data-tone="new"]')).toHaveLength(
      54 - TRIED_OF_TABLE,
    );
  });

  it("starts the queue of each theme, pressed by its tile, naming that theme and nothing else", () => {
    const onStart = vi.fn();
    render(<PracticeThemes {...themesProps({ onStart })} />);
    for (const entry of PUZZLE_THEMES) fireEvent.click(tileOf(entry.theme));
    expect(onStart.mock.calls).toEqual(PUZZLE_THEMES.map((entry) => ["puzzles", entry.theme]));
  });

  it("marks the tile whose start is in flight and holds every control until the board answers", () => {
    render(<PracticeThemes {...themesProps({ starting: { mode: "puzzles", motif: "pin" } })} />);
    expect(statOf("pin")?.textContent).toBe("Starting");
    expect(statOf("fork")?.textContent).toBe("70%");
    for (const control of section().querySelectorAll("button")) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
    }
    expect(within(mixCard()).queryByText("Starting")).toBeNull();
  });

  it("holds every control and says why while the engine is missing", () => {
    render(<PracticeThemes {...themesProps({ engineMissing: true })} />);
    expect(within(section()).getByText("Needs the engine to grade answers.")).toBeTruthy();
    for (const control of section().querySelectorAll("button")) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe("the Healthy mix card", () => {
  const APPROVED =
    "A bit of everything at your level, with more from your improvement areas. No hint of what is coming, like a real game.";

  it("shows the approved sentence and the share solved first try over the games played", () => {
    render(<PracticeThemes {...themesProps()} />);
    const card = mixCard();
    expect(card.querySelector(".healthy-mix__title")?.textContent).toBe("Healthy mix");
    expect(card.querySelector(".healthy-mix__desc")?.textContent).toBe(APPROVED);
    // 41 of 64 is 64.06 percent.
    expect(card.querySelector(".healthy-mix__rate")?.textContent).toBe("64%");
    expect(card.querySelector(".healthy-mix__start")?.textContent).toBe("Start");
  });

  it("rounds the share to the nearest whole percent", () => {
    const overall = { played: 3, first_try: 2, rating_avg: 1200, performance: 1200 };
    render(<PracticeThemes {...themesProps({ themeStats: ready(statsOf({ overall })) })} />);
    expect(mixCard().querySelector(".healthy-mix__rate")?.textContent).toBe("67%");
  });

  it("shows no percentage when nothing was played, and still offers the start", () => {
    const overall = { played: 0, first_try: 0, rating_avg: null, performance: null };
    render(
      <PracticeThemes {...themesProps({ themeStats: ready(statsOf({ overall, themes: [] })) })} />,
    );
    expect(mixCard().querySelector(".healthy-mix__rate")).toBeNull();
    expect(mixCard().textContent).not.toMatch(/%/);
    expect((mixCard() as HTMLButtonElement).disabled).toBe(false);
  });

  it("starts a puzzle queue with no motif when it is pressed, and reads Starting meanwhile", () => {
    const onStart = vi.fn();
    const view = render(<PracticeThemes {...themesProps({ onStart })} />);
    fireEvent.click(mixCard());
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith("puzzles", "");

    view.rerender(
      <PracticeThemes {...themesProps({ onStart, starting: { mode: "puzzles", motif: "" } })} />,
    );
    expect(mixCard().querySelector(".healthy-mix__start")?.textContent).toBe("Starting");
    expect((mixCard() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the Puzzles by weakness card", () => {
  it("heads its rows with the overall rating of the window and what it ranks", () => {
    render(<PracticeWeakness {...weaknessProps()} />);
    const card = weaknessCard();
    expect(within(card).getByRole("heading", { name: "Puzzles by weakness" })).toBeTruthy();
    expect(card.querySelector(".practice__card-note")?.textContent).toBe(
      "Your rating per theme vs your overall 1281 · last 30 days · only themes with 8 or more played",
    );
  });

  it("names the yardstick plainly while the overall rating is not known", () => {
    render(<PracticeWeakness {...weaknessProps({ themeStats: { status: "loading" } })} />);
    expect(weaknessCard().querySelector(".practice__card-note")?.textContent).toBe(
      "Your rating per theme vs your overall rating · last 30 days · only themes with 8 or more played",
    );
  });

  it("lists the first five improvement areas, the weakest first, each with name, rating, bar and share", () => {
    render(<PracticeWeakness {...weaknessProps()} />);
    const rows = rowsOf();
    expect(rows).toHaveLength(5);
    const cells = rows.map((row) => [
      row.querySelector(".practice-weakness__name")?.textContent,
      row.querySelector(".practice-weakness__rating")?.textContent,
      (row.querySelector(".practice-weakness__bar-fill") as HTMLElement).style.width,
      row.querySelector(".practice-weakness__percent")?.textContent,
    ]);
    expect(cells).toEqual([
      ["Deflection", "1087", "38%", "38%"],
      ["Discovered attack", "1095", "40%", "40%"],
      ["Sacrifice", "1103", "38%", "38%"],
      ["Kingside attack", "1133", "46%", "46%"],
      ["Mate in 2", "1237", "45%", "45%"],
    ]);
    // The sixth and seventh areas are left out.
    expect(within(weaknessCard()).queryByRole("radio", { name: /^Quiet move/ })).toBeNull();
    expect(within(weaknessCard()).queryByRole("radio", { name: /^Pin/ })).toBeNull();
  });

  it("colours each bar by the band of its share, as the theme pages do", () => {
    const themes = [
      entryOf("fork", 20, 14, 1000),
      entryOf("hangingPiece", 13, 9, 1010),
      entryOf("skewer", 11, 6, 1020),
      entryOf("pin", 16, 8, 1030),
    ];
    render(
      <PracticeWeakness
        {...weaknessProps({
          themeStats: ready(
            statsOf({ themes, improvement_areas: ["fork", "hangingPiece", "skewer", "pin"] }),
          ),
        })}
      />,
    );
    const tones = rowsOf().map((row) =>
      row.querySelector(".practice-weakness__bar-fill")?.getAttribute("data-tone"),
    );
    expect(tones).toEqual(["good", "mid", "mid", "low"]);
  });

  it("selects the first row at first and moves the selection to the row that is pressed", () => {
    render(<PracticeWeakness {...weaknessProps()} />);
    const checked = (): (string | null)[] =>
      rowsOf().map((row) => row.getAttribute("aria-checked"));
    expect(checked()).toEqual(["true", "false", "false", "false", "false"]);
    fireEvent.click(rowsOf()[3] as HTMLElement);
    expect(checked()).toEqual(["false", "false", "false", "true", "false"]);
    fireEvent.click(rowsOf()[0] as HTMLElement);
    expect(checked()).toEqual(["true", "false", "false", "false", "false"]);
    expect(within(weaknessCard()).getByRole("radiogroup", { name: "Theme to train" })).toBeTruthy();
  });

  it("trains the selected theme, named in lower case, and not the first one once another is selected", () => {
    const onStart = vi.fn();
    render(<PracticeWeakness {...weaknessProps({ onStart })} />);
    fireEvent.click(within(weaknessCard()).getByRole("button", { name: "Train deflection" }));
    expect(onStart).toHaveBeenLastCalledWith("puzzles", "deflection");

    fireEvent.click(rowsOf()[1] as HTMLElement);
    expect(within(weaknessCard()).queryByRole("button", { name: "Train deflection" })).toBeNull();
    fireEvent.click(
      within(weaknessCard()).getByRole("button", { name: "Train discovered attack" }),
    );
    expect(onStart).toHaveBeenLastCalledWith("puzzles", "discoveredAttack");
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it("starts the mix of the weak themes, which names none of them, from Mix practice", () => {
    const onStart = vi.fn();
    render(<PracticeWeakness {...weaknessProps({ onStart })} />);
    fireEvent.click(rowsOf()[2] as HTMLElement);
    fireEvent.click(within(weaknessCard()).getByRole("button", { name: "Mix practice" }));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith("puzzles", "mix-practice");
    expect(MIX_PRACTICE_MOTIF).toBe("mix-practice");
  });

  it("reads Starting on the button whose queue is on its way and holds the other one", () => {
    const view = render(
      <PracticeWeakness
        {...weaknessProps({ starting: { mode: "puzzles", motif: "deflection" } })}
      />,
    );
    const card = weaknessCard();
    expect(
      (within(card).getByRole("button", { name: "Starting" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(card).getByRole("button", { name: "Mix practice" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    view.rerender(
      <PracticeWeakness
        {...weaknessProps({ starting: { mode: "puzzles", motif: MIX_PRACTICE_MOTIF } })}
      />,
    );
    expect(within(card).getByRole("button", { name: "Train deflection" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Mix practice" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Starting" })).toBeTruthy();
  });

  it("holds both buttons and says why while the engine is missing", () => {
    render(<PracticeWeakness {...weaknessProps({ engineMissing: true })} />);
    const card = weaknessCard();
    expect(within(card).getByText("Needs the engine to grade answers.")).toBeTruthy();
    for (const name of ["Train deflection", "Mix practice"]) {
      expect((within(card).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  describe("with no improvement area", () => {
    const unranked = statsOf({
      overall: { played: 7, first_try: 4, rating_avg: 1350, performance: 1380 },
      themes: [
        entryOf("short", 7, 4, 1380, false),
        entryOf("capturingDefender", 5, 3, 1360, false),
        entryOf("pin", 2, 1, 1290, false),
      ],
      improvement_areas: [],
      strengths: [],
      unranked: 3,
    });

    it("says no theme is ranked yet, names the most played one with its count, and offers a healthy mix", () => {
      const onStart = vi.fn();
      render(<PracticeWeakness {...weaknessProps({ themeStats: ready(unranked), onStart })} />);
      const card = weaknessCard();
      expect(card.textContent).toContain(
        "No theme is ranked yet. A theme is ranked once you have played 8 puzzles of it; your most played theme, Capture the defender, has 5.",
      );
      expect(within(card).queryByRole("radio")).toBeNull();
      expect(within(card).queryByRole("button", { name: "Mix practice" })).toBeNull();
      expect(within(card).queryByRole("button", { name: /^Train / })).toBeNull();
      fireEvent.click(within(card).getByRole("button", { name: "Start a healthy mix" }));
      expect(onStart).toHaveBeenCalledWith("puzzles", "");
    });

    it("says so when ranked themes exist but none sits below the overall rating", () => {
      const above = statsOf({ improvement_areas: [] });
      render(<PracticeWeakness {...weaknessProps({ themeStats: ready(above) })} />);
      expect(weaknessCard().textContent).toContain(
        "No ranked theme sits below your overall rating yet.",
      );
      expect(
        within(weaknessCard()).getByRole("button", { name: "Start a healthy mix" }),
      ).toBeTruthy();
    });

    it("says nothing was played when the window holds no attempt", () => {
      const none = statsOf({
        overall: { played: 0, first_try: 0, rating_avg: null, performance: null },
        themes: [],
        improvement_areas: [],
        strengths: [],
        unranked: 0,
      });
      render(<PracticeWeakness {...weaknessProps({ themeStats: ready(none) })} />);
      expect(weaknessCard().textContent).toContain("No puzzle played in this period yet.");
      expect(
        within(weaknessCard()).getByRole("button", { name: "Start a healthy mix" }),
      ).toBeTruthy();
    });

    it("reads Starting on the healthy mix button while its queue is on its way", () => {
      render(
        <PracticeWeakness
          {...weaknessProps({
            themeStats: ready(unranked),
            starting: { mode: "puzzles", motif: "" },
          })}
        />,
      );
      expect(
        (within(weaknessCard()).getByRole("button", { name: "Starting" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
  });

  describe("when the statistics are not there", () => {
    it("says it is loading, in a quiet sentence, with no row and no button", () => {
      render(<PracticeWeakness {...weaknessProps({ themeStats: { status: "loading" } })} />);
      const card = weaknessCard();
      expect(within(card).getByRole("status").textContent).toBe("Loading your theme statistics.");
      expect(within(card).queryByRole("button")).toBeNull();
      expect(within(card).queryByRole("radio")).toBeNull();
    });

    it("says it could not be read, with Try again that asks for them again", () => {
      const retry = vi.fn();
      render(<PracticeWeakness {...weaknessProps({ themeStats: { status: "failed", retry } })} />);
      const card = weaknessCard();
      const alert = within(card).getByRole("alert");
      expect(alert.textContent).toBe("Your theme statistics could not be loaded.");
      expect(alert.className).toContain("practice__failure");
      fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
      expect(retry).toHaveBeenCalledTimes(1);
      expect(within(card).queryByRole("button", { name: "Mix practice" })).toBeNull();
      expect(within(card).queryByRole("radio")).toBeNull();
    });

    it("keeps the tiles drawn with no percentage, each still starting its theme", () => {
      const onStart = vi.fn();
      const themeStats: Loaded<ThemeStatsResponse> = { status: "failed", retry: vi.fn() };
      render(
        <>
          <PracticeWeakness {...weaknessProps({ themeStats })} />
          <PracticeThemes {...themesProps({ themeStats, onStart })} />
        </>,
      );
      expect(section().querySelectorAll(".theme-tile")).toHaveLength(54);
      expect(section().querySelectorAll(".theme-tile__stat")).toHaveLength(0);
      fireEvent.click(tileOf("fork"));
      expect(onStart).toHaveBeenCalledWith("puzzles", "fork");
      fireEvent.click(mixCard());
      expect(onStart).toHaveBeenLastCalledWith("puzzles", "");
    });
  });
});

describe("the Overview with its themes", () => {
  const overviewProps = {
    fetchProgress: async () => progressOf(),
    fetchRepertoires: async () => [],
    fetchRepertoireList: async () => ({ repertoires: [], met: [] }),
    fetchRatingHistory: async () => {
      throw new Error("no history");
    },
    fetchHealth: async () => ({ status: "ok" as const, version: "test", ready: true }),
    fetchThemeStats: async () => statsOf(),
  };

  async function overview(server = serverApi(null)) {
    render(<Practice server={server} {...overviewProps} />);
    await within(await screen.findByRole("region", { name: "Puzzles by weakness" })).findByRole(
      "radio",
      { name: /^Deflection/ },
    );
    return server;
  }

  it("fills the card, the note and the tiles from the one 30-day answer", async () => {
    await overview();
    expect(rowsOf()).toHaveLength(5);
    expect(section().querySelector(".theme-tiles__note")?.textContent).toContain(
      "12 of 54 themes tried",
    );
    expect(statOf("fork")?.textContent).toBe("70%");
    expect(mixCard().querySelector(".healthy-mix__rate")?.textContent).toBe("64%");
  });

  it("sends start_training for the puzzle queue with no motif from the Healthy mix", async () => {
    const server = await overview();
    fireEvent.click(mixCard());
    expect(server.send).toHaveBeenCalledTimes(1);
    expect(server.send).toHaveBeenCalledWith({ type: "start_training", mode: "puzzles" });
    expect(vi.mocked(server.send).mock.calls[0]?.[0]).not.toHaveProperty("motif");
    expect(mixCard().querySelector(".healthy-mix__start")?.textContent).toBe("Starting");
  });

  it("sends start_training with the theme of the tile that is pressed", async () => {
    const server = await overview();
    fireEvent.click(tileOf("xRayAttack"));
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "puzzles",
      motif: "xRayAttack",
    });
    expect(server.send).toHaveBeenCalledTimes(1);
  });

  it("sends the selected weak theme from the Train button", async () => {
    const server = await overview();
    fireEvent.click(rowsOf()[4] as HTMLElement);
    fireEvent.click(within(weaknessCard()).getByRole("button", { name: "Train mate in 2" }));
    expect(server.send).toHaveBeenLastCalledWith({
      type: "start_training",
      mode: "puzzles",
      motif: "mateIn2",
    });
  });

  it("sends mix-practice from Mix practice", async () => {
    const server = await overview();
    fireEvent.click(within(weaknessCard()).getByRole("button", { name: "Mix practice" }));
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "puzzles",
      motif: "mix-practice",
    });
  });

  it("holds every start of the page once one is in flight", async () => {
    await overview();
    fireEvent.click(tileOf("pin"));
    expect(statOf("pin")?.textContent).toBe("Starting");
    for (const button of [
      mixCard(),
      tileOf("fork"),
      within(weaknessCard()).getByRole("button", { name: "Mix practice" }),
    ]) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("shows a refused theme start on the Overview and names the theme", async () => {
    const server = serverApi(null);
    const view = render(<Practice server={server} {...overviewProps} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Fork\b/ }));
    view.rerender(
      <Practice
        server={{ ...server, errorCount: 1, lastError: "no puzzle", lastErrorCode: "empty_queue" }}
        {...overviewProps}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "There are no Fork puzzles. Try the Healthy mix or another theme.",
    );
  });

  it("draws no list of motifs with radio buttons and never asks for the motif counts", async () => {
    const fetched = vi.fn(async (_input: RequestInfo | URL) => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetched);
    render(<Practice server={serverApi(null)} />);
    await waitFor(() => expect(fetched).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Puzzles by motif" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Motif" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start any motif" })).toBeNull();
    const urls = fetched.mock.calls.map((call) => String(call[0]));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => url.includes("/api/puzzles/motifs"))).toEqual([]);
    expect(urls.some((url) => url.includes("/api/puzzles/themes/stats?days=30"))).toBe(true);
  });
});

describe("what a refused theme start tells the student", () => {
  it("names the theme and points at the healthy mix, since no list of motifs is left to choose from", () => {
    expect(startFailureText("puzzles", "fork", "empty_queue", null)).toBe(
      "There are no Fork puzzles. Try the Healthy mix or another theme.",
    );
    expect(startFailureText("puzzles", "mix-practice", "empty_queue", null)).toBe(
      "There are no Mix practice puzzles. Try the Healthy mix or another theme.",
    );
  });

  it("keeps asking for the library when the healthy mix itself finds no puzzle", () => {
    expect(startFailureText("puzzles", "", "empty_queue", null)).toBe(
      "There are no puzzles to drill. Restart the server to load the puzzle library.",
    );
  });
});

// The browser lays the section out; these read the rules it is drawn with off the stylesheet, as
// the hub's frame test does, and keep to the measures of the approved screen at 1600 px.
describe("the styles of the weakness card and the Puzzle themes section", () => {
  const STYLES = join(import.meta.dirname, "../src/styles");
  const sheet = readFileSync(join(STYLES, "practice-hub.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");

  // The text of every `@media (max-width: 899px)` block, and the rest of the sheet outside them.
  function splitByPhone(css: string): { desktop: string; phone: string } {
    const marker = "@media (max-width: 899px)";
    let desktop = "";
    let phone = "";
    let cursor = 0;
    for (let at = css.indexOf(marker); at !== -1; at = css.indexOf(marker, cursor)) {
      desktop += css.slice(cursor, at);
      let depth = 0;
      let end = css.indexOf("{", at);
      for (; end < css.length; end += 1) {
        if (css[end] === "{") depth += 1;
        if (css[end] === "}") depth -= 1;
        if (depth === 0) break;
      }
      phone += css.slice(css.indexOf("{", at) + 1, end);
      cursor = end + 1;
    }
    return { desktop: desktop + css.slice(cursor), phone };
  }
  const { desktop, phone } = splitByPhone(sheet);

  function declared(css: string, selector: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const [, selectors = "", body = ""] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
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

  it("lays the tiles of a group in columns of at least 240 px, 2 px apart down and 12 px across", () => {
    expect(declared(desktop, ".theme-tiles__grid")).toMatchObject({
      display: "grid",
      "grid-template-columns": "repeat(auto-fill, minmax(240px, 1fr))",
      gap: "2px 12px",
    });
  });

  it("draws a group's heading at 14 px over a hairline, and the section's title and note on one line", () => {
    expect(declared(desktop, ".theme-tiles__group-title")).toMatchObject({
      "font-size": "var(--text-sm)",
      "font-weight": "500",
      "border-bottom": "1px solid var(--border)",
    });
    expect(token("--text-sm")).toBe("0.875rem");
    expect(declared(desktop, ".theme-tiles__head")).toMatchObject({
      display: "flex",
      "align-items": "baseline",
    });
    expect(declared(desktop, ".theme-tiles__note")).toMatchObject({
      "font-size": "var(--text-xs)",
      color: "var(--text-2)",
    });
    expect(token("--text-xs")).toBe("0.75rem");
  });

  it("sets a tile as a name at 14 px, a mono share at 12 px at its right and a 12 px description under them", () => {
    expect(declared(desktop, ".theme-tile")).toMatchObject({
      display: "grid",
      "grid-template-columns": "minmax(0, 1fr) auto",
      gap: "2px 12px",
      padding: "var(--space-2) var(--space-3)",
      "border-radius": "var(--radius-sm)",
    });
    expect(token("--space-2")).toBe("0.5rem");
    expect(token("--space-3")).toBe("0.75rem");
    expect(token("--radius-sm")).toBe("4px");
    expect(declared(desktop, ".theme-tile__name")).toMatchObject({ "font-size": "var(--text-sm)" });
    expect(declared(desktop, ".theme-tile__stat")).toMatchObject({
      "font-family": "var(--font-mono)",
      "font-size": "var(--text-xs)",
      "text-align": "right",
    });
    expect(declared(desktop, ".theme-tile__desc")).toMatchObject({
      "grid-column": "1 / -1",
      "font-size": "var(--text-xs)",
    });
  });

  it("colours the share green from 70, amber from 55 and red under it, and 'new' in the faintest text", () => {
    expect(declared(desktop, '.theme-tile__stat[data-tone="good"]').color).toBe(
      "var(--quality-best)",
    );
    expect(declared(desktop, '.theme-tile__stat[data-tone="mid"]').color).toBe(
      "var(--quality-inaccuracy)",
    );
    expect(declared(desktop, '.theme-tile__stat[data-tone="low"]').color).toBe(
      "var(--quality-blunder)",
    );
    expect(declared(desktop, '.theme-tile__stat[data-tone="new"]').color).toBe("var(--text-3)");
  });

  it("outlines the healthy mix in the accent as one button with a 32 px Start pill", () => {
    expect(declared(desktop, ".healthy-mix")).toMatchObject({
      display: "flex",
      border: "1px solid var(--accent)",
      "border-radius": "var(--radius-md)",
    });
    expect(declared(desktop, ".healthy-mix__title")).toMatchObject({ "font-weight": "500" });
    expect(declared(desktop, ".healthy-mix__rate")).toMatchObject({
      "font-family": "var(--font-mono)",
      "font-size": "var(--text-xs)",
    });
    expect(declared(desktop, ".healthy-mix__start")).toMatchObject({
      height: "32px",
      background: "var(--accent)",
      color: "var(--on-accent)",
    });
  });

  it("sizes the weakness card's rows to the grid of a name, a rating, a bar and a share, 36 px high", () => {
    const row = {
      display: "grid",
      "grid-template-columns": "minmax(0, 1fr) 56px 64px 36px",
      gap: "10px",
    };
    expect(declared(desktop, ".practice-weakness__row")).toMatchObject({
      ...row,
      "min-height": "36px",
      "border-radius": "var(--radius-sm)",
      "font-size": "var(--text-sm)",
    });
    expect(declared(desktop, ".practice-weakness__head")).toMatchObject(row);
    expect(declared(desktop, ".practice-weakness__bar")).toMatchObject({ height: "4px" });
    expect(declared(desktop, '.practice-weakness__row[aria-checked="true"]')).toMatchObject({
      "border-color": "var(--accent)",
    });
    expect(declared(desktop, ".practice-weakness__actions .button")).toMatchObject({
      height: "36px",
    });
  });

  it("puts the tiles in one column under 900 px and keeps every control 44 px high", () => {
    expect(declared(phone, ".theme-tiles__grid")).toMatchObject({
      "grid-template-columns": "minmax(0, 1fr)",
    });
    expect(declared(phone, ".theme-tile")).toMatchObject({ "min-height": "44px" });
    expect(declared(phone, ".practice-weakness__row")).toMatchObject({ "min-height": "44px" });
    expect(declared(phone, ".healthy-mix__start")).toMatchObject({ "min-height": "44px" });
    // Train, Mix practice, Try again and Start a healthy mix are all buttons of the card.
    expect(declared(phone, ".practice-weakness .button")).toMatchObject({ "min-height": "44px" });
    expect(declared(desktop, ".theme-tiles__grid")["grid-template-columns"]).not.toBe(
      declared(phone, ".theme-tiles__grid")["grid-template-columns"],
    );
  });

  it("holds no colour literal, shadow or scrolling box among its rules", () => {
    const ours = /^\.(practice-weakness__|healthy-mix|theme-tile)/;
    const bodies = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selectors = ""]) => selectors.split(",").some((part) => ours.test(part.trim())))
      .map(([, , body = ""]) => body);
    expect(bodies.length).toBeGreaterThan(20);
    for (const body of bodies) {
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      expect(body).not.toMatch(/box-shadow|text-shadow/);
      expect(body).not.toMatch(/overflow|max-height/);
    }
  });
});
