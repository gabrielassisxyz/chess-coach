import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_OPENING_PUZZLE_NAMES,
  type MetOpening,
  type OpeningPuzzles,
  openingTagOf,
  type RepertoireSummary,
  type RepertoiresResponse,
} from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  type OpeningPuzzlesControls,
  PracticeOpenings,
  type PracticeOpeningsProps,
} from "../src/components/PracticeOpenings.js";
import { Practice } from "../src/screens/Practice.js";
import {
  type FetchOpeningPuzzles,
  fetchOpeningPuzzlesFromServer,
  OPENING_PUZZLE_TILE_LIMIT,
  openingPuzzleNamesOf,
  openingTileFigureOf,
  puzzleCountText,
} from "../src/state/opening-puzzles-api.js";
import { type OpeningsSectionModel, sectionsOf } from "../src/state/openings-page.js";
import { OFFLINE_START_TEXT, startFailureText } from "../src/state/practice.js";
import type { AddedOpening } from "../src/state/repertoires-api.js";
import {
  noFoundPositions,
  openPracticePage,
  progressOf,
  repertoireAnswer,
} from "./practice-fixtures.js";
import { serverApi } from "./server-api.js";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const variation = (
  side: RepertoireSummary["side"],
  group: string,
  id: number,
): RepertoireSummary => ({
  id,
  side,
  group_name: group,
  variation_name: `${group} variation`,
  moves: { recommended: 1, due: 1, all: 4 },
});

const italian = variation("white", "Italian Game", 1);
const kingsPawn = variation("white", "King's Pawn Game", 2);
const sicilian = variation("black", "Sicilian Defense", 3);

const met = (name: string | null, games = 1): MetOpening => ({
  root: ["e4", "d5"],
  opening_name: name,
  games,
  repertoire_id: null,
});

const listing = (
  repertoires: RepertoireSummary[] = [italian, kingsPawn, sicilian],
  opened: MetOpening[] = [],
): RepertoiresResponse => repertoireAnswer(repertoires, { met: opened });

const sectionOf = (side: "white" | "black", list: RepertoiresResponse): OpeningsSectionModel =>
  sectionsOf(list).find((section) => section.side === side) as OpeningsSectionModel;

const entry = (name: string, extra: Partial<OpeningPuzzles> = {}): OpeningPuzzles => ({
  name,
  tag: openingTagOf(name),
  puzzles: 1200,
  played_30d: 20,
  first_try_30d: 12,
  ...extra,
});

type PuzzlesSpy = Mock<FetchOpeningPuzzles>;

// The route's answer for the names asked, one entry each in the order asked, with the figures a
// test sets for a name and the same ones for every other.
const puzzlesFor = (stats: Record<string, Partial<OpeningPuzzles>> = {}): PuzzlesSpy =>
  vi.fn<FetchOpeningPuzzles>(async (names) => ({
    entries: names.map((name) => entry(name, stats[name])),
  }));

interface PageOptions {
  list?: RepertoiresResponse;
  fetchPuzzles?: PuzzlesSpy;
  controls?: Partial<OpeningPuzzlesControls>;
  props?: Partial<PracticeOpeningsProps>;
}

function renderPage(options: PageOptions = {}) {
  const fetchPuzzles = options.fetchPuzzles ?? puzzlesFor();
  const onStart = vi.fn();
  render(
    <PracticeOpenings
      busy={false}
      starting={null}
      onStart={vi.fn()}
      fetchList={async () => options.list ?? listing()}
      openingPuzzles={{
        fetchPuzzles,
        onStart,
        starting: null,
        engineMissing: false,
        ...options.controls,
      }}
      {...options.props}
    />,
  );
  return { fetchPuzzles, onStart };
}

const BLOCK = "Puzzles from these openings";
const section = (name: string): Promise<HTMLElement> => screen.findByRole("region", { name });
const blockOf = (within_: HTMLElement): Promise<HTMLElement> =>
  within(within_).findByRole("region", { name: BLOCK });
const blocksShown = (): HTMLElement[] => screen.queryAllByRole("region", { name: BLOCK });
const pickSide = (name: string): void => {
  fireEvent.click(screen.getByRole("radio", { name }));
};
const isDisabled = (element: HTMLElement): boolean => (element as HTMLButtonElement).disabled;
const follows = (first: Element, second: Element): boolean =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
const settle = (): Promise<void> => act(async () => undefined);

// The tiles of a block once it has read its answer: its buttons, with no sentence of loading left.
async function tilesOf(block: HTMLElement): Promise<HTMLElement[]> {
  await waitFor(() => expect(within(block).queryByRole("status")).toBeNull());
  return within(block).queryAllByRole("button");
}
// A tile is its name, the share at its right and, under them, the count of puzzles.
const nameOf = (tile: HTMLElement): string => tile.children[0]?.textContent ?? "";
const statOf = (tile: HTMLElement): string => tile.children[1]?.textContent ?? "";
const toneOf = (tile: HTMLElement): string | null =>
  tile.children[1]?.getAttribute("data-tone") ?? null;
const countOf = (tile: HTMLElement): string => tile.children[2]?.textContent ?? "";
const tileNamed = (tiles: HTMLElement[], name: string): HTMLElement =>
  tiles.find((tile) => nameOf(tile) === name) as HTMLElement;

describe("which openings a colour's block asks about", () => {
  it("asks about the stored openings in the page's order, then the families of the openings met, none twice", () => {
    const list = listing(
      [kingsPawn, italian, sicilian],
      [
        met("Scandinavian Defense: Mieses-Kotroc Variation", 4),
        met("Italian Game: Giuoco Piano", 3),
        met("Scandinavian Defense: Main Line", 2),
        met("French Defense", 1),
      ],
    );
    expect(openingPuzzleNamesOf(sectionOf("white", list), list.met)).toEqual([
      "King's Pawn Game",
      "Italian Game",
      "Scandinavian Defense",
      "French Defense",
    ]);
  });

  it("skips an opening met with no name, or a blank one", () => {
    const list = listing([italian], [met(null), met(""), met("   "), met("Pirc Defense")]);
    expect(openingPuzzleNamesOf(sectionOf("white", list), list.met)).toEqual([
      "Italian Game",
      "Pirc Defense",
    ]);
  });

  it("stops at 12 names with the stored openings first, whether the rest are stored or met", () => {
    const families = Array.from({ length: 20 }, (_, index) => met(`Family ${index + 1}: Line`));
    const list = listing([italian, kingsPawn, variation("white", "Ruy Lopez", 4)], families);
    const names = openingPuzzleNamesOf(sectionOf("white", list), list.met);
    expect(names).toHaveLength(12);
    expect(names.slice(0, 4)).toEqual([
      "Italian Game",
      "King's Pawn Game",
      "Ruy Lopez",
      "Family 1",
    ]);
    expect(names.at(-1)).toBe("Family 9");

    const many = Array.from({ length: 14 }, (_, index) =>
      variation("white", `Opening ${index + 1}`, index + 1),
    );
    const stored = listing(many);
    expect(openingPuzzleNamesOf(sectionOf("white", stored), stored.met)).toEqual(
      many.slice(0, 12).map((one) => one.group_name),
    );
  });

  it("takes no opening met for Black, which has only its stored ones", () => {
    const list = listing([italian, sicilian], [met("French Defense", 3)]);
    expect(openingPuzzleNamesOf(sectionOf("black", list), list.met)).toEqual(["Sicilian Defense"]);
  });

  it("never asks about more names than the route answers", () => {
    expect(OPENING_PUZZLE_TILE_LIMIT).toBe(12);
    expect(OPENING_PUZZLE_TILE_LIMIT).toBeLessThanOrEqual(MAX_OPENING_PUZZLE_NAMES);
  });
});

describe("the block on the Openings page", () => {
  it("draws the block under the White cards and the Add an opening button, above the Black heading", async () => {
    renderPage();
    const white = await section("White");
    const block = await blockOf(white);
    const cards = within(white).getAllByRole("article");
    const add = within(white).getByRole("button", { name: "Add an opening…" });
    const blackHeading = within(await section("Black")).getByRole("heading", { name: "Black" });
    expect(white.contains(block)).toBe(true);
    expect(follows(cards.at(-1) as Element, add)).toBe(true);
    expect(follows(add, block)).toBe(true);
    expect(follows(block, blackHeading)).toBe(true);
  });

  it("draws one under the Black openings too, once Black has one", async () => {
    renderPage();
    const black = await section("Black");
    const block = await blockOf(black);
    expect(follows(within(black).getByRole("article", { name: "Sicilian Defense" }), block)).toBe(
      true,
    );
    expect(blocksShown()).toHaveLength(2);
  });

  it("writes its title as a heading and the design's sentence under it", async () => {
    renderPage();
    const block = await blockOf(await section("White"));
    const title = within(block).getByRole("heading", { level: 4, name: BLOCK });
    const note = within(block).getByText(
      "Tactics that come out of the openings you and your opponents actually play",
    );
    expect(follows(title, note)).toBe(true);
  });

  it("draws no block for a colour with no stored opening, even for White with openings met, and asks nothing for it", async () => {
    const { fetchPuzzles } = renderPage({
      list: listing([sicilian], [met("French Defense", 3)]),
    });
    const black = await section("Black");
    await tilesOf(await blockOf(black));
    const white = await section("White");
    expect(within(white).queryByRole("region", { name: BLOCK })).toBeNull();
    expect(blocksShown()).toHaveLength(1);
    expect(fetchPuzzles.mock.calls.map(([names]) => [...names])).toEqual([["Sicilian Defense"]]);
    cleanup();

    const none = renderPage({ list: listing([]) });
    await section("White");
    expect(blocksShown()).toEqual([]);
    expect(none.fetchPuzzles).not.toHaveBeenCalled();
  });

  it("shows only the block of the colour the side control shows", async () => {
    renderPage();
    await blockOf(await section("White"));
    expect(blocksShown()).toHaveLength(2);

    pickSide("As White");
    const [onlyWhite] = blocksShown();
    expect(blocksShown()).toHaveLength(1);
    expect(screen.getByRole("region", { name: "White" }).contains(onlyWhite as Node)).toBe(true);

    pickSide("As Black");
    const [onlyBlack] = blocksShown();
    expect(blocksShown()).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Black" }).contains(onlyBlack as Node)).toBe(true);

    pickSide("All");
    expect(blocksShown()).toHaveLength(2);
  });

  it("asks the server once for each colour with the names of its block, and not again when the page draws again", async () => {
    const list = listing(
      [italian, kingsPawn, sicilian],
      [met("Scandinavian Defense: Mieses-Kotroc Variation", 4), met("French Defense", 2)],
    );
    const { fetchPuzzles } = renderPage({ list });
    await tilesOf(await blockOf(await section("White")));
    await tilesOf(await blockOf(await section("Black")));
    const asked = fetchPuzzles.mock.calls.map(([names]) => [...names]);
    expect(asked).toHaveLength(2);
    expect(asked).toContainEqual([
      "Italian Game",
      "King's Pawn Game",
      "Scandinavian Defense",
      "French Defense",
    ]);
    expect(asked).toContainEqual(["Sicilian Defense"]);

    pickSide("As White");
    pickSide("As Black");
    pickSide("All");
    await settle();
    expect(fetchPuzzles).toHaveBeenCalledTimes(2);
  });
});

describe("a tile", () => {
  const LIST = listing(
    [italian, kingsPawn, sicilian],
    [
      met("Scandinavian Defense", 6),
      met("French Defense", 5),
      met("Caro-Kann Defense", 4),
      met("Pirc Defense", 3),
      met("Alekhine Defense", 2),
    ],
  );

  async function whiteTiles(stats: Record<string, Partial<OpeningPuzzles>>) {
    renderPage({ list: LIST, fetchPuzzles: puzzlesFor(stats) });
    return tilesOf(await blockOf(await section("White")));
  }

  it("shows the opening's name, the share solved first try and how many puzzles it holds", async () => {
    const tiles = await whiteTiles({
      "Italian Game": { puzzles: 842, played_30d: 25, first_try_30d: 15 },
    });
    expect(tiles.map(nameOf)).toContain("Italian Game");
    const italianTile = tileNamed(tiles, "Italian Game");
    expect([nameOf(italianTile), statOf(italianTile), countOf(italianTile)]).toEqual([
      "Italian Game",
      "60%",
      "842 puzzles",
    ]);
    expect(italianTile.tagName).toBe("BUTTON");
  });

  it("colours the share green from 70, amber from 55 and red under it", async () => {
    const tiles = await whiteTiles({
      "Italian Game": { played_30d: 100, first_try_30d: 70 },
      "King's Pawn Game": { played_30d: 100, first_try_30d: 69 },
      "Scandinavian Defense": { played_30d: 100, first_try_30d: 55 },
      "French Defense": { played_30d: 100, first_try_30d: 54 },
      "Caro-Kann Defense": { played_30d: 3, first_try_30d: 0 },
      "Pirc Defense": { played_30d: 3, first_try_30d: 3 },
    });
    const read = (name: string) => [statOf(tileNamed(tiles, name)), toneOf(tileNamed(tiles, name))];
    expect(read("Italian Game")).toEqual(["70%", "good"]);
    expect(read("King's Pawn Game")).toEqual(["69%", "mid"]);
    expect(read("Scandinavian Defense")).toEqual(["55%", "mid"]);
    expect(read("French Defense")).toEqual(["54%", "low"]);
    expect(read("Caro-Kann Defense")).toEqual(["0%", "low"]);
    expect(read("Pirc Defense")).toEqual(["100%", "good"]);
  });

  it("reads new, in the faintest tone, when nothing was played on the opening", async () => {
    const tiles = await whiteTiles({
      "Alekhine Defense": { played_30d: 0, first_try_30d: 0, puzzles: 640 },
    });
    const fresh = tileNamed(tiles, "Alekhine Defense");
    expect([statOf(fresh), toneOf(fresh), countOf(fresh)]).toEqual(["new", "new", "640 puzzles"]);
    expect(openingTileFigureOf(entry("X", { played_30d: 0, first_try_30d: 0 }))).toEqual({
      kind: "new",
    });
  });

  it("writes the number of puzzles with thousands separators, and one puzzle in the singular", async () => {
    const tiles = await whiteTiles({
      "Italian Game": { puzzles: 1234567 },
      "King's Pawn Game": { puzzles: 1000 },
      "Scandinavian Defense": { puzzles: 999 },
      "French Defense": { puzzles: 1 },
    });
    expect(countOf(tileNamed(tiles, "Italian Game"))).toBe("1,234,567 puzzles");
    expect(countOf(tileNamed(tiles, "King's Pawn Game"))).toBe("1,000 puzzles");
    expect(countOf(tileNamed(tiles, "Scandinavian Defense"))).toBe("999 puzzles");
    expect(countOf(tileNamed(tiles, "French Defense"))).toBe("1 puzzle");
    expect(puzzleCountText(0)).toBe("0 puzzles");
  });

  it("draws no tile for an opening with no puzzle, and keeps the others in the order asked", async () => {
    const tiles = await whiteTiles({
      "King's Pawn Game": { puzzles: 0, played_30d: 0, first_try_30d: 0 },
      "French Defense": { puzzles: 0 },
    });
    expect(tiles.map(nameOf)).toEqual([
      "Italian Game",
      "Scandinavian Defense",
      "Caro-Kann Defense",
      "Pirc Defense",
      "Alekhine Defense",
    ]);
  });
});

describe("pressing a tile", () => {
  it("starts the puzzles of the entry's tag", async () => {
    const { onStart } = renderPage();
    const tiles = await tilesOf(await blockOf(await section("White")));
    fireEvent.click(tileNamed(tiles, "King's Pawn Game"));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith("Kings_Pawn_Game");
  });

  it("holds every tile while a start is in flight, and says Starting on the one pressed", async () => {
    const { onStart } = renderPage({
      props: { busy: true },
      controls: { starting: "Kings_Pawn_Game" },
    });
    const tiles = await tilesOf(await blockOf(await section("White")));
    expect(tiles.length).toBeGreaterThan(1);
    for (const tile of tiles) expect(isDisabled(tile)).toBe(true);
    expect(statOf(tileNamed(tiles, "King's Pawn Game"))).toBe("Starting");
    expect(statOf(tileNamed(tiles, "Italian Game"))).not.toBe("Starting");
    fireEvent.click(tileNamed(tiles, "Italian Game"));
    expect(onStart).not.toHaveBeenCalled();
  });

  it("holds every tile while an opening is being added, which the page would lose track of if a session started", async () => {
    let finish: () => void = () => undefined;
    const addOpening = vi.fn(
      (_root: readonly string[]) =>
        new Promise<AddedOpening>((resolve) => {
          finish = () => resolve({ truncated: false });
        }),
    );
    renderPage({
      list: listing([italian, sicilian], [met("Scandinavian Defense", 4)]),
      props: { addOpening, fetchAddable: async () => [] },
    });
    const white = await section("White");
    const block = await blockOf(white);
    for (const tile of await tilesOf(block)) expect(isDisabled(tile)).toBe(false);

    fireEvent.click(within(white).getByRole("button", { name: "Add an opening…" }));
    const panel = within(white).getByRole("region", { name: "Add an opening" });
    fireEvent.click(within(panel).getByRole("tab", { name: /^From my games/ }));
    fireEvent.click(
      await within(panel).findByRole("button", { name: "Add Scandinavian Defense, 1.e4 d5" }),
    );
    for (const tile of within(block).getAllByRole("button")) expect(isDisabled(tile)).toBe(true);

    await act(async () => finish());
    for (const tile of within(block).getAllByRole("button")) expect(isDisabled(tile)).toBe(false);
  });

  it("holds every tile and says the engine is needed while the engine is missing", async () => {
    const { onStart } = renderPage({ controls: { engineMissing: true } });
    const block = await blockOf(await section("White"));
    const tiles = await tilesOf(block);
    expect(within(block).getByText("Needs the engine to grade answers.")).toBeTruthy();
    for (const tile of tiles) expect(isDisabled(tile)).toBe(true);
    fireEvent.click(tiles[0] as HTMLElement);
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("the states of the block", () => {
  it("says quietly that the puzzles are loading, with the title and the sentence in place", async () => {
    renderPage({
      fetchPuzzles: vi.fn<FetchOpeningPuzzles>(() => new Promise(() => undefined)),
    });
    const block = await blockOf(await section("White"));
    expect(within(block).getByRole("status").textContent).toBe(
      "Loading the puzzles of your openings.",
    );
    expect(within(block).getByRole("heading", { name: BLOCK })).toBeTruthy();
    expect(within(block).queryByRole("button")).toBeNull();
  });

  it("keeps its place with a sentence when no opening has a puzzle", async () => {
    renderPage({
      fetchPuzzles: vi.fn<FetchOpeningPuzzles>(async (names) => ({
        entries: names.map((name) => entry(name, { puzzles: 0, played_30d: 0, first_try_30d: 0 })),
      })),
    });
    const block = await blockOf(await section("White"));
    expect(
      (await within(block).findByText("No Lichess puzzle comes from these openings.")).tagName,
    ).toBe("P");
    expect(within(block).getByRole("heading", { name: BLOCK })).toBeTruthy();
    expect(within(block).queryByRole("button")).toBeNull();
    expect(within(block).queryByRole("alert")).toBeNull();
  });

  it("says the read failed with Try again inside the block, reads again on it, and leaves the page and the other colour alone", async () => {
    let whiteFails = true;
    const fetchPuzzles = vi.fn<FetchOpeningPuzzles>(async (names) => {
      if (whiteFails && names.includes("Italian Game")) throw new Error("down");
      return { entries: names.map((name) => entry(name)) };
    });
    renderPage({ fetchPuzzles });
    const white = await section("White");
    const block = await blockOf(white);
    const alert = await within(block).findByRole("alert");
    expect(alert.textContent).toBe("The puzzles of your openings could not be loaded.");
    expect(within(block).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(within(block).getByRole("heading", { name: BLOCK })).toBeTruthy();

    // The page around it is whole: the cards, and the other colour's tiles.
    expect(within(white).getByRole("article", { name: "Italian Game" })).toBeTruthy();
    expect(within(white).getByRole("button", { name: "Add an opening…" })).toBeTruthy();
    const blackTiles = await tilesOf(await blockOf(await section("Black")));
    expect(blackTiles.map(nameOf)).toEqual(["Sicilian Defense"]);
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    whiteFails = false;
    fireEvent.click(within(block).getByRole("button", { name: "Try again" }));
    expect(within(block).queryByRole("alert")).toBeNull();
    expect((await tilesOf(block)).map(nameOf)).toEqual(["Italian Game", "King's Pawn Game"]);
    expect(fetchPuzzles).toHaveBeenCalledTimes(3);
  });
});

describe("the Practice screen", () => {
  const hub = {
    fetchProgress: async () => progressOf(),
    fetchRepertoires: async () => [],
    fetchFoundPositions: async () => noFoundPositions,
    fetchThemeStats: async () => ({
      days: "30" as const,
      overall: { played: 0, first_try: 0, rating_avg: null, performance: null },
      overall_previous: null,
      themes: [],
      improvement_areas: [],
      strengths: [],
      unranked: 0,
    }),
    fetchRatingHistory: async () => ({
      current: 1200,
      points: [],
      low: 1200,
      high: 1200,
      change: 0,
    }),
    fetchHealth: async () => ({ status: "ok" as const, version: "test", ready: true }),
    fetchRepertoireList: async () => listing(),
    fetchOpeningPuzzles: puzzlesFor(),
  };

  async function openingsPage(server = serverApi(null)) {
    const view = render(<Practice server={server} {...hub} />);
    openPracticePage("Openings");
    const block = await blockOf(await section("White"));
    return { server, view, block, tiles: await tilesOf(block) };
  }

  it("sends start_training with the opening's tag and no motif when a tile is pressed", async () => {
    const { server, tiles } = await openingsPage();
    fireEvent.click(tileNamed(tiles, "King's Pawn Game"));
    expect(server.send).toHaveBeenCalledTimes(1);
    const sent = (server.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(sent).toEqual({ type: "start_training", mode: "puzzles", opening: "Kings_Pawn_Game" });
    expect(Object.keys(sent).sort()).toEqual(["mode", "opening", "type"]);
  });

  it("says Starting on the pressed tile of the Openings page only, and shows a refused start there", async () => {
    const { server, view, block, tiles } = await openingsPage();
    fireEvent.click(tileNamed(tiles, "King's Pawn Game"));
    expect(statOf(tileNamed(within(block).getAllByRole("button"), "King's Pawn Game"))).toBe(
      "Starting",
    );
    openPracticePage("Overview");
    expect(screen.queryByRole("button", { name: /Starting/ })).toBeNull();

    view.rerender(
      <Practice
        server={{
          ...server,
          errorCount: 1,
          lastErrorCode: "invalid_command",
          lastError: "bad tag",
        }}
        {...hub}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    openPracticePage("Openings");
    const refusal = await screen.findByRole("alert");
    expect(refusal.textContent).toContain("Training could not start. bad tag.");
    for (const tile of within(block).getAllByRole("button")) expect(isDisabled(tile)).toBe(false);
  });

  it("says the server is not connected, where the tile was pressed, when the start cannot be sent", async () => {
    const { tiles } = await openingsPage(serverApi(null, { send: vi.fn(() => false) }));
    fireEvent.click(tileNamed(tiles, "Italian Game"));
    expect((await screen.findByRole("alert")).textContent).toBe(OFFLINE_START_TEXT);
  });

  it("holds the tiles of the Openings page and says the engine is needed when the engine is missing", async () => {
    render(
      <Practice
        server={serverApi(null)}
        {...hub}
        fetchHealth={async () => ({
          status: "ok" as const,
          version: "test",
          ready: false,
          reason: "stockfish_missing",
        })}
      />,
    );
    openPracticePage("Openings");
    const block = await blockOf(await section("White"));
    await waitFor(() =>
      expect(within(block).getByText("Needs the engine to grade answers.")).toBeTruthy(),
    );
    for (const tile of await tilesOf(block)) expect(isDisabled(tile)).toBe(true);
  });

  it("names the opening a refused empty queue was about", () => {
    expect(startFailureText("puzzles", "Italian_Game", "empty_queue", null)).toBe(
      "There are no Italian Game puzzles. Try the Healthy mix or another theme.",
    );
  });
});

describe("the request", () => {
  it("asks the route for the names joined by a comma and returns what it answers", async () => {
    const body = { entries: [entry("Italian Game"), entry("King's Pawn Game")] };
    const fetched = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(body)));
    vi.stubGlobal("fetch", fetched);
    await expect(
      fetchOpeningPuzzlesFromServer(["Italian Game", "King's Pawn Game"]),
    ).resolves.toEqual(body);
    const url = new URL(String(fetched.mock.calls[0]?.[0]), "http://localhost");
    expect(url.pathname).toBe("/api/puzzles/openings");
    expect(url.searchParams.get("names")).toBe("Italian Game,King's Pawn Game");
  });

  it("keeps a comma inside a name, which the route does not split", async () => {
    const name = "Sicilian Defense: Najdorf Variation, English Attack";
    const fetched = vi.fn(
      async (_input: RequestInfo | URL) => new Response(JSON.stringify({ entries: [] })),
    );
    vi.stubGlobal("fetch", fetched);
    await fetchOpeningPuzzlesFromServer([name, "Italian Game"]);
    const url = new URL(String(fetched.mock.calls[0]?.[0]), "http://localhost");
    expect(url.searchParams.get("names")).toBe(`${name},Italian Game`);
  });

  it("refuses an answer that is not ok, and one that is not the route's shape", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    await expect(fetchOpeningPuzzlesFromServer(["Italian Game"])).rejects.toThrow(
      "opening puzzles: 500",
    );
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ entries: [{ name: "x" }] })));
    await expect(fetchOpeningPuzzlesFromServer(["Italian Game"])).rejects.toThrow();
  });
});

// The browser lays the block out; these read the rules its markup is drawn with off the stylesheets,
// as the Overview's theme tiles are read, and keep to the measures of the approved screen at 1600 px.
describe("the styles of the block", () => {
  const STYLES = join(import.meta.dirname, "../src/styles");
  const read = (file: string): string =>
    readFileSync(join(STYLES, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const sheet = `${read("practice-hub.css")}\n${read("practice-openings.css")}`;
  const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
  const token = (name: string): string | undefined =>
    new RegExp(`${name}: ([^;]+);`).exec(tokens)?.[1];

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

  // What the stylesheets give an element through the classes its markup carries, with a selector
  // suffix such as an attribute when the rule is for one state of it.
  const declaredFor = (css: string, element: Element, suffix = ""): Record<string, string> =>
    Object.assign({}, ...[...element.classList].map((name) => declared(css, `.${name}${suffix}`)));

  async function drawn() {
    renderPage({ fetchPuzzles: puzzlesFor({ "King's Pawn Game": { played_30d: 0 } }) });
    const block = await blockOf(await section("White"));
    const tiles = await tilesOf(block);
    const tile = tiles[0] as HTMLElement;
    return {
      block,
      grid: tile.parentElement as HTMLElement,
      tile,
      name: tile.children[0] as HTMLElement,
      stat: tile.children[1] as HTMLElement,
      count: tile.children[2] as HTMLElement,
    };
  }

  it("lays the tiles in columns of at least 240 px, 2 px apart down and 12 px across, in one column under 900 px", async () => {
    const { grid } = await drawn();
    expect(declaredFor(desktop, grid)).toMatchObject({
      display: "grid",
      "grid-template-columns": "repeat(auto-fill, minmax(240px, 1fr))",
      gap: "2px 12px",
    });
    expect(declaredFor(phone, grid)).toMatchObject({ "grid-template-columns": "minmax(0, 1fr)" });
  });

  it("sets a tile as a 14 px name, a mono share at 12 px at its right and a 12 px count under them, 8 px and 12 px of padding", async () => {
    const { tile, name, stat, count } = await drawn();
    expect(declaredFor(desktop, tile)).toMatchObject({
      display: "grid",
      "grid-template-columns": "minmax(0, 1fr) auto",
      padding: "var(--space-2) var(--space-3)",
    });
    expect(token("--space-2")).toBe("0.5rem");
    expect(token("--space-3")).toBe("0.75rem");
    expect(declaredFor(desktop, name)).toMatchObject({ "font-size": "var(--text-sm)" });
    expect(token("--text-sm")).toBe("0.875rem");
    expect(declaredFor(desktop, stat)).toMatchObject({
      "font-family": "var(--font-mono)",
      "font-size": "var(--text-xs)",
      "text-align": "right",
    });
    expect(declaredFor(desktop, count)).toMatchObject({
      "grid-column": "1 / -1",
      "font-size": "var(--text-xs)",
      color: "var(--text-2)",
    });
    expect(token("--text-xs")).toBe("0.75rem");
    expect(declaredFor(phone, tile)).toMatchObject({ "min-height": "44px" });
  });

  it("colours the share green from 70, amber from 55 and red under it, and new in the faintest text", async () => {
    const { stat } = await drawn();
    const tone = (value: string): string | undefined =>
      declaredFor(desktop, stat, `[data-tone="${value}"]`).color;
    expect(tone("good")).toBe("var(--quality-best)");
    expect(tone("mid")).toBe("var(--quality-inaccuracy)");
    expect(tone("low")).toBe("var(--quality-blunder)");
    expect(tone("new")).toBe("var(--text-3)");
  });

  it("draws the title at 14 px and 500 and the sentence above the tiles at 12 px in the muted colour", async () => {
    const { block } = await drawn();
    const title = within(block).getByRole("heading", { name: BLOCK });
    const note = within(block).getByText(/^Tactics that come out of the openings/);
    expect(declaredFor(desktop, title)).toMatchObject({
      "font-size": "var(--text-sm)",
      "font-weight": "500",
    });
    expect(declaredFor(desktop, note)).toMatchObject({
      "font-size": "var(--text-xs)",
      color: "var(--text-2)",
    });
  });

  it("makes the Try again of a failed read a 44 px target under 900 px", async () => {
    renderPage({
      fetchPuzzles: vi.fn<FetchOpeningPuzzles>(() => Promise.reject(new Error("down"))),
    });
    const block = await blockOf(await section("White"));
    const retry = await within(block).findByRole("button", { name: "Try again" });
    const phoneRules = [...phone.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selectors = ""]) =>
        selectors.split(",").some((part) => part.trim() === ".opening-puzzles .button"),
      )
      .map(([, , body = ""]) => body);
    expect(phoneRules.join(";")).toContain("min-height: 44px");
    expect(block.contains(retry)).toBe(true);
    expect(retry.classList.contains("button")).toBe(true);
  });
});

describe("the design checklist", () => {
  it("records the re-check of the Practice column for the block of puzzles by opening", () => {
    const checklist = readFileSync(join(import.meta.dirname, "../DESIGN-CHECK.md"), "utf8");
    const recheck = checklist
      .split("\n\n")
      .find(
        (paragraph) =>
          paragraph.startsWith("The Practice column was re-checked") &&
          paragraph.includes("Puzzles from these openings"),
      );
    expect(recheck).toBeDefined();
    expect(recheck).toContain("Phone column");
    expect(recheck).toContain("practice-openings.css");
    expect(recheck).toContain("M1 and M2");
  });
});
