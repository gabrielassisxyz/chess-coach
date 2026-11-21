import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CoveragePosition,
  CoverageReply,
  RepertoireCoverage,
  RepertoireGroupSummary,
  RepertoireSummary,
  RepertoiresResponse,
} from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PracticeHub } from "../src/components/PracticeHub.js";
import {
  PracticeOpenings,
  type PracticeOpeningsProps,
} from "../src/components/PracticeOpenings.js";
import { rebuildNamesLine } from "../src/state/line-rebuild.js";
import { NONE } from "../src/state/practice.js";
import { PRACTICE_PAGE_STORAGE_KEY } from "../src/state/practice-page.js";
import {
  type RebuildLine,
  RunRefusedError,
  rebuildLineOnServer,
  stylePointsLeftText,
  stylePointsText,
} from "../src/state/repertoires-api.js";
import { openPracticePage, progressOf } from "./practice-fixtures.js";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const PIANISSIMO = "Giuoco Pianissimo (4.d3)";
const TWO_KNIGHTS = "Two Knights Defense (4.Ng5)";
const SETUP = ["e4", "e5", "Nf3", "Nc6", "Bc4"];
const KNIGHTS_BRANCH = [...SETUP, "Nf6", "Ng5"];

const pianissimo: RepertoireSummary = {
  id: 4,
  side: "white",
  group_name: "Italian Game",
  variation_name: PIANISSIMO,
  moves: { recommended: 2, due: 3, all: 24 },
  moves_total: 24,
  remembered_30d: { right: 5, of: 7 },
  in_line: { stayed: 16, of: 20 },
  covered_percent: 100,
  line: "3...Bc5 4.d3",
  points: { effectiveness: 2, soundness: 2, learnability: 2 },
  root: null,
  branch: null,
};
const twoKnights: RepertoireSummary = {
  id: 5,
  side: "white",
  group_name: "Italian Game",
  variation_name: TWO_KNIGHTS,
  moves: { recommended: 3, due: 5, all: 15 },
  moves_total: 15,
  remembered_30d: { right: 11, of: 21 },
  in_line: { stayed: 6, of: 10 },
  covered_percent: 87.4,
  line: "3...Nf6 4.Ng5",
  points: { effectiveness: 3, soundness: 2, learnability: 1 },
  root: null,
  branch: KNIGHTS_BRANCH,
};
const scandinavian: RepertoireSummary = {
  id: 8,
  side: "white",
  group_name: "Scandinavian Defense",
  variation_name: "Mieses-Kotroc Variation (2.exd5)",
  moves: { recommended: 1, due: 1, all: 6 },
  moves_total: 6,
  line: "2.exd5",
  points: null,
  root: ["e4", "d5"],
  branch: null,
};

// A line read from a PGN file: no root, no branch and no points, and the oldest of its group, which
// is what made the generated line that posts neither look rebuildable.
const imported: RepertoireSummary = {
  id: 12,
  side: "white",
  group_name: "London System",
  variation_name: "London System: Main Line",
  origin: "pgn",
  moves: { recommended: 4, due: 6, all: 30 },
  moves_total: 30,
  remembered_30d: { right: 3, of: 5 },
  in_line: { stayed: 2, of: 4 },
  covered_percent: null,
  line: null,
  points: null,
  root: null,
  branch: null,
};

const italianGroup: RepertoireGroupSummary = {
  side: "white",
  group_name: "Italian Game",
  moves: { recommended: 5, due: 8, all: 39 },
  moves_total: 39,
  remembered_30d: { right: 16, of: 28 },
  in_line: { stayed: 22, of: 30 },
  covered_percent: 100,
  line: "1.e4 e5 2.Nf3 Nc6 3.Bc4",
};
const scandinavianGroup: RepertoireGroupSummary = {
  side: "white",
  group_name: "Scandinavian Defense",
  moves: { recommended: 1, due: 1, all: 6 },
  line: "1.e4 d5",
};

const answer = (overrides: Partial<RepertoiresResponse> = {}): RepertoiresResponse => ({
  repertoires: [pianissimo, twoKnights],
  groups: [italianGroup],
  sides: [{ side: "white", moves: { recommended: 5, due: 8, all: 39 } }],
  met: [],
  branches: [],
  rebuilding_id: null,
  ...overrides,
});

const reply = (overrides: Partial<CoverageReply> & Pick<CoverageReply, "san">): CoverageReply => ({
  incidence: 0.3,
  status: "covered",
  source: "explorer",
  next: null,
  ...overrides,
});

// 3.Bc4 is where Black starts to choose: 3...Bc5 is answered, 3...Nf6 and 3...d6 are not, and 3...h6
// is rarer than 1 in 50. 4.d3 is the position behind 3...Bc5.
const POSITIONS: CoveragePosition[] = [
  {
    line: ["e4"],
    parent: null,
    replies: [reply({ san: "e5", incidence: 1, source: "setup", next: 1 })],
  },
  {
    line: ["e4", "e5", "Nf3"],
    parent: 0,
    replies: [reply({ san: "Nc6", incidence: 1, source: "setup", next: 2 })],
  },
  {
    line: SETUP,
    parent: 1,
    replies: [
      reply({ san: "Bc5", incidence: 0.4, next: 3 }),
      reply({ san: "Nf6", incidence: 0.25, status: "gap" }),
      reply({ san: "d6", incidence: 0.02, status: "gap" }),
      reply({ san: "h6", incidence: 0.0199, status: "not_required" }),
    ],
  },
  {
    line: [...SETUP, "Bc5", "d3"],
    parent: 2,
    replies: [reply({ san: "Nf6", incidence: 0.2 })],
  },
];

const coverage = (overrides: Partial<RepertoireCoverage> = {}): RepertoireCoverage => ({
  repertoire_id: 4,
  goal_one_in: 50,
  rating_band: "0-1199",
  covered_percent: 66.7,
  gaps: [
    { line: [...SETUP, "Nf6"], incidence: 0.25, position: 2 },
    { line: [...SETUP, "d6"], incidence: 0.02, position: 2 },
  ],
  largest_gap: { line: [...SETUP, "Nf6"], incidence: 0.25, position: 2 },
  scores: { line_ends: 2, expected_score: 80.2, soundness: 99 },
  start: 2,
  positions: POSITIONS,
  ...overrides,
});

type ListRead = () => Promise<RepertoiresResponse>;

interface RenderOptions {
  listed?: RepertoiresResponse | ListRead;
  // The variation open when the page first draws, or null for the list.
  open?: number | null;
  props?: Partial<PracticeOpeningsProps>;
  fetchCoverage?: (id: number) => Promise<RepertoireCoverage>;
}

// A parent that holds which line is open, as the hub does.
function Harness({
  initial,
  props,
}: {
  initial: number | null;
  props: Omit<PracticeOpeningsProps, "lines">;
}) {
  const [open, setOpen] = useState<number | null>(initial);
  return (
    <PracticeOpenings {...props} lines={{ open, onOpen: setOpen, onClose: () => setOpen(null) }} />
  );
}

function renderLine(options: RenderOptions = {}) {
  const { listed = answer(), open = 4, props = {} } = options;
  const onStart = vi.fn();
  const fetchList = vi.fn<ListRead>(typeof listed === "function" ? listed : async () => listed);
  const fetchCoverage = vi.fn(options.fetchCoverage ?? (async (_id: number) => coverage()));
  render(
    <Harness
      initial={open}
      props={{
        busy: false,
        starting: null,
        onStart,
        fetchList,
        fetchCoverage,
        fetchAddable: async () => [],
        ...props,
      }}
    />,
  );
  return { onStart, fetchList, fetchCoverage };
}

const pageOf = (name: string = PIANISSIMO): Promise<HTMLElement> =>
  screen.findByRole("region", { name });
const coverageOf = (page: HTMLElement): HTMLElement =>
  within(page).getByRole("region", { name: "Coverage" });
const styleOf = (page: HTMLElement): HTMLElement =>
  within(page).getByRole("region", { name: "Style of this line" });
const isDisabled = (element: HTMLElement): boolean => (element as HTMLButtonElement).disabled;

const tilesOf = (page: HTMLElement): string[][] =>
  [...page.querySelectorAll(".line-tile")].map((tile) => [
    tile.querySelector(".line-tile__label")?.textContent ?? "",
    tile.querySelector(".line-tile__value")?.textContent ?? "",
  ]);

const repliesOf = (card: HTMLElement): string[] =>
  within(within(card).getByRole("list", { name: "Black's replies" }))
    .getAllByRole("listitem")
    .map((row) => row.textContent ?? "");

const pointsOf = (card: HTMLElement): string[] =>
  [...card.querySelectorAll(".repertoire-menu__points-value")].map(
    (value) => value.textContent ?? "",
  );

const rebuildButton = (card: HTMLElement): HTMLElement =>
  within(card).getByRole("button", { name: /^Rebuild/ });

// Pressing a stepper of a measure by the label the control gives it.
const stepper = (card: HTMLElement, direction: "Fewer" | "More", measure: string): HTMLElement =>
  within(card).getByRole("button", { name: `${direction} points for ${measure}` });

const FINISHED = { repertoire: { truncated: false } };
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A rebuild whose request stays open until the test ends it, which is how it is for minutes.
function heldRebuild() {
  let finish: (response: Response) => void = () => undefined;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetched = vi.fn(async (_url: string, _init?: RequestInit) => pending);
  vi.stubGlobal("fetch", fetched);
  return {
    fetched,
    end: async (response: Response): Promise<void> => {
      await act(async () => {
        finish(response);
        await pending;
      });
    },
  };
}

function answeringWith(response: () => Response | Promise<Response>) {
  const fetched = vi.fn(async (_url: string, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetched);
  return fetched;
}

type Fetched = ReturnType<typeof answeringWith>;

// The body the nth request carried, parsed.
const bodyOf = (fetched: Fetched, call = 0): unknown =>
  JSON.parse(String(fetched.mock.calls[call]?.[1]?.body));

describe("the way into the page and back to the list", () => {
  it("opens the page of a variation from its name in the list, with the breadcrumb, the name and its line", async () => {
    renderLine({ open: null });
    const italian = await screen.findByRole("article", { name: "Italian Game" });
    fireEvent.click(within(italian).getByRole("button", { name: "Italian Game" }));
    fireEvent.click(within(italian).getByRole("button", { name: PIANISSIMO }));

    const page = await pageOf();
    const crumbs = within(within(page).getByRole("navigation", { name: "Breadcrumb" }));
    expect(crumbs.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Openings",
      "Italian Game",
    ]);
    expect(within(page).getByRole("heading", { level: 2, name: PIANISSIMO })).toBeTruthy();
    const line = page.querySelector(".line-page__line");
    expect(line?.textContent).toBe("3...Bc5 4.d3");
    // The list is not on screen while the page is, and nothing of it is read as the page.
    expect(screen.queryByRole("heading", { level: 2, name: "Openings" })).toBeNull();
    expect(screen.queryByRole("region", { name: "White" })).toBeNull();
  });

  it("returns to the list when Openings in the breadcrumb is pressed, with the card as it was left", async () => {
    renderLine({ open: null });
    const italian = await screen.findByRole("article", { name: "Italian Game" });
    fireEvent.click(within(italian).getByRole("button", { name: "Italian Game" }));
    fireEvent.click(within(italian).getByRole("button", { name: PIANISSIMO }));
    const page = await pageOf();

    fireEvent.click(within(page).getByRole("button", { name: "Openings" }));
    expect(screen.queryByRole("region", { name: PIANISSIMO })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Openings" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "White" })).toBeTruthy();
    expect(
      within(screen.getByRole("article", { name: "Italian Game" }))
        .getByRole("button", { name: "Italian Game" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("reads the list again as the page opens, so a rebuild another tab started is found", async () => {
    const { fetchList } = renderLine({ open: null });
    const italian = await screen.findByRole("article", { name: "Italian Game" });
    expect(fetchList).toHaveBeenCalledTimes(1);
    fireEvent.click(within(italian).getByRole("button", { name: "Italian Game" }));
    fireEvent.click(within(italian).getByRole("button", { name: PIANISSIMO }));
    await pageOf();
    expect(fetchList).toHaveBeenCalledTimes(2);
  });

  it("draws a line with no moves of its own without the line, and says so for a variation the list no longer holds", async () => {
    renderLine({ listed: answer({ repertoires: [{ ...pianissimo, line: null }, twoKnights] }) });
    const page = await pageOf();
    expect(page.querySelector(".line-page__line")).toBeNull();
    cleanup();

    renderLine({ listed: answer({ repertoires: [twoKnights] }), open: 4 });
    const gone = await screen.findByText("This line is no longer stored.");
    expect(gone).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Openings" }));
    expect(screen.getByRole("region", { name: "White" })).toBeTruthy();
  });

  it("waits for the list before it draws a page, and draws none while the list cannot be read", async () => {
    renderLine({ listed: () => new Promise<RepertoiresResponse>(() => undefined) });
    expect(screen.getByRole("status").textContent).toBe("Loading your openings.");
    expect(screen.queryByRole("region", { name: PIANISSIMO })).toBeNull();
    cleanup();

    renderLine({ listed: async () => Promise.reject(new Error("down")) });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Your openings could not be loaded.",
    );
    expect(screen.queryByRole("region", { name: PIANISSIMO })).toBeNull();
  });
});

describe("the Train button of the page", () => {
  it("reads Train N with the variation's recommended count and sends the variation with no level", async () => {
    const { onStart } = renderLine();
    const page = await pageOf();
    const train = within(page).getByRole("button", { name: `Train 2, ${PIANISSIMO}` });
    expect(train.textContent).toBe("Train 2");
    fireEvent.click(train);
    expect(onStart).toHaveBeenLastCalledWith(4, "recommended");
    expect(onStart.mock.lastCall).toHaveLength(2);

    fireEvent.click(
      within(page).getByRole("button", { name: `More ways to train, ${PIANISSIMO}` }),
    );
    expect(
      within(within(page).getByRole("group", { name: `Train ${PIANISSIMO}` }))
        .getAllByRole("button")
        .map((entry) => entry.textContent),
    ).toEqual(["Everything due 3", "All moves 24"]);
    fireEvent.click(within(page).getByRole("button", { name: "Everything due 3" }));
    expect(onStart).toHaveBeenLastCalledWith(4, "due");
  });

  it("offers Most missed between Everything due and All moves when the variation has moves missed, and sends it with no level", async () => {
    const { onStart } = renderLine({
      listed: answer({
        repertoires: [
          { ...pianissimo, moves: { recommended: 2, due: 3, all: 24, missed: 4 } },
          twoKnights,
        ],
      }),
    });
    const page = await pageOf();
    fireEvent.click(
      within(page).getByRole("button", { name: `More ways to train, ${PIANISSIMO}` }),
    );
    expect(
      within(within(page).getByRole("group", { name: `Train ${PIANISSIMO}` }))
        .getAllByRole("button")
        .map((entry) => entry.textContent),
    ).toEqual(["Everything due 3", "Most missed 4", "All moves 24"]);
    fireEvent.click(within(page).getByRole("button", { name: "Most missed 4" }));
    expect(onStart).toHaveBeenLastCalledWith(4, "missed");
    expect(onStart.mock.lastCall).toHaveLength(2);
  });

  it("leaves Most missed out of the menu when the variation has no such move", async () => {
    renderLine({
      listed: answer({
        repertoires: [
          { ...pianissimo, moves: { recommended: 2, due: 3, all: 24, missed: 0 } },
          twoKnights,
        ],
      }),
    });
    const page = await pageOf();
    fireEvent.click(
      within(page).getByRole("button", { name: `More ways to train, ${PIANISSIMO}` }),
    );
    expect(
      within(within(page).getByRole("group", { name: `Train ${PIANISSIMO}` }))
        .getAllByRole("button")
        .map((entry) => entry.textContent),
    ).toEqual(["Everything due 3", "All moves 24"]);
  });

  it("trains all moves with nothing recommended, and waits while a start is in flight", async () => {
    const { onStart } = renderLine({
      listed: answer({
        repertoires: [{ ...pianissimo, moves: { recommended: 0, due: 0, all: 24 } }, twoKnights],
      }),
    });
    const page = await pageOf();
    fireEvent.click(within(page).getByRole("button", { name: `Train all moves, ${PIANISSIMO}` }));
    expect(onStart).toHaveBeenLastCalledWith(4, "all");
    cleanup();

    renderLine({ props: { busy: true } });
    const busy = await pageOf();
    expect(isDisabled(within(busy).getByRole("button", { name: `Train 2, ${PIANISSIMO}` }))).toBe(
      true,
    );
  });
});

describe("the five tiles", () => {
  it("show the moves, the moves due, what was remembered, the games stayed in and the coverage, in that order", async () => {
    renderLine();
    expect(tilesOf(await pageOf())).toEqual([
      ["Moves in the line", "24"],
      ["Due now", "3"],
      ["Remembered in 30 days", "5 of 7"],
      ["In line", "16 of 20 games"],
      ["Coverage", "100%"],
    ]);
  });

  it("round the coverage to a whole percentage and write one game in the singular", async () => {
    renderLine({
      listed: answer({
        repertoires: [{ ...pianissimo, covered_percent: 87.4, in_line: { stayed: 1, of: 1 } }],
      }),
    });
    const tiles = tilesOf(await pageOf());
    expect(tiles[3]).toEqual(["In line", "1 of 1 game"]);
    expect(tiles[4]).toEqual(["Coverage", "87%"]);
  });

  it("hold the no-value dash for a figure that was not measured, and still count the moves due", async () => {
    const bare: RepertoireSummary = {
      id: 4,
      side: "white",
      group_name: "Italian Game",
      variation_name: PIANISSIMO,
      moves: { recommended: 0, due: 0, all: 3 },
    };
    renderLine({ listed: answer({ repertoires: [bare] }) });
    expect(tilesOf(await pageOf())).toEqual([
      ["Moves in the line", NONE],
      ["Due now", "0"],
      ["Remembered in 30 days", NONE],
      ["In line", NONE],
      ["Coverage", NONE],
    ]);
    cleanup();

    renderLine({
      listed: answer({
        repertoires: [
          {
            ...pianissimo,
            remembered_30d: { right: 0, of: 0 },
            in_line: { stayed: 0, of: 0 },
            covered_percent: null,
          },
        ],
      }),
    });
    const tiles = tilesOf(await pageOf());
    expect(tiles.slice(2)).toEqual([
      ["Remembered in 30 days", NONE],
      ["In line", NONE],
      ["Coverage", NONE],
    ]);
  });

  it("mark the moves due in the accent above 0 and in no colour at 0", async () => {
    renderLine();
    const accented = (page: HTMLElement): boolean =>
      page
        .querySelector(".line-tile:nth-child(2) .line-tile__value")
        ?.classList.contains("line-tile__accent") ?? false;
    expect(accented(await pageOf())).toBe(true);
    cleanup();
    renderLine({
      listed: answer({
        repertoires: [{ ...pianissimo, moves: { recommended: 0, due: 0, all: 24 } }],
      }),
    });
    expect(accented(await pageOf())).toBe(false);
  });
});

describe("the Coverage card", () => {
  it("reads the coverage of the variation when its page opens, and not before", async () => {
    const { fetchCoverage } = renderLine({ open: null });
    const italian = await screen.findByRole("article", { name: "Italian Game" });
    expect(fetchCoverage).not.toHaveBeenCalled();
    fireEvent.click(within(italian).getByRole("button", { name: "Italian Game" }));
    fireEvent.click(within(italian).getByRole("button", { name: TWO_KNIGHTS }));
    const card = coverageOf(await pageOf(TWO_KNIGHTS));
    expect(await within(card).findByText(/^expected score/)).toBeTruthy();
    expect(fetchCoverage).toHaveBeenCalledTimes(1);
    expect(fetchCoverage).toHaveBeenCalledWith(5);
  });

  it("shows the expected score, the soundness and the largest gap in one line", async () => {
    renderLine();
    const card = coverageOf(await pageOf());
    expect(await within(card).findByText(/^expected score/)).toBeTruthy();
    expect(card.querySelector(".line-coverage__scores")?.textContent).toBe(
      "expected score 80.2% · soundness 99 · largest gap: 3...Nf6, 1 in 4",
    );
    expect(within(card).getByRole("heading", { level: 3, name: "Coverage" })).toBeTruthy();
  });

  it("says none for a line with no gap, and the dash for a score nothing was measured for", async () => {
    renderLine({
      fetchCoverage: async () =>
        coverage({
          gaps: [],
          largest_gap: null,
          scores: { line_ends: 0, expected_score: null, soundness: null },
        }),
    });
    const card = coverageOf(await pageOf());
    await within(card).findByText(/^expected score/);
    expect(card.querySelector(".line-coverage__scores")?.textContent).toBe(
      `expected score ${NONE} · soundness ${NONE} · largest gap: none`,
    );
  });

  it("opens on Black's replies where the line starts to choose, with the move, the chance and the status", async () => {
    renderLine();
    const card = coverageOf(await pageOf());
    await within(card).findByRole("list", { name: "Black's replies" });
    expect(
      within(card).getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent ===
            "Black's replies after 1.e4 e5 2.Nf3 Nc6 3.Bc4, the likeliest first",
      ),
    ).toBeTruthy();
    expect(repliesOf(card)).toEqual([
      "3...Bc5 1 in 3 Covered",
      "3...Nf6 1 in 4 Gap",
      "3...d6 1 in 50 Gap",
      "3...h6 1 in 51 Not required",
    ]);
    const statuses = [...card.querySelectorAll("[data-status]")].map((cell) =>
      cell.getAttribute("data-status"),
    );
    expect(statuses).toEqual(["covered", "gap", "gap", "not_required"]);
  });

  it("makes a reply a button only when the line answers it, and offers no way up from the first move", async () => {
    renderLine({ fetchCoverage: async () => coverage({ start: 0 }) });
    const card = coverageOf(await pageOf());
    await within(card).findByRole("list", { name: "Black's replies" });
    expect(repliesOf(card)).toEqual(["1...e5 Opening move Covered"]);
    expect(within(card).queryByRole("button", { name: "Up one move" })).toBeNull();
    cleanup();

    renderLine();
    const second = coverageOf(await pageOf());
    await within(second).findByRole("list", { name: "Black's replies" });
    const rows = within(within(second).getByRole("list", { name: "Black's replies" })).getAllByRole(
      "listitem",
    );
    expect(rows.map((row) => within(row).queryAllByRole("button").length)).toEqual([1, 0, 0, 0]);
  });

  it("goes down into a covered reply and back up one move", async () => {
    renderLine();
    const card = coverageOf(await pageOf());
    await within(card).findByRole("list", { name: "Black's replies" });
    fireEvent.click(within(card).getByRole("button", { name: /^3\.\.\.Bc5/ }));
    expect(repliesOf(card)).toEqual(["4...Nf6 1 in 5 Covered"]);
    expect(card.textContent).toContain(
      "Black's replies after 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.d3, the likeliest first",
    );

    fireEvent.click(within(card).getByRole("button", { name: "Up one move" }));
    expect(card.textContent).toContain(
      "Black's replies after 1.e4 e5 2.Nf3 Nc6 3.Bc4, the likeliest",
    );
    expect(repliesOf(card)).toHaveLength(4);
    // One more move up reaches the opening's own moves, which have no chance to state.
    fireEvent.click(within(card).getByRole("button", { name: "Up one move" }));
    expect(repliesOf(card)).toEqual(["2...Nc6 Opening move Covered"]);
  });

  it("says so while it loads, when there is nothing stored, and when it cannot be read, with Try again", async () => {
    renderLine({ fetchCoverage: () => new Promise<RepertoireCoverage>(() => undefined) });
    const loading = coverageOf(await pageOf());
    expect(within(loading).getByRole("status").textContent).toBe("Loading the coverage.");
    cleanup();

    renderLine({
      fetchCoverage: async () => coverage({ positions: [], gaps: [], largest_gap: null }),
    });
    expect(
      await within(coverageOf(await pageOf())).findByText(
        "Nothing is stored for this variation yet. Build it first.",
      ),
    ).toBeTruthy();
    cleanup();

    const read = vi
      .fn<(id: number) => Promise<RepertoireCoverage>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(coverage());
    renderLine({ fetchCoverage: read });
    const failed = coverageOf(await pageOf());
    const alert = await within(failed).findByRole("alert");
    expect(alert.textContent).toBe("The coverage could not be loaded.");
    expect(alert.className).toContain("practice__failure");
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(await within(failed).findByRole("list", { name: "Black's replies" })).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("the style card", () => {
  it("says how the line was built and starts the steppers at those points", async () => {
    renderLine({ listed: answer({ repertoires: [pianissimo, twoKnights] }), open: 5 });
    const card = styleOf(await pageOf(TWO_KNIGHTS));
    expect(
      within(card).getByRole("heading", { level: 3, name: "Style of this line" }),
    ).toBeTruthy();
    expect(card.querySelector(".line-style__built")?.textContent).toBe("built with 3 · 2 · 1");
    expect(pointsOf(card)).toEqual(["3", "2", "1"]);
    expect(
      [...card.querySelectorAll(".repertoire-menu__points-name")].map((name) => name.textContent),
    ).toEqual([
      "More winsMoves that score best for White at your level",
      "Less riskMoves that stay closest to the engine's best",
      "More intuitive movesMoves that players at your level choose most often",
    ]);
    expect(card.textContent).toContain(
      "Changing the points changes the moves only after a rebuild.",
    );
  });

  it("says built before style points for a variation stored without them, and starts at 2, 2 and 2", async () => {
    renderLine({
      listed: answer({ repertoires: [scandinavian], groups: [scandinavianGroup] }),
      open: 8,
    });
    const card = styleOf(await pageOf("Mieses-Kotroc Variation (2.exd5)"));
    expect(card.querySelector(".line-style__built")?.textContent).toBe("built before style points");
    expect(pointsOf(card)).toEqual(["2", "2", "2"]);
    cleanup();

    renderLine({ listed: answer({ repertoires: [{ ...pianissimo, points: undefined }] }) });
    const absent = styleOf(await pageOf());
    expect(absent.querySelector(".line-style__built")?.textContent).toBe(
      "built before style points",
    );
  });

  it("moves a point between measures and keeps the rebuild out of reach until all 6 are placed", async () => {
    renderLine();
    const card = styleOf(await pageOf());
    expect(isDisabled(rebuildButton(card))).toBe(false);
    fireEvent.click(stepper(card, "Fewer", "more wins"));
    expect(pointsOf(card)).toEqual(["1", "2", "2"]);
    expect(isDisabled(rebuildButton(card))).toBe(true);
    expect(within(card).getByText("1 point left to place")).toBeTruthy();
    fireEvent.click(stepper(card, "Fewer", "less risk"));
    expect(within(card).getByText("2 points left to place")).toBeTruthy();
    fireEvent.click(stepper(card, "More", "less risk"));
    fireEvent.click(stepper(card, "More", "more intuitive moves"));
    expect(pointsOf(card)).toEqual(["1", "2", "3"]);
    expect(isDisabled(rebuildButton(card))).toBe(false);
    expect(within(card).queryByText(/left to place/)).toBeNull();
  });

  it("writes the split and the points left as the other places that set points do", () => {
    expect(stylePointsText({ effectiveness: 3, soundness: 2, learnability: 1 })).toBe("3 · 2 · 1");
    expect(stylePointsLeftText({ effectiveness: 1, soundness: 2, learnability: 2 })).toBe(
      "1 point left to place",
    );
    expect(stylePointsLeftText({ effectiveness: 0, soundness: 2, learnability: 2 })).toBe(
      "2 points left to place",
    );
    expect(stylePointsLeftText({ effectiveness: 2, soundness: 2, learnability: 2 })).toBeNull();
  });
});

describe("the rebuild", () => {
  it("sends the rebuild of the Italian's first variation with the points as they are, 2, 2 and 2 included", async () => {
    const held = heldRebuild();
    renderLine();
    const card = styleOf(await pageOf());
    fireEvent.click(rebuildButton(card));
    expect(held.fetched).toHaveBeenCalledTimes(1);
    expect(held.fetched.mock.calls[0]?.[0]).toBe("/api/openings/generate");
    expect(held.fetched.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(bodyOf(held.fetched)).toEqual({
      sources: ["repertoire"],
      rebuild: true,
      root: null,
      branch: null,
      points: { effectiveness: 2, soundness: 2, learnability: 2 },
    });
    await held.end(json(FINISHED));
  });

  it("names a variation of the Italian by the branch it was built at, and sends the points that were set", async () => {
    const held = heldRebuild();
    renderLine({ open: 5 });
    const card = styleOf(await pageOf(TWO_KNIGHTS));
    fireEvent.click(stepper(card, "Fewer", "more wins"));
    fireEvent.click(stepper(card, "More", "less risk"));
    fireEvent.click(rebuildButton(card));
    expect(bodyOf(held.fetched)).toEqual({
      sources: ["repertoire"],
      rebuild: true,
      root: null,
      branch: KNIGHTS_BRANCH,
      points: { effectiveness: 2, soundness: 3, learnability: 1 },
    });
    await held.end(json(FINISHED));
  });

  it("names a unit of another opening by its root", async () => {
    const held = heldRebuild();
    renderLine({
      listed: answer({
        repertoires: [pianissimo, twoKnights, scandinavian],
        groups: [italianGroup, scandinavianGroup],
      }),
      open: 8,
    });
    const card = styleOf(await pageOf("Mieses-Kotroc Variation (2.exd5)"));
    fireEvent.click(rebuildButton(card));
    expect(bodyOf(held.fetched)).toMatchObject({ root: ["e4", "d5"], branch: null, rebuild: true });
    await held.end(json(FINISHED));
  });

  it("reads Rebuilding… and keeps the button out of reach while the request is open, with the line that says the old moves still serve", async () => {
    const held = heldRebuild();
    const { onStart } = renderLine();
    const page = await pageOf();
    const card = styleOf(page);
    fireEvent.click(rebuildButton(card));

    const button = within(card).getByRole("button", { name: "Rebuilding…" });
    expect(isDisabled(button)).toBe(true);
    expect(
      within(card).getByText(
        "This line is being rebuilt. It keeps working as it was until the rebuild ends.",
      ),
    ).toBeTruthy();
    // Its old moves serve until the rebuild ends, so the page still trains them.
    const train = within(page).getByRole("button", { name: `Train 2, ${PIANISSIMO}` });
    expect(isDisabled(train)).toBe(false);
    fireEvent.click(train);
    expect(onStart).toHaveBeenLastCalledWith(4, "recommended");

    fireEvent.click(button);
    expect(held.fetched).toHaveBeenCalledTimes(1);
    await held.end(json(FINISHED));
  });

  it("says the line is rebuilt and reads the list and the coverage again when the run ends", async () => {
    const held = heldRebuild();
    const lists = [
      answer(),
      answer({
        repertoires: [
          {
            ...pianissimo,
            moves_total: 30,
            points: { effectiveness: 1, soundness: 3, learnability: 2 },
          },
          twoKnights,
        ],
      }),
    ];
    let reads = 0;
    const { fetchList, fetchCoverage } = renderLine({
      listed: async () => lists[Math.min(reads++, 1)] as RepertoiresResponse,
    });
    const page = await pageOf();
    const card = styleOf(page);
    await within(coverageOf(page)).findByText(/^expected score/);
    expect(fetchList).toHaveBeenCalledTimes(1);
    expect(fetchCoverage).toHaveBeenCalledTimes(1);

    fireEvent.click(stepper(card, "Fewer", "more wins"));
    fireEvent.click(stepper(card, "More", "less risk"));
    fireEvent.click(rebuildButton(card));
    await held.end(json(FINISHED));

    expect(await within(card).findByText("The line is rebuilt.")).toBeTruthy();
    expect(fetchList).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(fetchCoverage).toHaveBeenCalledTimes(2));
    expect(tilesOf(page)[0]).toEqual(["Moves in the line", "30"]);
    expect(card.querySelector(".line-style__built")?.textContent).toBe("built with 1 · 3 · 2");
    expect(isDisabled(rebuildButton(card))).toBe(false);
    expect(within(card).queryByText(/is being rebuilt/)).toBeNull();
  });

  it("says the rebuild stopped before the end, and that the line is as it was, when the answer is truncated", async () => {
    answeringWith(() => json({ repertoire: { truncated: true } }));
    const { fetchList, fetchCoverage } = renderLine();
    const card = styleOf(await pageOf());
    fireEvent.click(rebuildButton(card));
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toBe("The rebuild stopped before the end; the line is as it was.");
    expect(alert.className).toContain("practice__failure");
    expect(within(card).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(fetchList).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(fetchCoverage).toHaveBeenCalledTimes(2));
  });

  it("tells a second run from the server's busy 409, and asks the student to try again when it ends", async () => {
    answeringWith(() =>
      json({ error: "already_running", message: "explorer run in progress" }, 409),
    );
    renderLine();
    const card = styleOf(await pageOf());
    fireEvent.click(rebuildButton(card));
    expect((await within(card).findByRole("alert")).textContent).toBe(
      "Another opening is being built. Try again when it ends.",
    );
    expect(isDisabled(rebuildButton(card))).toBe(false);
  });

  it("says the rebuild failed, with Try again, for any other refusal, a 409 that is not the busy one included", async () => {
    const fetched = answeringWith(() =>
      json({ error: "engine_unavailable", message: "engine down" }, 502),
    );
    renderLine();
    const card = styleOf(await pageOf());
    fireEvent.click(rebuildButton(card));
    expect((await within(card).findByRole("alert")).textContent).toBe(
      "The rebuild failed; the line is as it was.",
    );
    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetched).toHaveBeenCalledTimes(2));
    expect(bodyOf(fetched, 1)).toEqual(bodyOf(fetched, 0));
    cleanup();

    answeringWith(() => json({ error: "branch_refused", message: "no" }, 409));
    renderLine();
    const refused = styleOf(await pageOf());
    fireEvent.click(rebuildButton(refused));
    expect((await within(refused).findByRole("alert")).textContent).toBe(
      "The rebuild failed; the line is as it was.",
    );
  });

  it("says it failed when the connection ends before the run does", async () => {
    vi.stubGlobal("fetch", async () => Promise.reject(new TypeError("network")));
    renderLine();
    const card = styleOf(await pageOf());
    fireEvent.click(rebuildButton(card));
    expect((await within(card).findByRole("alert")).textContent).toBe(
      "The rebuild failed; the line is as it was.",
    );
  });

  it("keeps Try again out of reach while the points are not all placed", async () => {
    answeringWith(() => json({ error: "engine_unavailable", message: "down" }, 502));
    renderLine();
    const card = styleOf(await pageOf());
    fireEvent.click(rebuildButton(card));
    await within(card).findByRole("alert");
    fireEvent.click(stepper(card, "Fewer", "more wins"));
    expect(isDisabled(within(card).getByRole("button", { name: "Try again" }))).toBe(true);
  });

  it("does not show an ending again when the page is opened after it", async () => {
    answeringWith(() => json(FINISHED));
    renderLine();
    const page = await pageOf();
    fireEvent.click(rebuildButton(styleOf(page)));
    await within(styleOf(page)).findByText("The line is rebuilt.");
    fireEvent.click(within(page).getByRole("button", { name: "Openings" }));

    const italian = await screen.findByRole("article", { name: "Italian Game" });
    fireEvent.click(within(italian).getByRole("button", { name: "Italian Game" }));
    fireEvent.click(within(italian).getByRole("button", { name: PIANISSIMO }));
    const again = styleOf(await pageOf());
    expect(within(again).queryByText("The line is rebuilt.")).toBeNull();
  });

  it("is a rebuild of the one variation the server is asked about, whatever the call is made through", async () => {
    const fetched = answeringWith(() => json(FINISHED));
    await expect(
      rebuildLineOnServer(
        { root: null, branch: KNIGHTS_BRANCH },
        { effectiveness: 0, soundness: 6, learnability: 0 },
      ),
    ).resolves.toEqual({ truncated: false });
    expect(bodyOf(fetched)).toEqual({
      sources: ["repertoire"],
      rebuild: true,
      root: null,
      branch: KNIGHTS_BRANCH,
      points: { effectiveness: 0, soundness: 6, learnability: 0 },
    });
  });

  it("refuses with the server's message, marking the busy 409 and no other answer", async () => {
    answeringWith(() =>
      json({ error: "already_running", message: "explorer run in progress" }, 409),
    );
    const busy = await rebuildLineOnServer(
      { root: null, branch: null },
      { effectiveness: 2, soundness: 2, learnability: 2 },
    ).catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(RunRefusedError);
    expect((busy as RunRefusedError).message).toBe("explorer run in progress");
    expect((busy as RunRefusedError).alreadyRunning).toBe(true);

    answeringWith(() => json({ error: "already_running", message: "x" }, 502));
    const elsewhere = await rebuildLineOnServer(
      { root: null, branch: null },
      { effectiveness: 2, soundness: 2, learnability: 2 },
    ).catch((error: unknown) => error);
    expect((elsewhere as RunRefusedError).alreadyRunning).toBe(false);

    answeringWith(() => new Response("not json", { status: 500 }));
    const unreadable = await rebuildLineOnServer(
      { root: null, branch: null },
      { effectiveness: 2, soundness: 2, learnability: 2 },
    ).catch((error: unknown) => error);
    expect((unreadable as RunRefusedError).message).toBe("The server answered 500.");
    expect((unreadable as RunRefusedError).alreadyRunning).toBe(false);
  });

  it("goes to the server through the rebuild it is given, with the variation as the list holds it", async () => {
    const rebuildLine = vi.fn<RebuildLine>(async () => ({ truncated: false }));
    renderLine({ open: 5, props: { rebuildLine } });
    const card = styleOf(await pageOf(TWO_KNIGHTS));
    fireEvent.click(rebuildButton(card));
    await within(card).findByText("The line is rebuilt.");
    expect(rebuildLine).toHaveBeenCalledWith(
      { root: null, branch: KNIGHTS_BRANCH },
      { effectiveness: 3, soundness: 2, learnability: 1 },
    );
  });
});

describe("a line that cannot be told from the first of its group", () => {
  const stored: RepertoireSummary = { ...twoKnights, branch: null };

  it("is rebuildable only when it names its root or its branch, or is the oldest of its group", () => {
    expect(rebuildNamesLine(pianissimo, [pianissimo, stored])).toBe(true);
    expect(rebuildNamesLine(stored, [pianissimo, stored])).toBe(false);
    expect(rebuildNamesLine(twoKnights, [pianissimo, twoKnights])).toBe(true);
    expect(rebuildNamesLine(scandinavian, [scandinavian])).toBe(true);
  });

  it("keeps the rebuild out of reach and says why, since posting neither would walk the first variation", async () => {
    const rebuildLine = vi.fn<RebuildLine>(async () => ({ truncated: false }));
    renderLine({
      listed: answer({ repertoires: [pianissimo, stored] }),
      open: 5,
      props: { rebuildLine },
    });
    const card = styleOf(await pageOf(TWO_KNIGHTS));
    expect(isDisabled(rebuildButton(card))).toBe(true);
    expect(
      within(card).getByText(
        "This line was stored before its branch was recorded, so it cannot be rebuilt from here.",
      ),
    ).toBeTruthy();
    fireEvent.click(rebuildButton(card));
    expect(rebuildLine).not.toHaveBeenCalled();
  });
});

describe("the page of a line imported from a PGN file", () => {
  const IMPORTED_STYLE_TEXT =
    "Imported from a PGN file. To change this line, import the file again.";
  const IMPORTED_COVERAGE_TEXT = "Coverage is not measured for an imported line.";
  const NOT_REBUILDABLE_SENTENCE =
    "This line was stored before its branch was recorded, so it cannot be rebuilt from here.";

  const londonGroup: RepertoireGroupSummary = {
    side: "white",
    group_name: "London System",
    moves: { recommended: 4, due: 6, all: 30 },
  };
  const listedImported = (): RepertoiresResponse =>
    answer({ repertoires: [imported], groups: [londonGroup] });
  const openImported = (props: Partial<PracticeOpeningsProps> = {}) =>
    renderLine({ listed: listedImported(), open: imported.id, props });

  // Lets the effects of the page that just drew run, so that a request they would send is sent.
  const settled = (): Promise<void> => act(async () => {});

  it("is never rebuildable from here, in whatever place of its group, and nothing changes for a generated line", () => {
    const newer: RepertoireSummary = { ...imported, id: 15 };
    expect(rebuildNamesLine(imported, [imported])).toBe(false);
    expect(rebuildNamesLine(imported, [imported, newer])).toBe(false);
    expect(rebuildNamesLine(newer, [imported, newer])).toBe(false);

    const generated: RepertoireSummary = { ...imported, origin: "generated" };
    const newerGenerated: RepertoireSummary = { ...generated, id: 15 };
    expect(rebuildNamesLine(generated, [generated])).toBe(true);
    expect(rebuildNamesLine({ ...imported, origin: undefined }, [imported])).toBe(true);
    expect(rebuildNamesLine(newerGenerated, [generated, newerGenerated])).toBe(false);
  });

  it("says in the style card that the line came from a PGN file, with no steppers, no rebuild and none of the builder's sentences", async () => {
    const rebuildLine = vi.fn<RebuildLine>(async () => ({ truncated: false }));
    openImported({ rebuildLine });
    const page = await pageOf(imported.variation_name);
    await settled();
    const card = styleOf(page);

    expect(card.textContent).toBe(`Style of this line${IMPORTED_STYLE_TEXT}`);
    expect(pointsOf(card)).toEqual([]);
    expect(within(card).queryAllByRole("button")).toEqual([]);
    expect(within(page).queryByRole("button", { name: /^Rebuild/ })).toBeNull();
    expect(within(page).queryAllByRole("button", { name: /points for/ })).toEqual([]);
    const text = page.textContent ?? "";
    expect(text).not.toContain(NOT_REBUILDABLE_SENTENCE);
    expect(text).not.toContain("built before style points");
    expect(text).not.toContain("Changing the points changes the moves only after a rebuild.");
    expect(text).not.toContain("left to place");
    expect(rebuildLine).not.toHaveBeenCalled();
  });

  it("says in the Coverage card that coverage is not measured for it, with no loading, no failure and no way to try again", async () => {
    openImported();
    const page = await pageOf(imported.variation_name);
    await settled();
    const card = coverageOf(page);

    expect(card.textContent).toBe(`Coverage${IMPORTED_COVERAGE_TEXT}`);
    expect(within(card).queryAllByRole("button")).toEqual([]);
    expect(within(card).queryByRole("alert")).toBeNull();
    const text = page.textContent ?? "";
    expect(text).not.toContain("Nothing is stored for this variation yet.");
    expect(text).not.toContain("Loading the coverage.");
    expect(text).not.toContain("The coverage could not be loaded.");
  });

  it("asks the server for no coverage, whether the page opens at once or from its row in the list", async () => {
    const direct = openImported();
    await pageOf(imported.variation_name);
    await settled();
    expect(direct.fetchCoverage).not.toHaveBeenCalled();
    cleanup();

    const fromList = renderLine({ listed: listedImported(), open: null });
    const london = await screen.findByRole("article", { name: "London System" });
    fireEvent.click(within(london).getByRole("button", { name: "London System" }));
    fireEvent.click(within(london).getByRole("button", { name: imported.variation_name }));
    await pageOf(imported.variation_name);
    await settled();
    expect(fromList.fetchCoverage).not.toHaveBeenCalled();
  });

  it("keeps its Train button and its five tiles working as for any line, the coverage tile holding the dash", async () => {
    const { onStart } = openImported();
    const page = await pageOf(imported.variation_name);
    expect(tilesOf(page)).toEqual([
      ["Moves in the line", "30"],
      ["Due now", "6"],
      ["Remembered in 30 days", "3 of 5"],
      ["In line", "2 of 4 games"],
      ["Coverage", NONE],
    ]);
    expect(page.querySelector(".line-page__line")).toBeNull();
    fireEvent.click(
      within(page).getByRole("button", { name: `Train 4, ${imported.variation_name}` }),
    );
    expect(onStart).toHaveBeenCalledWith(12, "recommended");
  });

  it("leaves a line marked generated, and one with no origin, with its style card, its rebuild and its coverage", async () => {
    const rebuildLine = vi.fn<RebuildLine>(async () => ({ truncated: false }));
    const generated: RepertoireSummary = { ...pianissimo, origin: "generated" };
    const { fetchCoverage } = renderLine({
      listed: answer({ repertoires: [generated, twoKnights] }),
      props: { rebuildLine },
    });
    const page = await pageOf();
    const card = styleOf(page);
    expect(card.querySelector(".line-style__built")?.textContent).toBe("built with 2 · 2 · 2");
    expect(pointsOf(card)).toEqual(["2", "2", "2"]);
    expect(isDisabled(rebuildButton(card))).toBe(false);
    expect(await within(coverageOf(page)).findByText(/^expected score/)).toBeTruthy();
    expect(fetchCoverage).toHaveBeenCalledTimes(1);
    expect(fetchCoverage).toHaveBeenCalledWith(4);
    expect(card.textContent).not.toContain(IMPORTED_STYLE_TEXT);
    expect(page.textContent).not.toContain(IMPORTED_COVERAGE_TEXT);

    fireEvent.click(rebuildButton(card));
    await within(card).findByText("The line is rebuilt.");
    expect(rebuildLine).toHaveBeenCalledWith(
      { root: null, branch: null },
      { effectiveness: 2, soundness: 2, learnability: 2 },
    );
  });
});

describe("a page opened while the line is being rebuilt", () => {
  it("shows the being-rebuilt line and the rebuild out of reach when the list names the variation", async () => {
    const { onStart } = renderLine({ listed: answer({ rebuilding_id: 4 }) });
    const page = await pageOf();
    const card = styleOf(page);
    expect(
      within(card).getByText(
        "This line is being rebuilt. It keeps working as it was until the rebuild ends.",
      ),
    ).toBeTruthy();
    const button = within(card).getByRole("button", { name: "Rebuilding…" });
    expect(isDisabled(button)).toBe(true);
    // The old moves serve meanwhile.
    fireEvent.click(within(page).getByRole("button", { name: `Train 2, ${PIANISSIMO}` }));
    expect(onStart).toHaveBeenCalledWith(4, "recommended");
  });

  it("shows nothing of it on the page of another variation, nor when the list names none", async () => {
    renderLine({ listed: answer({ rebuilding_id: 5 }) });
    const card = styleOf(await pageOf());
    expect(within(card).queryByText(/is being rebuilt/)).toBeNull();
    expect(isDisabled(rebuildButton(card))).toBe(false);
    cleanup();

    renderLine({ listed: answer({ rebuilding_id: null }) });
    expect(within(styleOf(await pageOf())).queryByText(/is being rebuilt/)).toBeNull();
  });

  it("finds out as it opens, when the list read before it did not know of the rebuild yet", async () => {
    const reads = [answer(), answer({ rebuilding_id: 4 })];
    let read = 0;
    renderLine({
      listed: async () => reads[Math.min(read++, 1)] as RepertoiresResponse,
      open: null,
    });
    const italian = await screen.findByRole("article", { name: "Italian Game" });
    fireEvent.click(within(italian).getByRole("button", { name: "Italian Game" }));
    fireEvent.click(within(italian).getByRole("button", { name: PIANISSIMO }));
    const card = styleOf(await pageOf());
    expect(await within(card).findByRole("button", { name: "Rebuilding…" })).toBeTruthy();
  });
});

describe("a rebuild that outlives the page", () => {
  it("shows Being rebuilt on the row of the list and brings the list up to date when it ends", async () => {
    const held = heldRebuild();
    let reads = 0;
    const updated = answer({ repertoires: [{ ...pianissimo, moves_total: 31 }, twoKnights] });
    renderLine({ listed: async () => (reads++ === 0 ? answer() : updated) });
    const page = await pageOf();
    fireEvent.click(rebuildButton(styleOf(page)));
    fireEvent.click(within(page).getByRole("button", { name: "Openings" }));

    const italian = await screen.findByRole("article", { name: "Italian Game" });
    fireEvent.click(within(italian).getByRole("button", { name: "Italian Game" }));
    const tag = italian.querySelector(".opening-row__rebuilding");
    expect(tag?.textContent).toBe("Being rebuilt");
    expect(tag?.parentElement?.querySelector(".opening-row__name")?.textContent).toBe(PIANISSIMO);

    await held.end(json(FINISHED));
    await waitFor(() => expect(italian.querySelector(".opening-row__rebuilding")).toBeNull());
    const first = italian.querySelector(".opening-row") as HTMLElement;
    expect(first.querySelector(".opening-figure__value")?.textContent).toBe("31");
  });
});

describe("the page inside the hub", () => {
  const noop = (): void => {};

  function hub(extra: Partial<Parameters<typeof PracticeHub>[0]> = {}) {
    return (
      <PracticeHub
        progress={{ status: "ready", value: progressOf() }}
        engineMissing={false}
        starting={null}
        failure={null}
        onStart={noop}
        onStartRepertoire={noop}
        fetchRepertoireList={async () => answer()}
        fetchAddableOpenings={async () => []}
        fetchCoverage={async () => coverage()}
        {...extra}
      />
    );
  }

  const navEntry = (name: string): HTMLElement =>
    within(screen.getByRole("navigation", { name: "Practice sections" })).getByRole("button", {
      name: new RegExp(`^${name}(,|$)`),
    });

  async function openPianissimo(): Promise<HTMLElement> {
    openPracticePage("Openings");
    const italian = await screen.findByRole("article", { name: "Italian Game" });
    fireEvent.click(within(italian).getByRole("button", { name: "Italian Game" }));
    fireEvent.click(within(italian).getByRole("button", { name: PIANISSIMO }));
    return pageOf();
  }

  it("keeps Openings chosen in the navigation, and returns to the list from the breadcrumb", async () => {
    render(hub());
    const page = await openPianissimo();
    expect(navEntry("Openings").getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(page).getByRole("button", { name: "Openings" }));
    expect(screen.queryByRole("region", { name: PIANISSIMO })).toBeNull();
    expect(screen.getByRole("region", { name: "White" })).toBeTruthy();
    expect(navEntry("Openings").getAttribute("aria-current")).toBe("page");
  });

  it("returns to the list when Openings is chosen again in the navigation, and for any other entry", async () => {
    render(hub());
    await openPianissimo();
    openPracticePage("Openings");
    expect(screen.queryByRole("region", { name: PIANISSIMO })).toBeNull();
    expect(screen.getByRole("region", { name: "White" })).toBeTruthy();

    const italian = screen.getByRole("article", { name: "Italian Game" });
    fireEvent.click(within(italian).getByRole("button", { name: PIANISSIMO }));
    await pageOf();
    openPracticePage("Overview");
    openPracticePage("Openings");
    expect(screen.queryByRole("region", { name: PIANISSIMO })).toBeNull();
  });

  it("keeps the variation in memory only, so a reload shows the Openings list", async () => {
    const first = render(hub());
    await openPianissimo();
    expect(window.localStorage.getItem(PRACTICE_PAGE_STORAGE_KEY)).toBe("openings");
    expect(Object.values(window.localStorage).join(" ")).not.toMatch(/\b4\b/);
    first.unmount();

    render(hub());
    expect(await screen.findByRole("region", { name: "White" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: PIANISSIMO })).toBeNull();
  });

  it("starts the variation's drill through the hub, and reads the coverage from the hub's read", async () => {
    const onStartRepertoire = vi.fn();
    const fetchCoverage = vi.fn(async (_id: number) => coverage());
    render(hub({ onStartRepertoire, fetchCoverage }));
    const page = await openPianissimo();
    expect(await within(coverageOf(page)).findByText(/^expected score/)).toBeTruthy();
    expect(fetchCoverage).toHaveBeenCalledWith(4);
    fireEvent.click(within(page).getByRole("button", { name: `Train 2, ${PIANISSIMO}` }));
    expect(onStartRepertoire).toHaveBeenCalledWith(4, "recommended");
  });

  it("rebuilds through the hub's rebuild and counts the moves due again from the list it reads", async () => {
    const rebuildLine = vi.fn<RebuildLine>(async () => ({ truncated: false }));
    const fewerDue = answer({
      sides: [{ side: "white", moves: { recommended: 1, due: 2, all: 39 } }],
    });
    const reads = [answer(), answer(), fewerDue];
    let read = 0;
    render(
      hub({
        rebuildLine,
        fetchRepertoireList: async () =>
          reads[Math.min(read++, reads.length - 1)] as RepertoiresResponse,
      }),
    );
    const page = await openPianissimo();
    expect(navEntry("Openings").getAttribute("aria-label")).toBe("Openings, 8 moves due");
    fireEvent.click(rebuildButton(styleOf(page)));
    expect(await within(styleOf(page)).findByText("The line is rebuilt.")).toBeTruthy();
    expect(rebuildLine).toHaveBeenCalledTimes(1);
    expect(navEntry("Openings").getAttribute("aria-label")).toBe("Openings, 2 moves due");
  });
});

describe("its stylesheet", () => {
  const read = (path: string): string => readFileSync(join(import.meta.dirname, path), "utf8");
  const css = read("../src/styles/practice-openings.css").replace(/\/\*[\s\S]*?\*\//g, "");
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

  it("holds no colour literal outside the tokens, on this page or anywhere in the web package", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    for (const sheet of ["practice-openings.css", "repertoire.css"]) {
      expect(read(`../src/styles/${sheet}`).replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(
        /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/,
      );
    }
  });

  it("sets the breadcrumb at 12 px, the name at 28 px and 600 and the line in the mono face at 12 px", () => {
    expect(declared(desktop, ".line-page__crumbs")).toMatchObject({
      "font-size": "var(--text-xs)",
    });
    expect(declared(desktop, ".line-page__title")).toMatchObject({
      "font-size": "var(--text-title)",
      "font-weight": "600",
    });
    expect(declared(desktop, ".line-page__line")).toMatchObject({
      "font-family": "var(--font-mono)",
      "font-size": "var(--text-xs)",
    });
  });

  it("lays the five tiles in equal columns 12 px apart, a 12 px label over a 16 px mono value", () => {
    expect(declared(desktop, ".line-tiles")).toMatchObject({
      display: "grid",
      "grid-template-columns": "repeat(5, minmax(0, 1fr))",
      gap: "var(--space-3)",
    });
    expect(declared(desktop, ".line-tile__label")).toMatchObject({ "font-size": "var(--text-xs)" });
    expect(declared(desktop, ".line-tile__value")).toMatchObject({
      "font-family": "var(--font-mono)",
      "font-size": "var(--text-md)",
    });
  });

  it("sets the title of a card at 16 px and 500, and a reply as a row of 13 px in the grid 70px 70px 1fr", () => {
    expect(declared(desktop, ".line-card__title")).toMatchObject({
      "font-size": "var(--text-md)",
      "font-weight": "500",
    });
    const row = declared(desktop, ".line-reply");
    expect(row).toMatchObject({ display: "grid", "font-size": "13px" });
    expect(row["grid-template-columns"]).toMatch(
      /^70px minmax\(70px, max-content\) minmax\(0, 1fr\)$/,
    );
    expect(declared(desktop, ".line-replies")).toMatchObject({
      "grid-template-columns": "repeat(2, minmax(0, 1fr))",
    });
  });

  it("draws a covered reply in the green token and a gap in the accent, never in the error tone", () => {
    expect(declared(desktop, '.line-reply__status[data-status="covered"]')).toMatchObject({
      color: "var(--quality-best)",
    });
    expect(declared(desktop, '.line-reply__status[data-status="gap"]')).toMatchObject({
      color: "var(--accent)",
    });
    expect(css).not.toMatch(/\.line-[a-z_-]+[^{]*\{[^}]*--error/);
  });

  it("wraps the tiles two by two under 900 px and keeps a reply's move, chance and status on one line", () => {
    expect(phoneAt).toBeGreaterThan(0);
    expect(declared(phone, ".line-tiles")).toMatchObject({
      "grid-template-columns": "repeat(2, minmax(0, 1fr))",
    });
    expect(declared(phone, ".line-replies")).toMatchObject({
      "grid-template-columns": "minmax(0, 1fr)",
    });
    // The row is not redrawn in the phone block, so its three columns stay on one line.
    expect(declared(phone, ".line-reply")["grid-template-columns"]).toBeUndefined();
    expect(declared(phone, ".line-reply")).not.toHaveProperty("display");
    expect(declared(phone, ".line-reply--open")).toMatchObject({ "min-height": "44px" });
    expect(declared(phone, ".line-style__rebuild")).toMatchObject({ "min-height": "44px" });
  });

  it("lets the hidden attribute hide the list that a line's page replaces", () => {
    expect(declared(desktop, ".openings-head[hidden]")).toMatchObject({ display: "none" });
    expect(declared(desktop, ".openings-body[hidden]")).toMatchObject({ display: "none" });
  });
});

describe("what the project records about the page", () => {
  const record = (path: string): string => readFileSync(join(import.meta.dirname, path), "utf8");

  it("records the page in the Practice column of the design check", () => {
    const check = record("../DESIGN-CHECK.md");
    // The paragraphs are wrapped, so a phrase may break across a line.
    const paragraph = check
      .split("\n\n")
      .map((text) => text.replace(/\s+/g, " "))
      .find(
        (text) =>
          text.startsWith("The Practice column was re-checked") &&
          text.includes("page of one line"),
      );
    expect(paragraph).toBeDefined();
    expect(paragraph).toContain("Phone column");
    expect(paragraph).toContain("M1 and M2");
    expect(paragraph).toContain("test/practice-line.test.tsx");
  });

  it("records the two sentences of an imported line's page in the Practice column of the design check", () => {
    const check = record("../DESIGN-CHECK.md");
    const paragraph = check
      .split("\n\n")
      .map((text) => text.replace(/\s+/g, " "))
      .find(
        (text) =>
          text.startsWith("The Practice column was re-checked") && text.includes("imported line"),
      );
    expect(paragraph).toBeDefined();
    expect(paragraph).toContain(
      "Imported from a PGN file. To change this line, import the file again.",
    );
    expect(paragraph).toContain("Coverage is not measured for an imported line.");
    expect(paragraph).toContain("Phone column");
    expect(paragraph).toContain("M1 and M2");
    expect(paragraph).toContain("test/practice-line.test.tsx");
  });

  it("carries the owner's two answers under the Italian's variations and the style points in AGENTS.md", () => {
    const agents = record("../../../AGENTS.md");
    const openings = /- \*\*Openings:\*\*[\s\S]*?(?=\n- \*\*)/.exec(agents)?.[0] ?? "";
    const flat = openings.replace(/\s+/g, " ");
    expect(flat).toContain(
      "A rebuild of one variation never touches the other variations of its opening.",
    );
    expect(flat).toContain(
      "The style points choose White's moves from the end of the root on, before move 4 included, wherever the rule chooses (in 1.e4 d5, 2.exd5 or 2.Nc3).",
    );
  });
});
