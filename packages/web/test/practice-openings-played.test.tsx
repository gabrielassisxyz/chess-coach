import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlayedOpeningsResponse, PlayedWindow } from "@chess-coach/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Practice } from "../src/screens/Practice.js";
import { fetchOpeningsPlayedFromServer } from "../src/state/openings-played-api.js";
import { PRACTICE_PAGE_STORAGE_KEY } from "../src/state/practice-page.js";
import {
  foundPosition,
  foundResponse,
  noPlayedColour,
  openPracticePage,
  playedColour,
  playedOpening,
  playedVariation,
  progressOf,
} from "./practice-fixtures.js";
import { serverApi } from "./server-api.js";

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PRACTICE_PAGE_STORAGE_KEY);
  vi.unstubAllGlobals();
});

const PIANISSIMO = "Italian Game: Giuoco Pianissimo";
const TWO_KNIGHTS = "Italian Game: Two Knights Defense";
const EXCHANGE = "Queen's Gambit Declined: Exchange Variation";

// 20 games, 11 won, 2 drawn and 7 lost, a score of 60; its last variation has no game.
const italian = playedOpening("Italian Game", "1.e4 e5 2.Nf3 Nc6 3.Bc4", [
  playedVariation(PIANISSIMO, [6, 1, 2], "3…Bc5 4.d3"),
  playedVariation(TWO_KNIGHTS, [3, 0, 3], "3…Nf6"),
  playedVariation(
    "Italian Game: Fried Liver Attack",
    [1, 0, 2],
    "3…Nf6 4.Ng5 d5 5.exd5 Nxd5 6.Nxf7",
  ),
  playedVariation("Italian Game: Giuoco Piano", [1, 1, 0], "3…Bc5 4.c3"),
  playedVariation("Italian Game: Evans Gambit", [0, 0, 0], "3…Bc5 4.b4"),
]);
const kingsPawn = playedOpening("King's Pawn Game", "1.e4 e5 2.Nf3 Nc6 3.Nc3", [
  playedVariation("King's Pawn Game", [2, 0, 0], "1.e4 e5 2.Nf3 Nc6 3.Nc3"),
]);
const scandinavian = playedOpening("Scandinavian Defense", "1.e4 d5", [
  playedVariation("Scandinavian Defense", [3, 0, 1], "1.e4 d5"),
]);
const buschGass = playedOpening("Busch-Gass Gambit", "1.e4 e5 2.Nf3 Bc5", [
  playedVariation("Busch-Gass Gambit", [0, 0, 1], "1.e4 e5 2.Nf3 Bc5"),
]);
const petrov = playedOpening("Petrov's Defense", "1.e4 e5 2.Nf3 Nf6", [
  playedVariation("Petrov's Defense", [1, 0, 1], "1.e4 e5 2.Nf3 Nf6"),
]);
// An opening with no game in the period, which the server may still list and the page never draws.
const latvian = playedOpening("Latvian Gambit", "1.e4 e5 2.Nf3 f5", [
  playedVariation("Latvian Gambit", [0, 0, 0], "1.e4 e5 2.Nf3 f5"),
]);
const queensGambitDeclined = playedOpening("Queen's Gambit Declined", "1.d4 d5 2.c4 e6", [
  playedVariation(EXCHANGE, [2, 1, 5], "3.cxd5 exd5"),
]);
const slav = playedOpening("Slav Defense", "1.d4 d5 2.c4 c6", [
  playedVariation("Slav Defense", [1, 0, 0], "1.d4 d5 2.c4 c6"),
]);
const london = playedOpening("London System", "1.d4 d5 2.Bf4", [
  playedVariation("London System", [2, 1, 2], "1.d4 d5 2.Bf4"),
]);

// White played 22 games and Black 9.
const ANSWER: PlayedOpeningsResponse = {
  white: playedColour([italian, kingsPawn], [scandinavian, buschGass, latvian, petrov]),
  black: playedColour([queensGambitDeclined, slav], [london]),
};

// Two of the four carry a name a variation above has; the Two Knights one is Black's, which a
// White row must not take for its own.
const POSITIONS = [
  foundPosition({ id: "own:pianissimo", color: "white", opening_name: PIANISSIMO }),
  foundPosition({ id: "own:two-knights", color: "black", opening_name: TWO_KNIGHTS }),
  foundPosition({ id: "own:scandinavian", color: "white", opening_name: "Scandinavian Defense" }),
  foundPosition({ id: "own:exchange", color: "black", opening_name: EXCHANGE }),
];

interface PageOptions {
  fetchOpeningsPlayed?: (days: PlayedWindow) => Promise<PlayedOpeningsResponse>;
  fetchFoundPositions?: () => Promise<ReturnType<typeof foundResponse>>;
  // The hub opens on its Overview, so a test that looks at the first read keeps the page closed.
  open?: boolean;
}

function renderPage(options: PageOptions = {}) {
  const send = vi.fn(() => true);
  const fetchOpeningsPlayed =
    options.fetchOpeningsPlayed ?? vi.fn(async (_days: PlayedWindow) => ANSWER);
  const fetchFoundPositions =
    options.fetchFoundPositions ?? vi.fn(async () => foundResponse(POSITIONS));
  render(
    <Practice
      server={serverApi(null, { send })}
      fetchProgress={async () => progressOf()}
      fetchRepertoires={async () => []}
      fetchRepertoireList={async () => ({ repertoires: [], met: [] })}
      fetchHealth={async () => ({ status: "ok", version: "test", ready: true })}
      fetchThemeStats={async () => {
        throw new Error("the Overview is not under test");
      }}
      fetchRatingHistory={async () => {
        throw new Error("the Overview is not under test");
      }}
      fetchFoundPositions={fetchFoundPositions}
      fetchOpeningsPlayed={fetchOpeningsPlayed}
    />,
  );
  if (options.open !== false) openPracticePage("Openings played");
  return { send, fetchOpeningsPlayed, fetchFoundPositions };
}

// Every page of the hub stays mounted, so the page is found by its title, which only the one on
// screen holds in the accessibility tree.
const pageRoot = (): HTMLElement =>
  screen
    .getByRole("heading", { level: 2, name: "Openings played" })
    .closest(".played") as HTMLElement;

const sectionOf = (title: string): HTMLElement =>
  within(pageRoot()).getByRole("region", { name: title });

const sectionReady = (title: string): Promise<HTMLElement> =>
  within(pageRoot()).findByRole("region", { name: title });

// The rows that open and close, apart from the Drill buttons among them.
const openingRowsOf = (section: HTMLElement): HTMLElement[] =>
  within(section)
    .getAllByRole("button")
    .filter((button) => button.hasAttribute("aria-expanded"));

const titleOf = (row: Element): string =>
  row.querySelector(".played-row__title")?.textContent ?? "";

function rowNamed(section: HTMLElement, name: string): HTMLElement {
  const row = openingRowsOf(section).find((candidate) => titleOf(candidate) === name);
  if (!row) throw new Error(`no opening row named ${name}`);
  return row;
}

const variationsOf = (opening: string): HTMLElement =>
  within(pageRoot()).getByRole("list", { name: `${opening} variations` });

const textOf = (row: Element, selector: string): string | undefined =>
  row.querySelector(selector)?.textContent ?? undefined;

// The share of the bar each outcome holds, in the order the bar draws them.
const barOf = (row: HTMLElement): { outcome: string; width: number }[] =>
  [...row.querySelectorAll<HTMLElement>(".played-bar__part")].map((part) => ({
    outcome: part.dataset.outcome ?? "",
    width: Number.parseFloat(part.style.width),
  }));

describe("the Openings played page", () => {
  it("reads nothing until it is shown, then asks for the last 30 days", async () => {
    const { fetchOpeningsPlayed } = renderPage({ open: false });
    await screen.findByRole("navigation", { name: "Practice sections" });
    expect(fetchOpeningsPlayed).not.toHaveBeenCalled();

    openPracticePage("Openings played");
    await sectionReady("Your openings");
    expect(fetchOpeningsPlayed).toHaveBeenCalledTimes(1);
    expect(fetchOpeningsPlayed).toHaveBeenCalledWith("30");
  });

  it("draws its title, the total with the legend and the two sections with the openings in the order given", async () => {
    renderPage();
    await sectionReady("Your openings");
    const root = pageRoot();

    expect(textOf(root, ".screen__note")).toBe(
      "Every opening from your own games. Open a row to see the variations; drill any of them.",
    );
    const total = within(root).getByText("22 games as White").closest("p") as HTMLElement;
    for (const word of ["won", "drawn", "lost"]) expect(within(total).getByText(word)).toBeTruthy();

    const headings = within(root).getAllByRole("heading", { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Your openings",
      "Played against",
    ]);
    expect(within(sectionOf("Your openings")).getByText("Lines you chose to play")).toBeTruthy();
    expect(
      within(sectionOf("Played against")).getByText("What your opponents chose against you"),
    ).toBeTruthy();
    for (const section of ["Your openings", "Played against"]) {
      const head = sectionOf(section).querySelector(".played-head") as HTMLElement;
      expect([...head.children].map((cell) => cell.textContent)).toEqual([
        "Opening",
        "Games",
        "Win / draw / loss",
        "Score",
        "",
      ]);
    }

    expect(openingRowsOf(sectionOf("Your openings")).map(titleOf)).toEqual([
      "Italian Game",
      "King's Pawn Game",
    ]);
    expect(openingRowsOf(sectionOf("Played against")).map(titleOf)).toEqual([
      "Scandinavian Defense",
      "Busch-Gass Gambit",
      "Petrov's Defense",
    ]);
  });

  it("draws an opening's row with its name, line, games, bar, score and counts", async () => {
    renderPage();
    const mine = await sectionReady("Your openings");

    const row = rowNamed(mine, "Italian Game");
    expect(textOf(row, ".played-row__line")).toBe("1.e4 e5 2.Nf3 Nc6 3.Bc4");
    expect(textOf(row, ".played-row__games")).toBe("Games 20");
    expect(textOf(row, ".played-score")).toBe("Score 60%");
    expect(textOf(row, ".played-row__counts")).toBe("11 / 2 / 7");
    const bar = within(row).getByRole("img", { name: "11 won, 2 drawn, 7 lost" });
    expect(bar).toBeTruthy();
    const parts = barOf(row);
    expect(parts.map((part) => part.outcome)).toEqual(["won", "drawn", "lost"]);
    expect(parts[0]?.width).toBeCloseTo(55, 5);
    expect(parts[1]?.width).toBeCloseTo(10, 5);
    expect(parts[2]?.width).toBeCloseTo(35, 5);

    // A bar holds only the outcomes that happened.
    const allWon = rowNamed(mine, "King's Pawn Game");
    expect(barOf(allWon)).toEqual([{ outcome: "won", width: 100 }]);
    expect(textOf(allWon, ".played-row__counts")).toBe("2 / 0 / 0");
  });

  it("scores a win as one and a draw as a half, rounded, and colours it by the band of that figure", async () => {
    const bands = [
      { name: "Seventy", wdl: [7, 0, 3], score: "70%", tone: "good" },
      { name: "Draws count half", wdl: [5, 4, 1], score: "70%", tone: "good" },
      { name: "Fifty-five", wdl: [11, 0, 9], score: "55%", tone: "mid" },
      // 109 of 200 is 54.5, which rounds to the 55 the student reads.
      { name: "Rounded up", wdl: [109, 0, 91], score: "55%", tone: "mid" },
      { name: "Fifty-four", wdl: [27, 0, 23], score: "54%", tone: "low" },
      { name: "Nothing", wdl: [0, 0, 4], score: "0%", tone: "low" },
    ] as const;
    renderPage({
      fetchOpeningsPlayed: async () => ({
        white: playedColour(
          bands.map(({ name, wdl }) => playedOpening(name, "", [playedVariation(name, wdl)])),
        ),
        black: noPlayedColour,
      }),
    });
    const mine = await sectionReady("Your openings");

    for (const { name, score, tone } of bands) {
      const figure = rowNamed(mine, name).querySelector(".played-score");
      expect(figure?.textContent, name).toBe(`Score ${score}`);
      expect(figure?.getAttribute("data-tone"), name).toBe(tone);
    }
  });

  it("opens the first opening of Your openings, and a press opens or closes any row", async () => {
    renderPage();
    const mine = await sectionReady("Your openings");
    const against = sectionOf("Played against");
    const expanded = (row: HTMLElement): string | null => row.getAttribute("aria-expanded");

    expect(expanded(rowNamed(mine, "Italian Game"))).toBe("true");
    expect(expanded(rowNamed(mine, "King's Pawn Game"))).toBe("false");
    expect(openingRowsOf(against).map(expanded)).toEqual(["false", "false", "false"]);
    expect(variationsOf("Italian Game")).toBeTruthy();
    expect(
      within(pageRoot()).queryByRole("list", { name: "King's Pawn Game variations" }),
    ).toBeNull();

    fireEvent.click(rowNamed(mine, "Italian Game"));
    expect(expanded(rowNamed(mine, "Italian Game"))).toBe("false");
    expect(within(pageRoot()).queryByRole("list", { name: "Italian Game variations" })).toBeNull();

    fireEvent.click(rowNamed(against, "Scandinavian Defense"));
    expect(expanded(rowNamed(against, "Scandinavian Defense"))).toBe("true");
    expect(within(variationsOf("Scandinavian Defense")).getByText("Main line")).toBeTruthy();

    fireEvent.click(rowNamed(against, "Scandinavian Defense"));
    expect(
      within(pageRoot()).queryByRole("list", { name: "Scandinavian Defense variations" }),
    ).toBeNull();
  });

  it("draws a variation's row with its name, line, games, bar and score, and none that has no game", async () => {
    renderPage();
    await sectionReady("Your openings");

    const rows = within(variationsOf("Italian Game")).getAllByRole("listitem");
    expect(rows.map(titleOf)).toEqual([
      "Giuoco Pianissimo",
      "Two Knights Defense",
      "Fried Liver Attack",
      "Giuoco Piano",
    ]);
    const [first] = rows as [HTMLElement];
    expect(textOf(first, ".played-row__line")).toBe("3…Bc5 4.d3");
    expect(textOf(first, ".played-row__games")).toBe("Games 9");
    expect(textOf(first, ".played-score")).toBe("Score 72%");
    expect(within(first).getByRole("img", { name: "6 won, 1 drawn, 2 lost" })).toBeTruthy();
    expect(barOf(first).map((part) => part.outcome)).toEqual(["won", "drawn", "lost"]);
  });

  it("offers Drill only where a position of that colour carries the full name, and sends the drill", async () => {
    const { send } = renderPage();
    await sectionReady("Your openings");

    const rows = within(variationsOf("Italian Game")).getAllByRole("listitem");
    const offered = rows.map(
      (row) => within(row).queryByRole("button", { name: "Drill" }) !== null,
    );
    // The Two Knights name is carried by a position of Black's, not of White's.
    expect(offered).toEqual([true, false, false, false]);

    fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: "Drill" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "found",
      scope: "all",
      color: "white",
      opening: PIANISSIMO,
    });
  });

  it("drills for Black with the colour of the side that is shown", async () => {
    const { send } = renderPage();
    await sectionReady("Your openings");
    fireEvent.click(within(pageRoot()).getByRole("button", { name: "As Black" }));

    const rows = within(variationsOf("Queen's Gambit Declined")).getAllByRole("listitem");
    fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: "Drill" }));
    expect(send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "found",
      scope: "all",
      color: "black",
      opening: EXCHANGE,
    });
  });

  it("says Starting on the drill that was pressed, holds every other start and leaves the other pages' buttons alone", async () => {
    renderPage();
    await sectionReady("Your openings");
    fireEvent.click(rowNamed(sectionOf("Played against"), "Scandinavian Defense"));
    const [pressed] = within(variationsOf("Italian Game")).getAllByRole("listitem") as [
      HTMLElement,
    ];
    const other = within(variationsOf("Scandinavian Defense")).getByRole("button", {
      name: "Drill",
    }) as HTMLButtonElement;
    expect(other.disabled).toBe(false);

    fireEvent.click(within(pressed).getByRole("button", { name: "Drill" }));

    expect(within(pressed).getByRole("button", { name: "Starting" })).toBeTruthy();
    expect(other.disabled).toBe(true);
    // The Overview and From my games hold their own starts, none of which this was.
    expect(screen.getAllByText("Starting")).toHaveLength(1);
  });

  it("offers no Drill while the positions from the student's games are not read", async () => {
    renderPage({
      fetchFoundPositions: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    await sectionReady("Your openings");

    expect(within(pageRoot()).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(within(pageRoot()).queryAllByRole("button", { name: /^(Drill|Starting)$/ })).toEqual([]);
  });

  it("opens on As White and switches to the lists of Black without reading again", async () => {
    const { fetchOpeningsPlayed } = renderPage();
    await sectionReady("Your openings");
    const side = within(pageRoot()).getByRole("group", { name: "Side" });
    const pressedOf = (name: string): string | null =>
      within(side).getByRole("button", { name }).getAttribute("aria-pressed");
    expect(
      within(side)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["As White", "As Black"]);
    expect(pressedOf("As White")).toBe("true");
    expect(pressedOf("As Black")).toBe("false");

    fireEvent.click(within(side).getByRole("button", { name: "As Black" }));

    expect(pressedOf("As Black")).toBe("true");
    expect(pressedOf("As White")).toBe("false");
    expect(within(pageRoot()).getByText("9 games as Black")).toBeTruthy();
    const mine = sectionOf("Your openings");
    expect(openingRowsOf(mine).map(titleOf)).toEqual(["Queen's Gambit Declined", "Slav Defense"]);
    expect(openingRowsOf(sectionOf("Played against")).map(titleOf)).toEqual(["London System"]);
    expect(rowNamed(mine, "Queen's Gambit Declined").getAttribute("aria-expanded")).toBe("true");
    expect(fetchOpeningsPlayed).toHaveBeenCalledTimes(1);

    fireEvent.click(within(side).getByRole("button", { name: "As White" }));
    expect(within(pageRoot()).getByText("22 games as White")).toBeTruthy();
  });

  it("offers 7 days, 30 days, 90 days and All, opens on 30 days, and reads again for the period chosen", async () => {
    const fetchOpeningsPlayed = vi.fn(
      async (days: PlayedWindow): Promise<PlayedOpeningsResponse> =>
        days === "7" ? { white: playedColour([kingsPawn]), black: noPlayedColour } : ANSWER,
    );
    renderPage({ fetchOpeningsPlayed });
    await sectionReady("Your openings");
    const period = within(pageRoot()).getByRole("group", { name: "Time window" });
    const pressedOf = (name: string): string | null =>
      within(period).getByRole("button", { name }).getAttribute("aria-pressed");
    expect(
      within(period)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["7 days", "30 days", "90 days", "All"]);
    expect(pressedOf("30 days")).toBe("true");
    expect(pressedOf("7 days")).toBe("false");

    fireEvent.click(within(period).getByRole("button", { name: "7 days" }));
    await within(pageRoot()).findByText("2 games as White");
    expect(fetchOpeningsPlayed).toHaveBeenLastCalledWith("7");
    expect(pressedOf("7 days")).toBe("true");
    expect(pressedOf("30 days")).toBe("false");

    fireEvent.click(within(period).getByRole("button", { name: "All" }));
    await within(pageRoot()).findByText("22 games as White");
    expect(fetchOpeningsPlayed).toHaveBeenLastCalledWith("all");

    fireEvent.click(within(period).getByRole("button", { name: "90 days" }));
    await vi.waitFor(() => expect(fetchOpeningsPlayed).toHaveBeenLastCalledWith("90"));
    expect(fetchOpeningsPlayed).toHaveBeenCalledTimes(4);
  });

  it("says No game in this period yet. in place of the table of a section with no opening", async () => {
    renderPage({
      fetchOpeningsPlayed: async () => ({
        white: playedColour([kingsPawn], []),
        black: noPlayedColour,
      }),
    });
    const against = await sectionReady("Played against");

    expect(within(against).getByText("No game in this period yet.")).toBeTruthy();
    expect(within(against).queryByText("Opening")).toBeNull();
    expect(within(against).queryByRole("list")).toBeNull();
    expect(
      within(sectionOf("Your openings")).queryByText("No game in this period yet."),
    ).toBeNull();
    expect(openingRowsOf(sectionOf("Your openings")).map(titleOf)).toEqual(["King's Pawn Game"]);
  });

  it("says once that there is no game as White, or as Black, in place of both sections", async () => {
    const white =
      "No game as White in this period. Import games in Games to see your openings here.";
    const black =
      "No game as Black in this period. Import games in Games to see your openings here.";
    renderPage({
      fetchOpeningsPlayed: async () => ({ white: noPlayedColour, black: playedColour([slav]) }),
    });
    expect(await within(pageRoot()).findByText(white)).toBeTruthy();
    expect(within(pageRoot()).getAllByText(white)).toHaveLength(1);
    expect(within(pageRoot()).queryByRole("region")).toBeNull();
    expect(within(pageRoot()).queryByText(/^\d+ games? as White$/)).toBeNull();

    fireEvent.click(within(pageRoot()).getByRole("button", { name: "As Black" }));
    expect(within(pageRoot()).getByText("1 game as Black")).toBeTruthy();
    expect(within(pageRoot()).queryByText(white)).toBeNull();
    cleanup();

    renderPage({
      fetchOpeningsPlayed: async () => ({ white: playedColour([slav]), black: noPlayedColour }),
    });
    await sectionReady("Your openings");
    fireEvent.click(within(pageRoot()).getByRole("button", { name: "As Black" }));
    expect(within(pageRoot()).getAllByText(black)).toHaveLength(1);
    expect(within(pageRoot()).queryByRole("region")).toBeNull();
  });

  it("says the openings could not be loaded and reads again on Try again", async () => {
    let failing = true;
    const fetchOpeningsPlayed = vi.fn(
      async (_days: PlayedWindow): Promise<PlayedOpeningsResponse> => {
        if (failing) throw new Error("down");
        return ANSWER;
      },
    );
    renderPage({ fetchOpeningsPlayed });

    const alert = await within(pageRoot()).findByRole("alert");
    expect(alert.textContent).toBe("Your openings could not be loaded.");
    expect(within(pageRoot()).queryByRole("region")).toBeNull();

    failing = false;
    fireEvent.click(within(pageRoot()).getByRole("button", { name: "Try again" }));
    await sectionReady("Your openings");
    expect(fetchOpeningsPlayed).toHaveBeenCalledTimes(2);
    expect(within(pageRoot()).queryByRole("alert")).toBeNull();
  });

  it("says it is loading while the answer is awaited", async () => {
    renderPage({ fetchOpeningsPlayed: () => new Promise(() => undefined) });
    const status = await within(pageRoot()).findByRole("status");
    expect(status.textContent).toBe("Loading your openings.");
    expect(within(pageRoot()).queryByRole("region")).toBeNull();
  });
});

describe("the read of the counts", () => {
  it("asks GET /api/openings/played for the period chosen and parses the answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ANSWER });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOpeningsPlayedFromServer("7")).resolves.toEqual(ANSWER);
    await fetchOpeningsPlayedFromServer("30");
    await fetchOpeningsPlayedFromServer("90");
    await fetchOpeningsPlayedFromServer("all");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/openings/played?days=7",
      "/api/openings/played?days=30",
      "/api/openings/played?days=90",
      "/api/openings/played?days=all",
    ]);
  });

  it("refuses an answer that failed and one that is not the counts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(fetchOpeningsPlayedFromServer("30")).rejects.toThrow("openings played: 500");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ white: { games: 1 } }) }),
    );
    await expect(fetchOpeningsPlayedFromServer("30")).rejects.toThrow();
  });
});

// The browser lays the page out; these read the rules it is drawn with off the stylesheet and keep
// to the measures of the approved screen.
describe("the styles of the Openings played page", () => {
  const sheet = readFileSync(
    join(import.meta.dirname, "../src/styles/practice-hub.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const block = sheet.slice(sheet.indexOf(".played {"));
  const [desktop = "", ...phone] = block.split("@media (max-width: 899px)");

  // What the rules naming exactly this selector declare, the later one winning as in the cascade.
  function declared(css: string, selector: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = (match[1] ?? "").split(",").map((part) => part.trim());
      if (!selectors.includes(selector)) continue;
      for (const declaration of (match[2] ?? "").split(";")) {
        const at = declaration.indexOf(":");
        if (at > 0) found[declaration.slice(0, at).trim()] = declaration.slice(at + 1).trim();
      }
    }
    return found;
  }

  const hiddenIn = (css: string): string[] =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => /display:\s*none/.test(match[2] ?? ""))
      .flatMap((match) => (match[1] ?? "").split(",").map((part) => part.trim()));

  it("sizes the rows, the bar and the drill as the approved page does", () => {
    expect(declared(desktop, ".played-row--opening")).toMatchObject({
      "grid-template-columns": "16px minmax(0, 1fr) 72px 160px 56px 72px",
      "min-height": "52px",
    });
    expect(declared(desktop, ".played-row--variation")).toMatchObject({
      "grid-template-columns": "minmax(0, 1fr) 72px 160px 56px 72px",
      "min-height": "44px",
    });
    expect(declared(desktop, ".played-bar")).toMatchObject({ height: "6px" });
    expect(declared(desktop, ".played-row__drill")).toMatchObject({ height: "28px" });
    expect(declared(desktop, ".played-row--variation .played-row__name")).toMatchObject({
      "border-left": "1px solid var(--border)",
    });
    expect(declared(desktop, ".played-row__title")).toMatchObject({
      "font-size": "0.9375rem",
      "font-weight": "500",
    });
    expect(declared(desktop, ".played-row__line")).toMatchObject({
      "font-family": "var(--font-mono)",
      "font-size": "var(--text-xs)",
    });
  });

  it("sizes the Dashboard's rows as the approved card does", () => {
    expect(declared(desktop, ".played-top__row")).toMatchObject({
      "grid-template-columns": "minmax(0, 1fr) 80px 72px 160px 48px",
      height: "40px",
    });
  });

  it("colours the bar and the legend by outcome with tokens only", () => {
    expect(declared(desktop, '.played-bar__part[data-outcome="won"]')).toMatchObject({
      background: "var(--status-ready)",
    });
    expect(declared(desktop, '.played-bar__part[data-outcome="drawn"]')).toMatchObject({
      background: "var(--text-3)",
    });
    expect(declared(desktop, '.played-bar__part[data-outcome="lost"]')).toMatchObject({
      background: "var(--status-error)",
    });
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(block).not.toMatch(/box-shadow|text-shadow/);
  });

  it("drops the line of moves, the bar and the last column under 900 px, and keeps the name, the games and the score", () => {
    const small = phone.join("@media");
    expect(hiddenIn(small).sort()).toEqual(
      [
        ".played-bar",
        ".played-head__bar",
        ".played-head__counts",
        ".played-row__counts",
        ".played-row__line",
      ].sort(),
    );
    for (const kept of [".played-row__title", ".played-row__games", ".played-score"]) {
      expect(hiddenIn(small)).not.toContain(kept);
    }
    expect(declared(small, ".played-row--opening")["grid-template-columns"]).toBe(
      "16px minmax(0, 1fr) auto auto",
    );
    expect(declared(small, ".played-row__drill")).toMatchObject({ "min-height": "44px" });
  });
});

describe("the design check", () => {
  it("records the Openings played page in the Practice column", () => {
    const check = readFileSync(join(import.meta.dirname, "../DESIGN-CHECK.md"), "utf8");
    // The paragraphs are wrapped, so a phrase may break across a line.
    const record = check
      .split("\n\n")
      .map((paragraph) => paragraph.replace(/\s+/g, " "))
      .find(
        (paragraph) =>
          paragraph.startsWith("The Practice column was re-checked") &&
          paragraph.includes("Openings played page"),
      );
    expect(record).toBeDefined();
    expect(record).toContain("Phone column");
    expect(record).toContain("M1 and M2");
  });
});
