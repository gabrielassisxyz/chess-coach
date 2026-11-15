import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AddableOpening,
  MetOpening,
  RepertoireSummary,
  RepertoiresResponse,
} from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PracticeOpenings,
  type PracticeOpeningsProps,
} from "../src/components/PracticeOpenings.js";
import {
  type AddedOpening,
  addableGroupsOf,
  addableMatches,
  type FetchAddableOpenings,
  fetchAddableOpeningsFromServer,
  type StylePoints,
} from "../src/state/repertoires-api.js";
import { repertoireAnswer, repertoireList } from "./practice-fixtures.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const addable = (
  root: string[],
  opening_name: string,
  extra: Partial<AddableOpening> = {},
): AddableOpening => ({
  root,
  opening_name,
  family: opening_name,
  games: 0,
  share_0_1199: null,
  repertoire_id: null,
  ...extra,
});

// The answer of GET /api/openings/addable as the server orders it: by share, whichever path an
// entry leaves from, so the two groups of the panel are interleaved here.
const sicilian = addable(["e4", "c5"], "Sicilian Defense", { share_0_1199: 0.31 });
const petrov = addable(["e4", "e5", "Nf3", "Nf6"], "Petrov's Defense", {
  share_0_1199: 0.27,
  games: 2,
});
const french = addable(["e4", "e6"], "French Defense", { share_0_1199: 0.12, games: 1 });
const philidor = addable(["e4", "e5", "Nf3", "d6"], "Philidor Defense", {
  share_0_1199: 0.1,
  games: 1,
});
const caroKann = addable(["e4", "c6"], "Caro-Kann Defense", {
  share_0_1199: 0.08,
  games: 4,
  repertoire_id: 5,
});
const latvian = addable(["e4", "e5", "Nf3", "f5"], "Latvian Gambit", { share_0_1199: 0.01 });
const ALL_ENTRIES = [sicilian, petrov, french, philidor, caroKann, latvian];

const met = (
  root: string[],
  opening_name: string | null,
  games: number,
  repertoire_id: number | null = null,
): MetOpening => ({ root, opening_name, games, repertoire_id });

// Not in the order the panel shows them, which is the page's job: most games first.
const scandinavian = met(["e4", "d5"], "Scandinavian Defense", 4);
const alekhine = met(["e4", "Nf6"], "Alekhine Defense", 2);
const unnamed = met(["e4", "e5", "Nf3", "Bc5"], null, 1);
const MET = [alekhine, unnamed, met(["e4", "c6"], "Caro-Kann Defense", 4, 5), scandinavian];

const sicilianDrill: RepertoireSummary = {
  id: 7,
  side: "white",
  group_name: "Sicilian Defense",
  variation_name: "Open Sicilian (3.d4)",
  moves: { recommended: 4, due: 6, all: 12 },
};

const answer = (
  repertoires: RepertoireSummary[] = repertoireList,
  listed: MetOpening[] = MET,
): RepertoiresResponse => repertoireAnswer(repertoires, { met: listed });

interface PageOptions {
  fetchAddable?: FetchAddableOpenings;
  fetchList?: () => Promise<RepertoiresResponse>;
  props?: Partial<PracticeOpeningsProps>;
}

function renderPage(options: PageOptions = {}) {
  const fetchAddable: FetchAddableOpenings = options.fetchAddable ?? vi.fn(async () => ALL_ENTRIES);
  render(
    <PracticeOpenings
      busy={false}
      starting={null}
      onStart={vi.fn()}
      fetchList={options.fetchList ?? (async () => answer())}
      fetchAddable={fetchAddable}
      {...options.props}
    />,
  );
  return { fetchAddable };
}

const whiteSection = (): Promise<HTMLElement> => screen.findByRole("region", { name: "White" });

async function openPanel() {
  const white = await whiteSection();
  fireEvent.click(await within(white).findByRole("button", { name: "Add an opening…" }));
  return { white, panel: within(white).getByRole("region", { name: "Add an opening" }) };
}

const pickTab = (panel: HTMLElement, name: string | RegExp): void => {
  fireEvent.click(within(panel).getByRole("tab", { name }));
};
const search = (panel: HTMLElement, text: string): void => {
  fireEvent.change(within(panel).getByRole("searchbox", { name: "Search openings" }), {
    target: { value: text },
  });
};
const isDisabled = (element: HTMLElement): boolean => (element as HTMLButtonElement).disabled;
const follows = (first: Element, second: Element): boolean =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

const rowsOf = (list: HTMLElement): HTMLElement[] => within(list).getAllByRole("listitem");
const textOf = (row: HTMLElement, selector: string): string | null =>
  row.querySelector(selector)?.textContent ?? null;
// The name and the moves of each row of a list.
const nameAndMoves = (list: HTMLElement): (string | null)[][] =>
  rowsOf(list).map((row) => [
    textOf(row, ".openings-panel__opening"),
    textOf(row, ".openings-panel__moves"),
  ]);

// The names of the rows the panel shows under all its headings.
const shownNames = (panel: HTMLElement): (string | null)[] =>
  [...panel.querySelectorAll(".openings-panel__row")]
    .filter((row) => row.closest("[hidden]") === null)
    .map((row) => textOf(row as HTMLElement, ".openings-panel__opening"));

const addLabelOf = (name: string, line: string): string => `Add ${name}, ${line}`;

describe("the panel and its tabs", () => {
  it("is drawn after the last White opening even when no game met one, and opens on All openings", async () => {
    renderPage({ props: { fetchList: async () => answer(repertoireList, []) } });
    const white = await whiteSection();
    const button = await within(white).findByRole("button", { name: "Add an opening…" });
    expect(follows(within(white).getByRole("article", { name: "Italian Game" }), button)).toBe(
      true,
    );

    fireEvent.click(button);
    const panel = within(white).getByRole("region", { name: "Add an opening" });
    expect(within(white).queryByRole("button", { name: "Add an opening…" })).toBeNull();
    expect(within(panel).getByRole("heading", { level: 4, name: "Add an opening" })).toBeTruthy();
    expect(
      within(panel)
        .getAllByRole("tab")
        .map((tab) => [tab.textContent, tab.getAttribute("aria-selected")]),
    ).toEqual([
      ["All openings", "true"],
      ["From my games (0)", "false"],
    ]);
    expect(within(panel).getByRole("button", { name: "Close" })).toBeTruthy();
    expect(within(panel).getByRole("tabpanel", { name: "All openings" })).toBeTruthy();
    expect(within(panel).queryByRole("tabpanel", { name: /^From my games/ })).toBeNull();
  });

  it("is drawn in an empty White section too, after its sentence", async () => {
    renderPage({ fetchList: async () => repertoireAnswer([], { met: [] }) });
    const white = await whiteSection();
    const button = await within(white).findByRole("button", { name: "Add an opening…" });
    expect(follows(within(white).getByText("No opening is stored yet."), button)).toBe(true);
  });

  it("keeps the search and the list through a change of tab, and opens on All openings again", async () => {
    const { fetchAddable } = renderPage();
    const { panel } = await openPanel();
    await within(panel).findByRole("list", { name: "Against 1.e4" });
    search(panel, "sicil");
    pickTab(panel, /^From my games/);
    expect(within(panel).queryByRole("searchbox")).toBeNull();
    pickTab(panel, "All openings");
    expect(
      (within(panel).getByRole("searchbox", { name: "Search openings" }) as HTMLInputElement).value,
    ).toBe("sicil");
    expect(shownNames(panel)).toEqual(["Sicilian Defense"]);
    expect(fetchAddable).toHaveBeenCalledTimes(1);

    pickTab(panel, /^From my games/);
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add an opening…" }));
    const again = screen.getByRole("region", { name: "Add an opening" });
    expect(
      within(again).getByRole("tab", { name: "All openings" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(await within(again).findByRole("list", { name: "Against 1.e4" })).toBeTruthy();
    expect(
      (within(again).getByRole("searchbox", { name: "Search openings" }) as HTMLInputElement).value,
    ).toBe("");
  });

  it("moves between the tabs with the arrow keys, Home and End, keeping only the chosen one in the tab order", async () => {
    renderPage();
    const { panel } = await openPanel();
    const all = within(panel).getByRole("tab", { name: "All openings" });
    const mine = within(panel).getByRole("tab", { name: /^From my games/ });
    expect([all.tabIndex, mine.tabIndex]).toEqual([0, -1]);

    fireEvent.keyDown(all, { key: "ArrowRight" });
    expect(mine.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(mine);
    expect([all.tabIndex, mine.tabIndex]).toEqual([-1, 0]);
    fireEvent.keyDown(mine, { key: "ArrowRight" });
    expect(all.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(all, { key: "ArrowLeft" });
    expect(mine.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(mine, { key: "Home" });
    expect(all.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(all, { key: "End" });
    expect(mine.getAttribute("aria-selected")).toBe("true");
  });

  it("reads the list of every opening when the panel opens and not with the page", async () => {
    const { fetchAddable } = renderPage();
    const { panel } = await openPanel();
    expect(fetchAddable).toHaveBeenCalledTimes(1);
    await within(panel).findByRole("list", { name: "Against 1.e4" });
  });
});

describe("All openings", () => {
  it("lists the entries in the order given, under a heading for the path Black leaves, by the length of the root", async () => {
    renderPage();
    const { panel } = await openPanel();
    const first = await within(panel).findByRole("list", { name: "Against 1.e4" });
    const second = within(panel).getByRole("list", { name: "Against 1.e4 e5 2.Nf3" });
    expect(
      within(panel)
        .getAllByRole("heading", { level: 5 })
        .map((heading) => heading.textContent),
    ).toEqual(["Against 1.e4", "Against 1.e4 e5 2.Nf3"]);
    expect(nameAndMoves(first)).toEqual([
      ["Sicilian Defense", "1.e4 c5"],
      ["French Defense", "1.e4 e6"],
      ["Caro-Kann Defense", "1.e4 c6"],
    ]);
    // A later move is written alone: the heading above says the path that leads to it.
    expect(nameAndMoves(second)).toEqual([
      ["Petrov's Defense", "2...Nf6"],
      ["Philidor Defense", "2...d6"],
      ["Latvian Gambit", "2...f5"],
    ]);
  });

  it("writes the pill in the singular for one game and the plural for more, and none for no game", async () => {
    renderPage();
    const { panel } = await openPanel();
    const first = await within(panel).findByRole("list", { name: "Against 1.e4" });
    const second = within(panel).getByRole("list", { name: "Against 1.e4 e5 2.Nf3" });
    const pills = (list: HTMLElement): (string | null)[] =>
      rowsOf(list).map((row) => textOf(row, ".openings-panel__pill"));
    expect(pills(first)).toEqual([null, "1 game of yours", "4 games of yours"]);
    expect(pills(second)).toEqual(["2 games of yours", "1 game of yours", null]);
  });

  it("says In your openings in place of Add for an entry that has a line, and offers Add for the rest", async () => {
    renderPage();
    const { panel } = await openPanel();
    const first = await within(panel).findByRole("list", { name: "Against 1.e4" });
    const [, , built] = rowsOf(first) as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(built).getByText("In your openings")).toBeTruthy();
    expect(within(built).queryByRole("button")).toBeNull();
    expect(
      within(first)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([addLabelOf("Sicilian Defense", "1.e4 c5"), addLabelOf("French Defense", "1.e4 e6")]);
  });

  it("says under the list how it is ordered, by the share at the student's level only where the explorer answered", async () => {
    renderPage();
    const { panel } = await openPanel();
    await within(panel).findByRole("list", { name: "Against 1.e4" });
    expect(
      within(panel).getByText(
        "Black's ways out of your path 1.e4 e5 2.Nf3 Nc6 3.Bc4, the most played at your level first. Add builds the whole line from 1.e4.",
      ),
    ).toBeTruthy();
    cleanup();

    renderPage({
      fetchAddable: async () => ALL_ENTRIES.map((entry) => ({ ...entry, share_0_1199: null })),
    });
    const { panel: unranked } = await openPanel();
    await within(unranked).findByRole("list", { name: "Against 1.e4" });
    expect(
      within(unranked).getByText(
        "Black's ways out of your path 1.e4 e5 2.Nf3 Nc6 3.Bc4, the ones from your games first. Add builds the whole line from 1.e4.",
      ),
    ).toBeTruthy();
  });
});

describe("the search", () => {
  it.each(["sicil", "SICIL", "e4 c5", "1.e4 c5", "1e4 c5", "  1.E4   C5 "])(
    "keeps the Sicilian Defense alone for %j",
    async (text) => {
      renderPage();
      const { panel } = await openPanel();
      await within(panel).findByRole("list", { name: "Against 1.e4" });
      search(panel, text);
      expect(shownNames(panel)).toEqual(["Sicilian Defense"]);
    },
  );

  it.each(["petrov", "nf6", "2...Nf6", "2...nf6", "1.e4 e5 2.Nf3 Nf6"])(
    "finds a later move by its name, the move as the row writes it or the line in full: %j",
    async (text) => {
      renderPage();
      const { panel } = await openPanel();
      await within(panel).findByRole("list", { name: "Against 1.e4" });
      search(panel, text);
      expect(shownNames(panel)).toEqual(["Petrov's Defense"]);
    },
  );

  it("draws no heading for a path left with no row, and none at all with no row left", async () => {
    renderPage();
    const { panel } = await openPanel();
    await within(panel).findByRole("list", { name: "Against 1.e4" });
    search(panel, "petrov");
    expect(
      within(panel)
        .getAllByRole("heading", { level: 5 })
        .map((heading) => heading.textContent),
    ).toEqual(["Against 1.e4 e5 2.Nf3"]);
    expect(within(panel).queryByRole("list", { name: "Against 1.e4" })).toBeNull();

    search(panel, "nf3");
    expect(shownNames(panel)).toEqual(["Petrov's Defense", "Philidor Defense", "Latvian Gambit"]);

    search(panel, "zzz");
    expect(within(panel).getByText("No opening matches.")).toBeTruthy();
    expect(within(panel).queryAllByRole("heading", { level: 5 })).toEqual([]);
    expect(shownNames(panel)).toEqual([]);

    search(panel, "");
    expect(shownNames(panel)).toHaveLength(ALL_ENTRIES.length);
    expect(within(panel).queryByText("No opening matches.")).toBeNull();
  });

  it("asks the server nothing", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const { fetchAddable } = renderPage();
    const { panel } = await openPanel();
    await within(panel).findByRole("list", { name: "Against 1.e4" });
    for (const text of ["s", "si", "sic", "e4", "", "zzz"]) search(panel, text);
    expect(fetchAddable).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
  });

  it("asks for the name or the moves in the field, which has a magnifier", async () => {
    renderPage();
    const { panel } = await openPanel();
    const field = await within(panel).findByRole("searchbox", { name: "Search openings" });
    expect(field.getAttribute("placeholder")).toBe("Search by name or by moves");
    expect(field.parentElement?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("From my games", () => {
  it("counts the openings with no line in its label, and lists them most games first with their games", async () => {
    renderPage();
    const { panel } = await openPanel();
    expect(within(panel).getByRole("tab", { name: "From my games (3)" })).toBeTruthy();
    pickTab(panel, /^From my games/);
    const list = within(panel).getByRole("list", { name: "Openings met in your games" });
    expect(
      rowsOf(list).map((row) => [
        textOf(row, ".openings-panel__opening"),
        textOf(row, ".openings-panel__moves"),
        textOf(row, ".openings-panel__games"),
      ]),
    ).toEqual([
      ["Scandinavian Defense", "1.e4 d5", "4 games"],
      ["Alekhine Defense", "1.e4 Nf6", "2 games"],
      // The book has no name for it, so the line stands for the name and is not written twice.
      ["1.e4 e5 2.Nf3 Bc5", null, "1 game"],
    ]);
    expect(within(list).getAllByRole("button")).toHaveLength(3);
    expect(within(list).queryByText("Caro-Kann Defense")).toBeNull();
    expect(
      within(panel).getByText(
        "Openings your opponents played against you that have no line yet, the most frequent first. The position where the opponent left your line stays in From my games.",
      ),
    ).toBeTruthy();
  });

  it("says every opening has a line when none is left, and keeps the note", async () => {
    renderPage({
      fetchList: async () => answer(repertoireList, [met(["e4", "c6"], "Caro-Kann", 1, 5)]),
    });
    const { panel } = await openPanel();
    expect(within(panel).getByRole("tab", { name: "From my games (0)" })).toBeTruthy();
    pickTab(panel, /^From my games/);
    expect(within(panel).getByText("Every opening from your games has a line.")).toBeTruthy();
    expect(within(panel).queryByRole("list", { name: "Openings met in your games" })).toBeNull();
    expect(within(panel).getByText(/^Openings your opponents played against you/)).toBeTruthy();
  });
});

describe("an Add", () => {
  const stubbedRun = () =>
    vi.fn(async (_root: readonly string[], _points?: StylePoints) => ({ truncated: false }));

  it("asks for the root of its row from either tab, with no points while the split is the default", async () => {
    const addOpening = stubbedRun();
    renderPage({ props: { addOpening } });
    const { white, panel } = await openPanel();
    fireEvent.click(
      await within(panel).findByRole("button", {
        name: addLabelOf("Petrov's Defense", "1.e4 e5 2.Nf3 Nf6"),
      }),
    );
    expect(addOpening).toHaveBeenCalledTimes(1);
    expect(addOpening).toHaveBeenLastCalledWith(["e4", "e5", "Nf3", "Nf6"]);
    expect(addOpening.mock.lastCall).toHaveLength(1);
    await within(white).findByText("Petrov's Defense is built. Its drill is listed above.");

    pickTab(panel, /^From my games/);
    fireEvent.click(
      within(panel).getByRole("button", { name: addLabelOf("Scandinavian Defense", "1.e4 d5") }),
    );
    expect(addOpening).toHaveBeenLastCalledWith(["e4", "d5"]);
    expect(addOpening.mock.lastCall).toHaveLength(1);
    await within(white).findByText("Scandinavian Defense is built. Its drill is listed above.");
  });

  it("posts the root to the repertoire source, and the points only once they are not 2, 2 and 2", async () => {
    const posted = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ repertoire: { truncated: false } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", posted);
    renderPage();
    const { white, panel } = await openPanel();
    const bodyOf = (call: number): unknown =>
      JSON.parse(String(posted.mock.calls[call]?.[1]?.body));

    fireEvent.click(
      await within(panel).findByRole("button", { name: addLabelOf("Sicilian Defense", "1.e4 c5") }),
    );
    await within(white).findByText("Sicilian Defense is built. Its drill is listed above.");
    expect(posted.mock.calls[0]?.[0]).toBe("/api/openings/generate");
    expect(posted.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(bodyOf(0)).toEqual({ sources: ["repertoire"], root: ["e4", "c5"] });

    fireEvent.click(within(panel).getByRole("button", { name: "Style points" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Fewer points for more wins" }));
    fireEvent.click(within(panel).getByRole("button", { name: "More points for less risk" }));
    fireEvent.click(
      within(panel).getByRole("button", { name: addLabelOf("French Defense", "1.e4 e6") }),
    );
    await act(async () => {});
    expect(bodyOf(1)).toEqual({
      sources: ["repertoire"],
      root: ["e4", "e6"],
      points: { effectiveness: 1, soundness: 3, learnability: 2 },
    });

    pickTab(panel, /^From my games/);
    fireEvent.click(
      within(panel).getByRole("button", { name: addLabelOf("Scandinavian Defense", "1.e4 d5") }),
    );
    await act(async () => {});
    expect(posted).toHaveBeenCalledTimes(3);
    expect(bodyOf(2)).toEqual({
      sources: ["repertoire"],
      root: ["e4", "d5"],
      points: { effectiveness: 1, soundness: 3, learnability: 2 },
    });
  });

  it("says Building on its row while the run goes on, holds every other Add and every train button, then builds the card and the row's own state", async () => {
    let finish: () => void = () => undefined;
    const addOpening = vi.fn(
      (_root: readonly string[]) =>
        new Promise<AddedOpening>((resolve) => {
          finish = () => resolve({ truncated: false });
        }),
    );
    const reads = [answer(), answer([...repertoireList, sicilianDrill])];
    const fetchList = vi.fn(async () => reads.shift() ?? answer());
    const fetchAddable = vi
      .fn<FetchAddableOpenings>()
      .mockResolvedValueOnce(ALL_ENTRIES)
      .mockResolvedValue(
        ALL_ENTRIES.map((entry) => (entry === sicilian ? { ...entry, repertoire_id: 7 } : entry)),
      );
    renderPage({ fetchAddable, fetchList, props: { addOpening } });
    const { white, panel } = await openPanel();
    fireEvent.click(
      await within(panel).findByRole("button", { name: addLabelOf("Sicilian Defense", "1.e4 c5") }),
    );

    const building = within(panel).getByRole("button", {
      name: "Building Sicilian Defense, 1.e4 c5",
    });
    expect(building.textContent).toBe("Building");
    expect(isDisabled(building)).toBe(true);
    expect(
      isDisabled(
        within(panel).getByRole("button", { name: addLabelOf("French Defense", "1.e4 e6") }),
      ),
    ).toBe(true);
    expect(within(white).getByRole("status").textContent).toBe(
      "Building the drill. This takes a few minutes.",
    );
    const trains = within(white).getAllByRole("button", { name: /^(Train|More ways to train)/ });
    expect(trains.length).toBeGreaterThan(1);
    for (const train of trains) expect(isDisabled(train)).toBe(true);
    expect(within(white).queryByRole("article", { name: "Sicilian Defense" })).toBeNull();

    await act(async () => finish());
    expect(await within(white).findByRole("article", { name: "Sicilian Defense" })).toBeTruthy();
    expect(within(white).getByRole("status").textContent).toBe(
      "Sicilian Defense is built. Its drill is listed above.",
    );
    for (const train of within(white).getAllByRole("button", {
      name: /^(Train|More ways to train)/,
    })) {
      expect(isDisabled(train)).toBe(false);
    }
    // The list was read again with the run, so the row that was built says so.
    const first = within(panel).getByRole("list", { name: "Against 1.e4" });
    await waitFor(() => expect(within(first).getAllByText("In your openings")).toHaveLength(2));
    expect(fetchList).toHaveBeenCalledTimes(2);
    expect(fetchAddable).toHaveBeenCalledTimes(2);
  });

  it("says why a run failed and keeps Add on offer, even where the list already names a line for the root", async () => {
    const addOpening = vi
      .fn<(root: readonly string[]) => Promise<AddedOpening>>()
      .mockRejectedValueOnce(new Error("the explorer wants a Lichess API token"))
      .mockResolvedValueOnce({ truncated: false });
    const named = ALL_ENTRIES.map((entry) =>
      entry === sicilian ? { ...entry, repertoire_id: 7 } : entry,
    );
    const fetchAddable = vi
      .fn<FetchAddableOpenings>()
      .mockResolvedValueOnce(ALL_ENTRIES)
      .mockResolvedValue(named);
    renderPage({ fetchAddable, props: { addOpening } });
    const { white, panel } = await openPanel();
    const label = addLabelOf("Sicilian Defense", "1.e4 c5");
    fireEvent.click(await within(panel).findByRole("button", { name: label }));

    const alert = await within(white).findByRole("alert");
    expect(alert.textContent).toBe("the explorer wants a Lichess API token");
    const again = await within(panel).findByRole("button", { name: label });
    expect(isDisabled(again)).toBe(false);

    fireEvent.click(again);
    await within(white).findByText("Sicilian Defense is built. Its drill is listed above.");
    expect(addOpening).toHaveBeenCalledTimes(2);
    // Only a run that ended well leaves the row saying it is in the student's openings.
    expect(within(panel).queryByRole("button", { name: label })).toBeNull();
    expect(
      within(within(panel).getByRole("list", { name: "Against 1.e4" })).getAllByText(
        "In your openings",
      ),
    ).toHaveLength(2);
  });

  it("says so when a run stopped at its request limit, and keeps Add to carry on", async () => {
    const addOpening = vi
      .fn<(root: readonly string[]) => Promise<AddedOpening>>()
      .mockResolvedValueOnce({ truncated: true });
    const partial = ALL_ENTRIES.map((entry) =>
      entry === philidor ? { ...entry, repertoire_id: 9 } : entry,
    );
    renderPage({
      fetchAddable: vi
        .fn<FetchAddableOpenings>()
        .mockResolvedValueOnce(ALL_ENTRIES)
        .mockResolvedValue(partial),
      props: { addOpening },
    });
    const { white, panel } = await openPanel();
    const label = addLabelOf("Philidor Defense", "1.e4 e5 2.Nf3 d6");
    fireEvent.click(await within(panel).findByRole("button", { name: label }));
    const stopped = await within(white).findByRole("alert");
    expect(stopped.textContent).toBe(
      "The run for Philidor Defense stopped at its request limit. Add it again to carry on.",
    );
    expect(isDisabled(await within(panel).findByRole("button", { name: label }))).toBe(false);
  });

  it("waits for a start in flight before it adds, from either tab", async () => {
    renderPage({ props: { busy: true } });
    const { panel } = await openPanel();
    const label = addLabelOf("Sicilian Defense", "1.e4 c5");
    expect(isDisabled(await within(panel).findByRole("button", { name: label }))).toBe(true);
    pickTab(panel, /^From my games/);
    expect(
      isDisabled(
        within(panel).getByRole("button", { name: addLabelOf("Scandinavian Defense", "1.e4 d5") }),
      ),
    ).toBe(true);
  });
});

describe("the style points in the panel", () => {
  it("sit under the header and above the list of the tab, and hold every Add until all 6 points are placed", async () => {
    renderPage();
    const { panel } = await openPanel();
    const head = panel.querySelector(".openings-panel__head") as HTMLElement;
    const toggle = within(panel).getByRole("button", { name: "Style points" });
    const body = within(panel).getByRole("tabpanel", { name: "All openings" });
    expect(follows(head, toggle)).toBe(true);
    expect(follows(toggle, body)).toBe(true);

    const firstAdd = await within(panel).findByRole("button", {
      name: addLabelOf("Sicilian Defense", "1.e4 c5"),
    });
    expect(isDisabled(firstAdd)).toBe(false);
    fireEvent.click(toggle);
    fireEvent.click(within(panel).getByRole("button", { name: "Fewer points for more wins" }));
    expect(panel.textContent).toContain("1 point left to place");
    expect(isDisabled(firstAdd)).toBe(true);
    pickTab(panel, /^From my games/);
    const mineAdd = within(panel).getByRole("button", {
      name: addLabelOf("Scandinavian Defense", "1.e4 d5"),
    });
    expect(isDisabled(mineAdd)).toBe(true);

    fireEvent.click(within(panel).getByRole("button", { name: "More points for less risk" }));
    expect(isDisabled(mineAdd)).toBe(false);
    expect(isDisabled(firstAdd)).toBe(false);
  });
});

describe("a list that could not be read", () => {
  it("says so in the error tone with Try again in the first tab, while the second tab still works", async () => {
    const fetchAddable = vi
      .fn<FetchAddableOpenings>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(ALL_ENTRIES);
    // A run that is still going on, so no end of an add asks for the list again meanwhile.
    const addOpening = vi.fn(
      (_root: readonly string[]) => new Promise<AddedOpening>(() => undefined),
    );
    renderPage({ fetchAddable, props: { addOpening } });
    const { panel } = await openPanel();
    const alert = await within(panel).findByRole("alert");
    expect(alert.textContent).toBe("The list of openings could not be loaded.");
    expect(alert.className).toContain("practice__failure");
    expect(within(panel).queryByRole("searchbox")).toBeNull();

    pickTab(panel, /^From my games/);
    fireEvent.click(
      within(panel).getByRole("button", { name: addLabelOf("Scandinavian Defense", "1.e4 d5") }),
    );
    expect(addOpening).toHaveBeenCalledWith(["e4", "d5"]);

    pickTab(panel, "All openings");
    fireEvent.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(within(panel).getByRole("status").textContent).toBe("Loading the list of openings.");
    expect(await within(panel).findByRole("list", { name: "Against 1.e4" })).toBeTruthy();
    expect(within(panel).queryByRole("alert")).toBeNull();
  });

  it("says it is loading while the list is read, with no search field yet", async () => {
    renderPage({ fetchAddable: () => new Promise<AddableOpening[]>(() => undefined) });
    const { panel } = await openPanel();
    expect(within(panel).getByRole("status").textContent).toBe("Loading the list of openings.");
    expect(within(panel).queryByRole("searchbox")).toBeNull();
  });

  it("keeps its place with a sentence when the server lists no opening", async () => {
    renderPage({ fetchAddable: async () => [] });
    const { panel } = await openPanel();
    expect(await within(panel).findByText("No opening is available to add.")).toBeTruthy();
    expect(within(panel).queryByRole("searchbox")).toBeNull();
    expect(within(panel).queryByText("No opening matches.")).toBeNull();
  });
});

describe("the call behind the list", () => {
  const answering = (status: number, body: unknown) => {
    const fetched = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }),
    );
    vi.stubGlobal("fetch", fetched);
    return fetched;
  };

  it("reads the entries of GET /api/openings/addable", async () => {
    const fetched = answering(200, { entries: ALL_ENTRIES });
    await expect(fetchAddableOpeningsFromServer()).resolves.toEqual(ALL_ENTRIES);
    expect(fetched.mock.calls[0]?.[0]).toBe("/api/openings/addable");
  });

  it("fails on a refusal and on an answer that is not the list", async () => {
    answering(500, {});
    await expect(fetchAddableOpeningsFromServer()).rejects.toThrow("addable openings: 500");
    answering(200, { entries: [{ root: [], opening_name: "x" }] });
    await expect(fetchAddableOpeningsFromServer()).rejects.toThrow();
  });
});

describe("the view of the list", () => {
  it("groups by the position Black leaves, the shorter path first, with every entry kept in the order given", () => {
    const deeper = addable(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"], "Giuoco Piano");
    expect(
      addableGroupsOf([petrov, deeper, sicilian, philidor, french]).map((group) => [
        group.path,
        group.entries.map((entry) => entry.opening_name),
      ]),
    ).toEqual([
      ["1.e4", ["Sicilian Defense", "French Defense"]],
      ["1.e4 e5 2.Nf3", ["Petrov's Defense", "Philidor Defense"]],
      ["1.e4 e5 2.Nf3 Nc6 3.Bc4", ["Giuoco Piano"]],
    ]);
    expect(addableGroupsOf([])).toEqual([]);
  });

  it("compares lower case, without the dots of the move numbers and with one space between words", () => {
    expect(addableMatches(sicilian, "")).toBe(true);
    expect(addableMatches(sicilian, " . ")).toBe(true);
    expect(addableMatches(sicilian, "Sicilian Defense")).toBe(true);
    expect(addableMatches(sicilian, "sicilian  defense")).toBe(true);
    expect(addableMatches(sicilian, "defense sicilian")).toBe(false);
    expect(addableMatches(sicilian, "e4 c6")).toBe(false);
    // The text is in the name or in the moves, never across the two.
    expect(addableMatches(sicilian, "defense 1.e4")).toBe(false);
  });
});

describe("its stylesheet", () => {
  const css = readFileSync(
    join(import.meta.dirname, "../src/styles/practice-openings.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
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

  it("draws the panel as a surface with 16 px and 20 px of padding and its parts 10 px apart", () => {
    expect(declared(desktop, ".openings-panel")).toMatchObject({
      border: "1px solid var(--border)",
      "border-radius": "var(--radius-md)",
      padding: "var(--space-4) 20px",
      gap: "10px",
    });
    expect(declared(desktop, ".openings-panel__title")).toMatchObject({
      "font-size": "var(--text-md)",
      "font-weight": "500",
    });
  });

  it("sizes the tabs and Close at 30 px, the tab text at 13 px and the search field at 36 px", () => {
    expect(declared(desktop, ".openings-panel__tabs")).toMatchObject({ height: "30px" });
    expect(declared(desktop, ".openings-panel__tab")).toMatchObject({ "font-size": "13px" });
    expect(declared(desktop, ".openings-panel__close")).toMatchObject({ height: "30px" });
    expect(declared(desktop, ".openings-panel__add")).toMatchObject({ height: "30px" });
    expect(declared(desktop, ".openings-panel__search-input")).toMatchObject({ height: "36px" });
  });

  it("lays a row in three columns 12 px apart with 7 px of padding and a hairline under it", () => {
    expect(declared(desktop, ".openings-panel__row")).toMatchObject({
      display: "grid",
      "grid-template-columns": "minmax(0, 1fr) auto auto",
      gap: "12px",
      padding: "7px 0",
      "border-bottom": "1px solid var(--border)",
    });
  });

  it("sets the name at 14 px, its moves in the mono face at 12 px, the pill at 11 px and the headings at 12 px", () => {
    expect(declared(desktop, ".openings-panel__opening")).toMatchObject({
      "font-size": "var(--text-sm)",
    });
    expect(declared(desktop, ".openings-panel__moves")).toMatchObject({
      "font-family": "var(--font-mono)",
      "font-size": "var(--text-xs)",
    });
    expect(declared(desktop, ".openings-panel__pill")).toMatchObject({ "font-size": "11px" });
    expect(declared(desktop, ".openings-panel__games")).toMatchObject({
      "font-size": "var(--text-xs)",
    });
    expect(declared(desktop, ".openings-panel__group-title")).toMatchObject({
      "font-size": "var(--text-xs)",
    });
    expect(declared(desktop, ".openings-panel__foot")).toMatchObject({
      "font-size": "var(--text-xs)",
    });
  });

  it("hides the tab that is not chosen even though its rule sets a display", () => {
    expect(declared(desktop, ".openings-panel__body")).toMatchObject({ display: "flex" });
    expect(declared(desktop, ".openings-panel__body[hidden]")).toMatchObject({ display: "none" });
  });

  it("keeps the name, the pill and Add of a row on one line under 900 px, with the moves under the name", () => {
    expect(phoneAt).toBeGreaterThan(0);
    expect(declared(phone, ".openings-panel__name")).toMatchObject({ "flex-direction": "column" });
    // Nothing under 900 px redraws the row's columns or takes the pill or the button out of it.
    for (const kept of [".openings-panel__row", ".openings-panel__pill", ".openings-panel__add"]) {
      expect(declared(phone, kept)).toEqual({});
    }
  });

  it("keeps 44 px targets for the tabs, Add and Close under 900 px", () => {
    expect(declared(phone, ".openings-panel__tab")).toMatchObject({ "min-height": "44px" });
    expect(declared(phone, ".openings-panel .button")).toMatchObject({ "min-height": "44px" });
  });
});

describe("its design check", () => {
  it("records the re-check of the Practice column and of the Phone column for the panel", () => {
    const check = readFileSync(join(import.meta.dirname, "../DESIGN-CHECK.md"), "utf8");
    const recheck = check
      .split(/\n\s*\n/)
      .map((paragraph) => paragraph.replace(/\s+/g, " "))
      .find((paragraph) => paragraph.includes("for the panel that Add an opening opens"));
    expect(recheck).toMatch(
      /^The Practice column was re-checked on rows [\d, and]+, and the Phone column on row 19/,
    );
    expect(recheck).toContain("M1 and M2 still find no matches.");
  });
});
