import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  FoundPositionsQuery,
  FoundPositionsResponse,
  FoundPositionView,
  ThemeStatsResponse,
} from "@chess-coach/shared";
import type { Config } from "@lichess-org/chessground/config";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardFactory } from "../src/components/Board.js";
import { MiniBoard } from "../src/components/MiniBoard.js";
import { PracticeHub, type PracticeHubProps } from "../src/components/PracticeHub.js";
import type { Loaded } from "../src/hooks/useLoaded.js";
import { Practice } from "../src/screens/Practice.js";
import {
  type FetchFoundPositions,
  FOUND_EMPTY_TEXT,
  FOUND_FAILED_TEXT,
  FOUND_LOADING_TEXT,
  type FoundStartRequest,
  fetchFoundPositionsFromServer,
  foundLineText,
  foundReturnsText,
  foundTitleOf,
} from "../src/state/found-api.js";
import { PRACTICE_PAGE_STORAGE_KEY } from "../src/state/practice-page.js";
import {
  foundPosition,
  foundResponse,
  noFoundPositions,
  openPracticePage,
  progressOf,
} from "./practice-fixtures.js";
import { serverApi } from "./server-api.js";

// The same module with its title builder counted, to see whether a card draws again.
vi.mock("../src/state/found-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state/found-api.js")>();
  return { ...actual, foundTitleOf: vi.fn(actual.foundTitleOf) };
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(PRACTICE_PAGE_STORAGE_KEY);
  vi.unstubAllGlobals();
});

const DAY_MS = 86_400_000;
// A Sunday at noon UTC: a date a few days back reads as a weekday in every time zone.
const NOW = new Date("2026-03-01T12:00:00.000Z");
const inDays = (days: number): string => new Date(NOW.getTime() + days * DAY_MS).toISOString();

interface MadeBoard {
  element: HTMLElement;
  config: Config;
  destroy: ReturnType<typeof vi.fn>;
}

const made: MadeBoard[] = [];
beforeEach(() => {
  made.length = 0;
});
// A board that only records how it was made, so a test reads what a card asked of chessground.
const recordingBoard: BoardFactory = (element, config) => {
  const destroy = vi.fn();
  made.push({ element, config, destroy });
  return { destroy, set: vi.fn() } as never;
};

const kingsPawn = foundPosition({
  id: "own:kings-pawn",
  state: "due",
  next_review_at: inDays(-1),
  reached_games: 10,
  best_games: 2,
  last_reached_at: "2026-02-10T12:00:00.000Z",
});
const scandinavian = foundPosition({
  id: "own:scandinavian",
  color: "black",
  fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
  opening_name: "Scandinavian Defense",
  from_departure: true,
  from_mistake: true,
  line: { first_ply: 1, san: ["e4"] },
  reached_games: 4,
  best_games: 3,
  last_reached_at: "2026-02-28T12:00:00.000Z",
});
const petrov = foundPosition({
  id: "own:petrov",
  opening_name: "Petrov's Defense",
  state: "scheduled",
  next_review_at: inDays(3),
  line: { first_ply: 1, san: ["e4", "e5", "Nf3", "Nf6"] },
  reached_games: 9,
  best_games: 5,
});
const middlegameMistake = foundPosition({
  id: "own:move-25",
  section: "mistakes",
  phase: "middlegame",
  state: "due",
  next_review_at: inDays(-2),
  from_mistake: true,
  opening_name: "King's Pawn Game: McConnell Defense",
  line: { first_ply: 45, san: ["Kh1", "Qf2", "e6", "Nc8"] },
  reached_games: 1,
  best_games: 0,
  game: { id: 5, ply: 49, opponent: "Whambalee", played_at: "2026-02-27T12:00:00.000Z" },
});
const openingMistake = foundPosition({
  id: "own:macleod",
  section: "mistakes",
  color: "black",
  state: "due",
  next_review_at: inDays(-1),
  from_mistake: true,
  opening_name: "King's Pawn Game: MacLeod Attack",
  line: { first_ply: 6, san: ["exd4", "cxd4", "Bb4+", "Bd2"] },
  reached_games: 1,
  best_games: 0,
  game: { id: 6, ply: 10, opponent: "sam75tn", played_at: "2026-02-27T12:00:00.000Z" },
});
const endgameMistake = foundPosition({
  id: "own:move-51",
  section: "mistakes",
  phase: "endgame",
  state: "scheduled",
  next_review_at: inDays(9),
  from_mistake: true,
  opening_name: "Bishop's Opening",
  line: { first_ply: 97, san: ["Ra2", "b5", "Kf5", "Rh5+"] },
  reached_games: 1,
  best_games: 0,
  game: { id: 7, ply: 101, opponent: null, played_at: "2026-02-28T12:00:00.000Z" },
});

const LIST = [kingsPawn, scandinavian, petrov, middlegameMistake, openingMistake, endgameMistake];
const WHOLE = foundResponse(LIST);

const ready = <T,>(value: T): Loaded<T> => ({ status: "ready", value });
const noop = (): void => {};

interface HubOptions {
  positions?: Loaded<FoundPositionsResponse>;
  fetchPositions?: FetchFoundPositions;
  onStart?: (request: FoundStartRequest) => void;
  starting?: PracticeHubProps["starting"];
  failure?: string | null;
  // "real" leaves the clock to the hub, which is what the app does.
  now?: Date | "real";
}

function hubElement(options: HubOptions) {
  return (
    <PracticeHub
      progress={ready(progressOf())}
      engineMissing={false}
      starting={options.starting ?? null}
      failure={options.failure ?? null}
      onStart={noop}
      onStartRepertoire={noop}
      fetchRepertoireList={async () => ({ repertoires: [], met: [] })}
      fetchAddableOpenings={async () => []}
      {...(options.now === "real" ? {} : { now: options.now ?? NOW })}
      foundPositions={{
        positions: options.positions ?? ready(WHOLE),
        fetchPositions: options.fetchPositions ?? (async () => WHOLE),
        onStart: options.onStart ?? noop,
        createBoard: recordingBoard,
      }}
    />
  );
}

// The hub on its From my games page.
function renderPage(options: HubOptions = {}) {
  const view = render(hubElement(options));
  openPracticePage("From my games");
  return { ...view, rerenderWith: (next: HubOptions) => view.rerender(hubElement(next)) };
}

const pageOf = (): HTMLElement =>
  screen
    .getByRole("heading", { level: 2, name: "From my games" })
    .closest(".practice-page") as HTMLElement;
const sectionOf = (name: string): HTMLElement => within(pageOf()).getByRole("region", { name });
const cardOf = (title: string): HTMLElement =>
  within(pageOf())
    .getByText(title, { selector: ".found-card__title" })
    .closest("li") as HTMLElement;
const textOf = (parent: HTMLElement, selector: string): string | undefined =>
  parent.querySelector(selector)?.textContent ?? undefined;
const chipsOf = (card: HTMLElement): string[] =>
  [...card.querySelectorAll(".found-chip")].map((chip) => chip.textContent ?? "");
const phaseButton = (label: string | RegExp): HTMLElement =>
  within(within(pageOf()).getByRole("group", { name: "Phase" })).getByRole("button", {
    name: label,
  });
const colourButton = (label: string): HTMLElement =>
  within(within(pageOf()).getByRole("group", { name: "Colour" })).getByRole("button", {
    name: label,
  });
const trainButton = (name: string | RegExp): HTMLElement =>
  within(pageOf()).getByRole("button", { name });

describe("the read of the positions from your games", () => {
  it("asks for /api/found-positions with the filters it is given and parses the answer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => WHOLE })
      .mockResolvedValueOnce({ ok: true, json: async () => WHOLE });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchFoundPositionsFromServer({})).resolves.toEqual(WHOLE);
    await fetchFoundPositionsFromServer({ color: "white" });
    await fetchFoundPositionsFromServer({ phase: "endgame" });
    await fetchFoundPositionsFromServer({ color: "black", phase: "opening" });
    await fetchFoundPositionsFromServer({ opening: "Italian Game: Giuoco Piano" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/found-positions",
      "/api/found-positions?color=white",
      "/api/found-positions?phase=endgame",
      "/api/found-positions?color=black&phase=opening",
      "/api/found-positions?opening=Italian+Game%3A+Giuoco+Piano",
    ]);
  });

  it("rejects an answer that is not the schema and a refusal, with the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ invalid: true }) })
        .mockResolvedValueOnce({ ok: false, status: 503 }),
    );
    await expect(fetchFoundPositionsFromServer({})).rejects.toThrow();
    await expect(fetchFoundPositionsFromServer({})).rejects.toThrow("found positions: 503");
  });
});

describe("how a position is told", () => {
  it("numbers the moves from the ply the line starts at, with an ellipsis when it starts late", () => {
    expect(foundLineText({ first_ply: 1, san: ["e4", "e5", "Nf3"] })).toBe("1.e4 e5 2.Nf3");
    expect(foundLineText({ first_ply: 45, san: ["Kh1", "Qf2", "e6", "Nc8"] })).toBe(
      "… 23.Kh1 Qf2 24.e6 Nc8",
    );
    expect(foundLineText({ first_ply: 6, san: ["exd4", "cxd4", "Bb4+", "Bd2"] })).toBe(
      "… 3…exd4 4.cxd4 Bb4+ 5.Bd2",
    );
    expect(foundLineText({ first_ply: 1, san: [] })).toBe("");
  });

  it("says when a scheduled position returns in the units a student thinks in", () => {
    const later = (ms: number): string =>
      foundReturnsText(new Date(NOW.getTime() + ms).toISOString(), NOW);
    const hour = 3_600_000;
    expect(later(30 * 60_000)).toBe("in under an hour");
    expect(later(hour)).toBe("in 1 hour");
    expect(later(5 * hour)).toBe("in 5 hours");
    expect(later(25 * hour)).toBe("tomorrow");
    expect(later(3 * DAY_MS)).toBe("in 3 days");
    expect(later(9 * DAY_MS)).toBe("next week");
    expect(later(14 * DAY_MS)).toBe("in 2 weeks");
    expect(later(30 * DAY_MS)).toBe("in 4 weeks");
    expect(later(70 * DAY_MS)).toBe("in 2 months");
    expect(later(400 * DAY_MS)).toBe("in a year");
    expect(later(800 * DAY_MS)).toBe("in 2 years");
    // A position whose time came after the list was read is due, not about to return.
    expect(later(-60_000)).toBe("due");
    expect(foundReturnsText("not a date", NOW)).toBe("scheduled");
  });
});

describe("the From my games page", () => {
  it("shows the title and sentence, the counts, and the two sections in order with a card each", () => {
    renderPage();
    const page = pageOf();
    expect(page.querySelector(".screen__note")?.textContent).toBe(
      "Positions from your games that you reached more than once or got wrong. Each one comes back until you find the best move.",
    );
    expect(textOf(page, ".found-counts")).toBe("6 positions · 3 due · 1 new");

    const regions = within(page).getAllByRole("region");
    expect(regions.map((region) => region.getAttribute("aria-labelledby"))).toHaveLength(2);
    expect(
      within(page)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Reached more than once", "Mistakes"]);

    const reached = within(sectionOf("Reached more than once")).getAllByRole("listitem");
    const mistakes = within(sectionOf("Mistakes")).getAllByRole("listitem");
    expect(reached.map((card) => textOf(card, ".found-card__title"))).toEqual([
      "King's Pawn Game",
      "Scandinavian Defense",
      "Petrov's Defense",
    ]);
    expect(mistakes.map((card) => textOf(card, ".found-card__title"))).toEqual([
      "Move 25 · vs Whambalee",
      "King's Pawn Game: MacLeod Attack",
      "Move 51",
    ]);
  });

  it("counts each section's positions and those due beside its heading", () => {
    renderPage();
    expect(textOf(sectionOf("Reached more than once"), ".found-section__count")).toBe(
      "3 positions · 1 due",
    );
    expect(textOf(sectionOf("Mistakes"), ".found-section__count")).toBe("3 positions · 2 due");
  });

  it("keeps a section in its place with a sentence when it holds no position", () => {
    renderPage({ positions: ready(foundResponse([kingsPawn, petrov])) });
    expect(textOf(sectionOf("Mistakes"), ".found-section__count")).toBe("0 positions · 0 due");
    expect(within(sectionOf("Mistakes")).getByText("No mistakes found.")).toBeTruthy();
    expect(within(sectionOf("Mistakes")).queryAllByRole("listitem")).toEqual([]);
    expect(within(sectionOf("Reached more than once")).getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows a position of both sections once, in the first, with the Mistake chip", () => {
    renderPage();
    expect(within(pageOf()).getAllByRole("listitem")).toHaveLength(LIST.length);
    const both = cardOf("Scandinavian Defense");
    expect(sectionOf("Reached more than once").contains(both)).toBe(true);
    expect(sectionOf("Mistakes").contains(both)).toBe(false);
    expect(chipsOf(both)).toContain("Mistake");
  });

  it("titles a mistake in the opening by the opening, with the date and opponent in its foot", () => {
    renderPage();
    const card = cardOf("King's Pawn Game: MacLeod Attack");
    expect(textOf(card, ".found-card__foot > span")).toBe("Fri · vs sam75tn");
    expect(card.querySelector(".found-card__foot")?.textContent).not.toContain("Reached");
  });

  it("titles a mistake past the opening by its move and opponent, with the date and opening in its foot", () => {
    renderPage();
    const card = cardOf("Move 25 · vs Whambalee");
    expect(textOf(card, ".found-card__foot > span")).toBe(
      "Fri · King's Pawn Game: McConnell Defense",
    );
  });

  it("drops the opponent from a title and a foot when the game has none", () => {
    renderPage();
    expect(textOf(cardOf("Move 51"), ".found-card__foot > span")).toBe(
      "Yesterday · Bishop's Opening",
    );
  });

  it("falls back to the move and the opponent for a mistake in an opening the book does not name", () => {
    const unnamed = foundPosition({
      id: "own:unnamed",
      section: "mistakes",
      from_mistake: true,
      opening_name: null,
      game: { id: 9, ply: 7, opponent: "Rival", played_at: "2026-02-27T12:00:00.000Z" },
    });
    renderPage({ positions: ready(foundResponse([unnamed])) });
    expect(textOf(cardOf("Move 4 · vs Rival"), ".found-card__foot > span")).toBe("Fri");
  });

  it("gives a position reached more than once its count, how often the best move was found, and the last time", () => {
    renderPage();
    const foot = cardOf("King's Pawn Game").querySelector(".found-card__foot") as HTMLElement;
    expect(foot.textContent).toBe("Reached 10×Found best 2 of 10Last 10 FebDrill");
    expect(cardOf("Scandinavian Defense").querySelector(".found-card__foot")?.textContent).toBe(
      "Reached 4×Found best 3 of 4Last yesterdayDrill",
    );
  });

  it("colours Found best green from 70%, amber from 55% and red under it, by the exact share", () => {
    const share = (best: number, reached: number, id: string): FoundPositionView =>
      foundPosition({
        id,
        opening_name: `Share ${best} of ${reached}`,
        best_games: best,
        reached_games: reached,
      });
    renderPage({
      positions: ready(
        foundResponse([
          share(7, 10, "own:a"),
          share(14, 20, "own:b"),
          share(11, 20, "own:c"),
          share(6, 11, "own:d"),
          share(0, 4, "own:e"),
        ]),
      ),
    });
    const toneOf = (title: string): string | null =>
      cardOf(title).querySelector("[data-tone]")?.getAttribute("data-tone") ?? null;
    expect(toneOf("Share 7 of 10")).toBe("good");
    expect(toneOf("Share 14 of 20")).toBe("good");
    expect(toneOf("Share 11 of 20")).toBe("mid");
    // 6 of 11 is 54.5%, which rounds to 55 and still has to read red.
    expect(toneOf("Share 6 of 11")).toBe("low");
    expect(toneOf("Share 0 of 4")).toBe("low");
  });

  it("draws the chips for the side, the phase, an opponent that left the line and a mistake", () => {
    renderPage();
    expect(chipsOf(cardOf("King's Pawn Game"))).toEqual(["White", "Opening"]);
    expect(chipsOf(cardOf("Scandinavian Defense"))).toEqual([
      "Black",
      "Opening",
      "Opponent left your line",
      "Mistake",
    ]);
    expect(chipsOf(cardOf("Move 25 · vs Whambalee"))).toEqual(["White", "Middlegame", "Mistake"]);
    expect(chipsOf(cardOf("Move 51"))).toEqual(["White", "Endgame", "Mistake"]);
  });

  it("shows the moves of the line in mono, from the move numbered by the server", () => {
    renderPage();
    expect(textOf(cardOf("King's Pawn Game"), ".found-card__line")).toBe("1.e4 e5");
    expect(textOf(cardOf("Move 25 · vs Whambalee"), ".found-card__line")).toBe(
      "… 23.Kh1 Qf2 24.e6 Nc8",
    );
    expect(textOf(cardOf("King's Pawn Game: MacLeod Attack"), ".found-card__line")).toBe(
      "… 3…exd4 4.cxd4 Bb4+ 5.Bd2",
    );
  });

  it("tells the three states apart: due, new, and when a scheduled position returns", () => {
    renderPage();
    const stateOf = (title: string): HTMLElement | null =>
      cardOf(title).querySelector(".found-card__state");
    expect(stateOf("King's Pawn Game")?.textContent).toBe("due");
    expect(stateOf("King's Pawn Game")?.getAttribute("data-state")).toBe("due");
    expect(stateOf("Scandinavian Defense")?.textContent).toBe("new");
    expect(stateOf("Scandinavian Defense")?.getAttribute("data-state")).toBe("new");
    expect(stateOf("Petrov's Defense")?.textContent).toBe("in 3 days");
    expect(stateOf("Petrov's Defense")?.getAttribute("data-state")).toBe("scheduled");
    expect(stateOf("Move 51")?.textContent).toBe("next week");
  });

  it("gives each card a read-only board of its position, turned for Black", () => {
    renderPage();
    expect(made).toHaveLength(LIST.length);
    const boardOf = (title: string): MadeBoard => {
      const surface = cardOf(title).querySelector('[data-testid="found-board"]');
      return made.find((board) => board.element === surface) as MadeBoard;
    };
    expect(boardOf("King's Pawn Game").config).toMatchObject({
      fen: kingsPawn.fen,
      orientation: "white",
      viewOnly: true,
    });
    expect(boardOf("Scandinavian Defense").config).toMatchObject({
      fen: scandinavian.fen,
      orientation: "black",
      viewOnly: true,
    });
    expect(
      cardOf("Scandinavian Defense").querySelector(".found-board")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("draws its cards at once when the hub comes back to this page", () => {
    window.localStorage.setItem(PRACTICE_PAGE_STORAGE_KEY, "from-my-games");
    render(hubElement({}));
    expect(within(pageOf()).getAllByRole("listitem")).toHaveLength(LIST.length);
    expect(made).toHaveLength(LIST.length);
  });

  it("draws no card, and no board, until the page is first shown", () => {
    render(hubElement({}));
    expect(made).toEqual([]);
    openPracticePage("From my games");
    expect(made).toHaveLength(LIST.length);
    openPracticePage("Overview");
    openPracticePage("From my games");
    expect(made.filter((board) => board.destroy.mock.calls.length === 0)).toHaveLength(LIST.length);
  });

  it("describes a card's Drill button by the card's title, keeping its name", () => {
    renderPage();
    const card = cardOf("King's Pawn Game");
    const drill = within(card).getByRole("button", { name: "Drill" });
    const titleId = card.querySelector(".found-card__title")?.id;
    expect(titleId).toBeTruthy();
    expect(drill.getAttribute("aria-describedby")).toBe(titleId);
  });
});

describe("drawing the cards", () => {
  // The panel on the Overview builds titles too, for the positions due; the scheduled position is
  // only ever a card of the page, so a title built for it is a card drawn.
  const cardsDrawn = (): boolean =>
    vi.mocked(foundTitleOf).mock.calls.some(([position]) => position.id === petrov.id);

  it("does not draw them again when the hub renders for another reason", () => {
    const view = renderPage();
    expect(cardsDrawn()).toBe(true);
    vi.mocked(foundTitleOf).mockClear();
    // A new list object with the same positions and new callbacks, as every hub render makes.
    view.rerenderWith({});
    expect(cardsDrawn()).toBe(false);
  });

  it("does not draw them again either when the hub keeps its own clock", () => {
    const view = renderPage({ now: "real" });
    vi.mocked(foundTitleOf).mockClear();
    view.rerenderWith({ now: "real" });
    expect(cardsDrawn()).toBe(false);
  });

  it("draws them again when a start begins, which disables every Drill", () => {
    const view = renderPage();
    vi.mocked(foundTitleOf).mockClear();
    view.rerenderWith({ starting: { mode: "found", motif: "recommended" } });
    expect(cardsDrawn()).toBe(true);
  });
});

describe("the page's filters", () => {
  const whiteOnly = foundResponse([kingsPawn, petrov, middlegameMistake], {
    by_phase: { opening: 3, middlegame: 1, endgame: 1 },
  });

  it("labels each phase with the positions it holds, whatever phase is chosen", () => {
    renderPage();
    const labels = (): string[] =>
      within(within(pageOf()).getByRole("group", { name: "Phase" }))
        .getAllByRole("button")
        .map((button) => button.textContent ?? "");
    expect(labels()).toEqual(["All phases · 6", "Opening · 4", "Middlegame · 1", "Endgame · 1"]);
    expect(
      within(within(pageOf()).getByRole("group", { name: "Colour" }))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["All", "As White", "As Black"]);
  });

  it("marks the choice made and starts with no filter chosen", () => {
    renderPage();
    expect(phaseButton(/^All phases/).getAttribute("aria-pressed")).toBe("true");
    expect(colourButton("All").getAttribute("aria-pressed")).toBe("true");
    expect(colourButton("As White").getAttribute("aria-pressed")).toBe("false");
  });

  it("reads nothing while no filter is chosen, and reads the colour chosen from the server", async () => {
    const fetchPositions = vi.fn<FetchFoundPositions>(async () => whiteOnly);
    renderPage({ fetchPositions });
    expect(fetchPositions).not.toHaveBeenCalled();
    fireEvent.click(colourButton("As White"));
    await waitFor(() =>
      expect(textOf(pageOf(), ".found-counts")).toBe("3 positions · 2 due · 0 new"),
    );
    expect(fetchPositions).toHaveBeenCalledTimes(1);
    expect(fetchPositions).toHaveBeenCalledWith({ color: "white" });
    expect(colourButton("As White").getAttribute("aria-pressed")).toBe("true");
    expect(within(pageOf()).getAllByRole("listitem")).toHaveLength(3);
  });

  it("reads the phase chosen, and both when both are chosen", async () => {
    const fetchPositions = vi.fn<FetchFoundPositions>(async (query: FoundPositionsQuery) =>
      foundResponse(LIST.filter((position) => position.phase === (query.phase ?? position.phase))),
    );
    renderPage({ fetchPositions });
    fireEvent.click(phaseButton(/^Endgame/));
    await waitFor(() => expect(within(pageOf()).getAllByRole("listitem")).toHaveLength(1));
    expect(fetchPositions).toHaveBeenLastCalledWith({ phase: "endgame" });
    fireEvent.click(colourButton("As Black"));
    await waitFor(() => expect(fetchPositions).toHaveBeenCalledTimes(2));
    expect(fetchPositions).toHaveBeenLastCalledWith({ color: "black", phase: "endgame" });
  });

  it("narrows the counts to the answer and keeps the phase labels the colour alone decides", async () => {
    renderPage({ fetchPositions: async () => whiteOnly });
    fireEvent.click(colourButton("As White"));
    await waitFor(() =>
      expect(textOf(pageOf(), ".found-counts")).toBe("3 positions · 2 due · 0 new"),
    );
    expect(phaseButton(/^Endgame/).textContent).toBe("Endgame · 1");
    expect(phaseButton(/^All phases/).textContent).toBe("All phases · 5");
  });

  it("says it is loading until the answer for the choice arrives, never showing another choice's list", async () => {
    let answer: (value: FoundPositionsResponse) => void = () => {};
    renderPage({ fetchPositions: () => new Promise((resolve) => (answer = resolve)) });
    fireEvent.click(colourButton("As Black"));
    expect(screen.getByRole("status").textContent).toBe(FOUND_LOADING_TEXT);
    expect(within(pageOf()).queryAllByRole("listitem")).toEqual([]);
    // The controls keep the counts they had while the answer is on its way.
    expect(phaseButton(/^Opening/).textContent).toBe("Opening · 4");
    // The header does not reflow: the pill stays, with its last count, and starts nothing until the
    // answer it would start from is there.
    expect((trainButton("Train 4") as HTMLButtonElement).disabled).toBe(true);
    expect((trainButton("More ways to train") as HTMLButtonElement).disabled).toBe(true);
    answer(foundResponse([scandinavian]));
    await waitFor(() => expect(within(pageOf()).getAllByRole("listitem")).toHaveLength(1));
    expect((trainButton("Train 1") as HTMLButtonElement).disabled).toBe(false);
  });

  it("ignores a read that lands after a newer choice was made", async () => {
    const answers: Record<string, (value: FoundPositionsResponse) => void> = {};
    const fetchPositions = vi.fn<FetchFoundPositions>(
      (query) => new Promise((resolve) => (answers[query.color ?? ""] = resolve)),
    );
    renderPage({ fetchPositions });
    fireEvent.click(colourButton("As White"));
    fireEvent.click(colourButton("As Black"));
    await act(async () => answers.black?.(foundResponse([scandinavian])));
    expect(within(pageOf()).getAllByRole("listitem")).toHaveLength(1);
    // The answer for White, which is no longer the choice, arrives last and must change nothing.
    await act(async () => answers.white?.(whiteOnly));
    expect(within(pageOf()).getAllByRole("listitem")).toHaveLength(1);
    expect(within(pageOf()).getByText("Scandinavian Defense")).toBeTruthy();
  });

  it("reads a choice again when it is made again after the filters were cleared", async () => {
    const fetchPositions = vi.fn<FetchFoundPositions>(async () => whiteOnly);
    renderPage({ fetchPositions });
    fireEvent.click(colourButton("As White"));
    await waitFor(() => expect(within(pageOf()).getAllByRole("listitem")).toHaveLength(3));
    fireEvent.click(colourButton("All"));
    fireEvent.click(colourButton("As White"));
    // The answer read before is not shown while the new one is on its way.
    expect(screen.getByRole("status").textContent).toBe(FOUND_LOADING_TEXT);
    await waitFor(() => expect(fetchPositions).toHaveBeenCalledTimes(2));
  });

  it("returns to the whole list at once, with no read, when the filters are cleared", async () => {
    const fetchPositions = vi.fn<FetchFoundPositions>(async () => whiteOnly);
    renderPage({ fetchPositions });
    fireEvent.click(colourButton("As White"));
    await waitFor(() => expect(within(pageOf()).getAllByRole("listitem")).toHaveLength(3));
    fireEvent.click(colourButton("All"));
    expect(within(pageOf()).getAllByRole("listitem")).toHaveLength(LIST.length);
    expect(fetchPositions).toHaveBeenCalledTimes(1);
  });

  it("says when no position matches the filters and clears them with one button", async () => {
    renderPage({ fetchPositions: async () => foundResponse([]) });
    fireEvent.click(colourButton("As Black"));
    expect(
      await within(pageOf()).findByText("No position from your games matches these filters."),
    ).toBeTruthy();
    expect(within(pageOf()).queryByText(FOUND_EMPTY_TEXT)).toBeNull();
    expect((trainButton("Train all positions") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(pageOf()).getByRole("button", { name: "Clear filters" }));
    expect(within(pageOf()).getAllByRole("listitem")).toHaveLength(LIST.length);
    expect(colourButton("All").getAttribute("aria-pressed")).toBe("true");
  });

  it("offers Try again when a read for a filter fails, and reads that filter again", async () => {
    const fetchPositions = vi
      .fn<FetchFoundPositions>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(whiteOnly);
    renderPage({ fetchPositions });
    fireEvent.click(colourButton("As White"));
    expect((await within(pageOf()).findByRole("alert")).textContent).toBe(FOUND_FAILED_TEXT);
    fireEvent.click(within(pageOf()).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(within(pageOf()).getAllByRole("listitem")).toHaveLength(3));
    expect(fetchPositions).toHaveBeenCalledTimes(2);
    expect(fetchPositions).toHaveBeenLastCalledWith({ color: "white" });
  });
});

describe("starting a drill from the page", () => {
  const starts = (): {
    onStart: ReturnType<typeof vi.fn<(request: FoundStartRequest) => void>>;
  } => ({
    onStart: vi.fn<(request: FoundStartRequest) => void>(),
  });

  it("starts the recommended drill from Train N, N being the recommended count, with no filter", () => {
    const { onStart } = starts();
    renderPage({ onStart });
    expect(WHOLE.counts.recommended).toBe(4);
    fireEvent.click(trainButton("Train 4"));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith({ scope: "recommended" });
  });

  it("starts Everything due and All positions from the menu of the chevron", () => {
    const { onStart } = starts();
    renderPage({ onStart });
    const more = trainButton("More ways to train");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(within(pageOf()).queryByRole("button", { name: "Everything due" })).toBeNull();
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trainButton("Everything due"));
    expect(onStart).toHaveBeenLastCalledWith({ scope: "due" });
    expect(within(pageOf()).queryByRole("button", { name: "Everything due" })).toBeNull();
    fireEvent.click(trainButton("More ways to train"));
    fireEvent.click(trainButton("All positions"));
    expect(onStart).toHaveBeenLastCalledWith({ scope: "all" });
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it("closes the menu on Escape and on a click outside it", () => {
    renderPage();
    fireEvent.click(trainButton("More ways to train"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(within(pageOf()).queryByRole("button", { name: "All positions" })).toBeNull();
    fireEvent.click(trainButton("More ways to train"));
    expect(within(pageOf()).getByRole("button", { name: "All positions" })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(within(pageOf()).queryByRole("button", { name: "All positions" })).toBeNull();
  });

  it("closes the menu when focus moves out of it, and keeps it while focus moves inside", () => {
    renderPage();
    fireEvent.click(trainButton("More ways to train"));
    fireEvent.focusIn(trainButton("All positions"));
    expect(within(pageOf()).getByRole("button", { name: "All positions" })).toBeTruthy();
    fireEvent.focusIn(colourButton("As Black"));
    expect(within(pageOf()).queryByRole("button", { name: "All positions" })).toBeNull();
  });

  it("disables every start while any start of the hub is in flight, a found one or not", () => {
    renderPage({ starting: { mode: "puzzles", motif: "fork" } });
    expect((trainButton("Train 4") as HTMLButtonElement).disabled).toBe(true);
    expect((trainButton("More ways to train") as HTMLButtonElement).disabled).toBe(true);
    for (const button of within(pageOf()).getAllByRole("button", { name: "Drill" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    // None of them says Starting, since the start in flight is not theirs.
    expect(within(pageOf()).queryByRole("button", { name: "Starting" })).toBeNull();
    openPracticePage("Overview");
    const panel = screen.getByRole("region", { name: "Positions from your games" });
    expect(
      (within(panel).getByRole("button", { name: "Drill 3 positions" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("reads Train all positions and sends the all scope when nothing is recommended", () => {
    const { onStart } = starts();
    const scheduled = foundResponse([petrov, endgameMistake]);
    expect(scheduled.counts.recommended).toBe(0);
    renderPage({ onStart, positions: ready(scheduled) });
    expect(within(pageOf()).queryByRole("button", { name: /^Train \d/ })).toBeNull();
    fireEvent.click(trainButton("Train all positions"));
    expect(onStart).toHaveBeenCalledWith({ scope: "all" });
  });

  it("carries the colour and the phase chosen on every start of the header", async () => {
    const { onStart } = starts();
    const narrowed = foundResponse([kingsPawn, petrov], { recommended: 3, due: 2, all: 5 });
    renderPage({ onStart, fetchPositions: async () => narrowed });
    fireEvent.click(colourButton("As White"));
    fireEvent.click(phaseButton(/^Opening/));
    await waitFor(() => expect(trainButton("Train 3")).toBeTruthy());
    fireEvent.click(trainButton("Train 3"));
    expect(onStart).toHaveBeenLastCalledWith({
      scope: "recommended",
      color: "white",
      phase: "opening",
    });
    fireEvent.click(trainButton("More ways to train"));
    fireEvent.click(trainButton("Everything due"));
    expect(onStart).toHaveBeenLastCalledWith({ scope: "due", color: "white", phase: "opening" });
    fireEvent.click(trainButton("More ways to train"));
    fireEvent.click(trainButton("All positions"));
    expect(onStart).toHaveBeenLastCalledWith({ scope: "all", color: "white", phase: "opening" });
  });

  it("starts one position from its card's Drill with the all scope, and no filter", async () => {
    const { onStart } = starts();
    renderPage({ onStart, fetchPositions: async () => foundResponse([kingsPawn]) });
    fireEvent.click(within(cardOf("King's Pawn Game")).getByRole("button", { name: "Drill" }));
    expect(onStart).toHaveBeenLastCalledWith({ scope: "all", position: "own:kings-pawn" });
    fireEvent.click(colourButton("As White"));
    await waitFor(() => expect(within(pageOf()).getAllByRole("listitem")).toHaveLength(1));
    fireEvent.click(within(cardOf("King's Pawn Game")).getByRole("button", { name: "Drill" }));
    expect(onStart).toHaveBeenLastCalledWith({ scope: "all", position: "own:kings-pawn" });
  });

  it("disables the starts the list has nothing for", () => {
    const onlyScheduled = foundResponse([petrov]);
    renderPage({ positions: ready(onlyScheduled) });
    expect((trainButton("Train all positions") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(trainButton("More ways to train"));
    expect((trainButton("Everything due") as HTMLButtonElement).disabled).toBe(true);
    expect((trainButton("All positions") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says Starting on the button pressed, and disables every start while one is in flight", () => {
    const view = renderPage({ starting: null });
    view.rerenderWith({ starting: { mode: "found", motif: "recommended" } });
    expect(trainButton("Starting")).toBeTruthy();
    for (const button of within(pageOf()).getAllByRole("button", { name: "Drill" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect((trainButton("More ways to train") as HTMLButtonElement).disabled).toBe(true);

    view.rerenderWith({
      starting: { mode: "found", motif: "all", position: "own:petrov" },
    });
    expect(
      within(cardOf("Petrov's Defense")).getByRole("button", { name: "Starting" }),
    ).toBeTruthy();
    expect(within(cardOf("King's Pawn Game")).getByRole("button", { name: "Drill" })).toBeTruthy();
    expect(trainButton("Train 4")).toBeTruthy();
  });

  it("shows a refused start under the header of the page it was pressed on", () => {
    const view = renderPage();
    fireEvent.click(trainButton("Train 4"));
    view.rerenderWith({ failure: "No position from your games is due right now." });
    expect(within(pageOf()).getByRole("alert").textContent).toBe(
      "No position from your games is due right now.",
    );
  });
});

describe("the number beside From my games in the navigation", () => {
  const entry = (): HTMLElement =>
    within(screen.getByRole("navigation", { name: "Practice sections" })).getByRole("button", {
      name: /^From my games/,
    });

  it("counts the positions due in the whole list", () => {
    render(hubElement({ positions: ready(foundResponse(LIST, { due: 20 })) }));
    expect(entry().textContent).toBe("From my games20");
    expect(entry().getAttribute("aria-label")).toBe("From my games, 20 due");
  });

  it("keeps counting the whole list while the page is narrowed", async () => {
    renderPage({ fetchPositions: async () => foundResponse([kingsPawn], { due: 1 }) });
    fireEvent.click(colourButton("As White"));
    await waitFor(() => expect(textOf(pageOf(), ".found-counts")).toContain("1 position ·"));
    expect(entry().textContent).toBe("From my games3");
  });

  it("shows nothing at 0, nothing while the list loads and nothing when it could not be read", () => {
    const view = render(hubElement({ positions: ready(foundResponse([petrov])) }));
    expect(entry().textContent).toBe("From my games");
    view.rerender(hubElement({ positions: { status: "loading" } }));
    expect(entry().textContent).toBe("From my games");
    view.rerender(hubElement({ positions: { status: "failed", retry: noop } }));
    expect(entry().textContent).toBe("From my games");
    expect(entry().getAttribute("aria-label")).toBeNull();
  });
});

describe("the page with nothing to show", () => {
  it("keeps its place with the sentence, and offers no filter or drill, when no position was found", () => {
    renderPage({ positions: ready(noFoundPositions) });
    expect(within(pageOf()).getByText(FOUND_EMPTY_TEXT)).toBeTruthy();
    expect(FOUND_EMPTY_TEXT).toBe(
      "No position from your games yet. Import and grade games in Games, and the positions you got wrong or met twice appear here.",
    );
    expect(within(pageOf()).queryByRole("group", { name: "Phase" })).toBeNull();
    expect(within(pageOf()).queryByRole("button", { name: /^Train/ })).toBeNull();
    expect(within(pageOf()).queryAllByRole("listitem")).toEqual([]);
    expect(pageOf().querySelector(".screen__title")?.textContent).toBe("From my games");
  });

  it("says it is loading while the list is read", () => {
    renderPage({ positions: { status: "loading" } });
    expect(within(pageOf()).getByRole("status").textContent).toBe(FOUND_LOADING_TEXT);
    expect(within(pageOf()).queryByRole("group", { name: "Phase" })).toBeNull();
  });

  it("says the list could not be loaded, with Try again that reads it again", () => {
    const retry = vi.fn();
    renderPage({ positions: { status: "failed", retry } });
    expect(within(pageOf()).getByRole("alert").textContent).toBe(
      "The positions from your games could not be loaded.",
    );
    fireEvent.click(within(pageOf()).getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("the panel on the Overview", () => {
  const panel = (): HTMLElement =>
    screen.getByRole("region", { name: "Positions from your games" });

  it("shows what is due, how many recur of all, and the first three positions due", () => {
    // Two positions reached more than once and four mistakes, so that the count of the first
    // section is not a figure the others share.
    const extraMistake = foundPosition({
      id: "own:extra",
      section: "mistakes",
      from_mistake: true,
      opening_name: "Extra Opening",
    });
    const list = [
      kingsPawn,
      scandinavian,
      middlegameMistake,
      openingMistake,
      endgameMistake,
      extraMistake,
    ];
    render(hubElement({ positions: ready(foundResponse(list)) }));
    expect(
      within(panel()).getByRole("heading", { name: "Positions from your games" }),
    ).toBeTruthy();
    expect(textOf(panel(), ".found-panel__counts")).toBe("3 due · 2 recurring of 6");
    const rows = within(panel()).getAllByRole("listitem");
    expect(rows.map((row) => textOf(row, ".found-panel__title"))).toEqual([
      "King's Pawn Game",
      "Move 25 · vs Whambalee",
      "King's Pawn Game: MacLeod Attack",
    ]);
    expect(rows.map((row) => textOf(row, ".found-panel__side"))).toEqual([
      "White",
      "White",
      "Black",
    ]);
    expect(rows.map((row) => textOf(row, ".found-panel__line"))).toEqual([
      "1.e4 e5",
      "… 23.Kh1 Qf2 24.e6 Nc8",
      "… 3…exd4 4.cxd4 Bb4+ 5.Bd2",
    ]);
  });

  it("shows how often the best move was found for a repeated position, and the date for a mistake", () => {
    render(hubElement({}));
    const rows = within(panel()).getAllByRole("listitem");
    expect(textOf(rows[0] as HTMLElement, ".found-panel__result")).toBe("Found best 2 of 10");
    expect(rows[0]?.querySelector(".found-panel__result .sr-only")?.textContent).toBe(
      "Found best ",
    );
    expect(rows[0]?.querySelector(".found-panel__result")?.getAttribute("data-tone")).toBe("low");
    expect(textOf(rows[1] as HTMLElement, ".found-panel__result")).toBe("Fri");
  });

  it("lists no more than three positions, and none that is not due", () => {
    const four = [1, 2, 3, 4].map((n) =>
      foundPosition({ id: `own:due-${n}`, opening_name: `Due ${n}`, state: "due" }),
    );
    render(hubElement({ positions: ready(foundResponse([petrov, ...four])) }));
    expect(
      within(panel())
        .getAllByRole("listitem")
        .map((row) => textOf(row, ".found-panel__title")),
    ).toEqual(["Due 1", "Due 2", "Due 3"]);
    // Four are due though three are drawn, and the button says four.
    expect(textOf(panel(), ".found-panel__counts")).toBe("4 due · 5 recurring of 5");
    expect(within(panel()).getByRole("button", { name: "Drill 4 positions" })).toBeTruthy();
  });

  it("drills the due positions from Drill D positions", () => {
    const onStart = vi.fn();
    render(hubElement({ onStart }));
    fireEvent.click(within(panel()).getByRole("button", { name: "Drill 3 positions" }));
    expect(onStart).toHaveBeenCalledWith({ scope: "due" });
  });

  it("says Drill 1 position in the singular", () => {
    render(hubElement({ positions: ready(foundResponse([kingsPawn])) }));
    expect(within(panel()).getByRole("button", { name: "Drill 1 position" })).toBeTruthy();
  });

  it("opens the From my games page from See all", () => {
    render(hubElement({}));
    fireEvent.click(within(panel()).getByRole("button", { name: "See all" }));
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("From my games");
    expect(window.localStorage.getItem(PRACTICE_PAGE_STORAGE_KEY)).toBe("from-my-games");
  });

  it("reads Train all positions and sends the all scope when nothing is due", () => {
    const onStart = vi.fn();
    render(hubElement({ onStart, positions: ready(foundResponse([petrov, endgameMistake])) }));
    expect(textOf(panel(), ".found-panel__counts")).toBe("0 due · 1 recurring of 2");
    expect(within(panel()).queryAllByRole("listitem")).toEqual([]);
    fireEvent.click(within(panel()).getByRole("button", { name: "Train all positions" }));
    expect(onStart).toHaveBeenCalledWith({ scope: "all" });
  });

  it("says Starting on its own start, and disables the buttons while one is in flight", () => {
    render(hubElement({ starting: { mode: "found", motif: "due" } }));
    const start = within(panel()).getByRole("button", { name: "Starting" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });

  it("shows a refused start on the Overview, where it was pressed", () => {
    const view = render(hubElement({}));
    fireEvent.click(within(panel()).getByRole("button", { name: "Drill 3 positions" }));
    view.rerender(hubElement({ failure: "No position from your games is due right now." }));
    expect(screen.getByRole("alert").textContent).toBe(
      "No position from your games is due right now.",
    );
  });

  it("keeps its place with the page's sentence and no button when no position was found", () => {
    render(hubElement({ positions: ready(noFoundPositions) }));
    expect(within(panel()).getByText(FOUND_EMPTY_TEXT)).toBeTruthy();
    expect(within(panel()).queryAllByRole("button")).toEqual([]);
  });

  it("says it is loading, and that it could not load with a Try again that reads again", () => {
    const retry = vi.fn();
    const view = render(hubElement({ positions: { status: "loading" } }));
    expect(within(panel()).getByRole("status").textContent).toBe(FOUND_LOADING_TEXT);
    view.rerender(hubElement({ positions: { status: "failed", retry } }));
    expect(within(panel()).getByRole("alert").textContent).toBe(FOUND_FAILED_TEXT);
    fireEvent.click(within(panel()).getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("is drawn after the Due cards card and before the Puzzle themes section", () => {
    render(hubElement({}));
    const due = screen.getByRole("region", { name: "Due cards" });
    const themes = screen.getByRole("region", { name: "Puzzle themes" });
    expect(due.compareDocumentPosition(panel()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel().compareDocumentPosition(themes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the screen's starts of a drill from your games", () => {
  const hubReads = {
    fetchProgress: async () => progressOf(),
    fetchRepertoires: async () => [],
    fetchRepertoireList: async () => ({ repertoires: [], met: [] }),
    fetchThemeStats: async (): Promise<ThemeStatsResponse> => ({
      days: "30",
      overall: { played: 0, first_try: 0, rating_avg: null, performance: null },
      overall_previous: null,
      themes: [],
      improvement_areas: [],
      strengths: [],
      unranked: 0,
    }),
  };

  async function openPage(fetchFoundPositions: FetchFoundPositions, server = serverApi()) {
    const view = render(
      <Practice
        server={server}
        {...hubReads}
        fetchFoundPositions={fetchFoundPositions}
        createBoard={recordingBoard}
      />,
    );
    await screen.findByText("3 due · 3 recurring of 6");
    openPracticePage("From my games");
    return { view, server };
  }

  it("reads the whole list once for the navigation, the Overview and the page", async () => {
    const fetchFoundPositions = vi.fn<FetchFoundPositions>(async () => WHOLE);
    await openPage(fetchFoundPositions);
    expect(fetchFoundPositions).toHaveBeenCalledTimes(1);
    expect(fetchFoundPositions).toHaveBeenCalledWith({});
    expect(within(pageOf()).getAllByRole("listitem")).toHaveLength(LIST.length);
  });

  it("sends start_training with the found mode, the scope and the filters of the page", async () => {
    const { server } = await openPage(async (query) =>
      query.color === undefined ? WHOLE : foundResponse([kingsPawn, petrov]),
    );
    fireEvent.click(trainButton("Train 4"));
    expect(server.send).toHaveBeenLastCalledWith({
      type: "start_training",
      mode: "found",
      scope: "recommended",
    });
  });

  it("sends the colour and phase chosen with the header's starts", async () => {
    const narrowed = foundResponse([kingsPawn, petrov]);
    const { server } = await openPage(async (query) =>
      query.color === undefined ? WHOLE : narrowed,
    );
    fireEvent.click(colourButton("As White"));
    fireEvent.click(phaseButton(/^Opening/));
    await waitFor(() => expect(trainButton("Train 1")).toBeTruthy());
    fireEvent.click(trainButton("Train 1"));
    expect(server.send).toHaveBeenLastCalledWith({
      type: "start_training",
      mode: "found",
      scope: "recommended",
      color: "white",
      phase: "opening",
    });
  });

  it("sends the all scope and the position from a card's Drill", async () => {
    const { server } = await openPage(async () => WHOLE);
    fireEvent.click(within(cardOf("Petrov's Defense")).getByRole("button", { name: "Drill" }));
    expect(server.send).toHaveBeenLastCalledWith({
      type: "start_training",
      mode: "found",
      scope: "all",
      position: "own:petrov",
    });
  });

  it("sends the due scope from the Overview's panel", async () => {
    const { server } = await openPage(async () => WHOLE);
    openPracticePage("Overview");
    fireEvent.click(screen.getByRole("button", { name: "Drill 3 positions" }));
    expect(server.send).toHaveBeenLastCalledWith({
      type: "start_training",
      mode: "found",
      scope: "due",
    });
  });

  it("says why a drill with nothing due was refused, under the page's header", async () => {
    const { view, server } = await openPage(async () => WHOLE);
    fireEvent.click(trainButton("More ways to train"));
    fireEvent.click(trainButton("Everything due"));
    expect(trainButton("Starting")).toBeTruthy();
    view.rerender(
      <Practice
        server={{ ...server, errorCount: 1, lastError: "none", lastErrorCode: "empty_queue" }}
        {...hubReads}
        fetchFoundPositions={async () => WHOLE}
        createBoard={recordingBoard}
      />,
    );
    expect((await within(pageOf()).findByRole("alert")).textContent).toBe(
      "No position from your games is due right now. Choose All positions to practise them anyway.",
    );
  });

  it("says the list moved on when a card's drill is refused for want of its position", async () => {
    const { view, server } = await openPage(async () => WHOLE);
    fireEvent.click(within(cardOf("Petrov's Defense")).getByRole("button", { name: "Drill" }));
    view.rerender(
      <Practice
        server={{ ...server, errorCount: 1, lastError: "none", lastErrorCode: "empty_queue" }}
        {...hubReads}
        fetchFoundPositions={async () => WHOLE}
        createBoard={recordingBoard}
      />,
    );
    expect((await within(pageOf()).findByRole("alert")).textContent).toBe(
      "No position from your games matches any more. Reload the page to see the current list.",
    );
  });

  it("says the server is not connected when the start cannot be sent", async () => {
    const { server } = await openPage(
      async () => WHOLE,
      serverApi(null, { send: vi.fn(() => false) }),
    );
    fireEvent.click(trainButton("Train 4"));
    expect(server.send).toHaveBeenCalledTimes(1);
    expect(within(pageOf()).getByRole("alert").textContent).toContain("not connected");
    expect(within(pageOf()).queryByRole("button", { name: "Starting" })).toBeNull();
  });
});

describe("the page's styles", () => {
  const css = readFileSync(
    join(import.meta.dirname, "../src/styles/practice-hub.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  // The block of this page is the last in the sheet; its own phone rules close it.
  const block = css.slice(css.indexOf(".found-head {"));
  const phoneAt = block.indexOf("@media (max-width: 899px)");
  const declared = (sheet: string, selector: string): Record<string, string> => {
    const found: Record<string, string> = {};
    for (const [, selectors = "", body = ""] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!selectors.split(",").some((part) => part.trim() === selector)) continue;
      for (const declaration of body.split(";")) {
        const [property = "", ...value] = declaration.split(":");
        if (property.trim() !== "" && value.length > 0)
          found[property.trim()] = value.join(":").trim();
      }
    }
    return found;
  };

  it("lays the cards out in columns of at least 420 px, with a 112 px board beside the text", () => {
    expect(declared(block.slice(0, phoneAt), ".found-grid")["grid-template-columns"]).toBe(
      "repeat(auto-fill, minmax(min(420px, 100%), 1fr))",
    );
    expect(declared(block, ".found-card")["grid-template-columns"]).toBe("112px minmax(0, 1fr)");
    expect(declared(block, ".found-board")).toMatchObject({ width: "112px", height: "112px" });
    expect(declared(block, ".found-card__drill")).toMatchObject({ height: "28px" });
  });

  it("sets the section heading at 16 px and weight 600, and the card title at 14 px", () => {
    expect(declared(block, ".found-section__title")).toMatchObject({
      "font-size": "var(--text-md)",
      "font-weight": "600",
    });
    expect(declared(block, ".found-card__title")).toMatchObject({ "font-size": "var(--text-sm)" });
    expect(declared(block, ".found-card__line")).toMatchObject({
      "font-family": "var(--font-mono)",
      "font-size": "var(--text-xs)",
    });
  });

  it("wraps the header's controls under the title and stacks the cards in one column under 900 px", () => {
    expect(phoneAt).toBeGreaterThan(0);
    const phone = block.slice(phoneAt);
    expect(declared(phone, ".found-head__heading")).toMatchObject({ "flex-basis": "100%" });
    expect(declared(phone, ".found-grid")).toMatchObject({
      "grid-template-columns": "minmax(0, 1fr)",
    });
    expect(declared(phone, ".found-card__drill")).toMatchObject({ "min-height": "44px" });
    expect(declared(block.slice(0, phoneAt), ".found-head")).toMatchObject({ "flex-wrap": "wrap" });
  });

  it("lets the heading and the controls give way in a narrow column, such as the page with the coach open", () => {
    const desktop = block.slice(0, phoneAt);
    expect(declared(desktop, ".found-head__heading")["min-width"]).toBe("min(280px, 100%)");
    expect(declared(desktop, ".found-filter")["flex-wrap"]).toBe("wrap");
    expect(declared(desktop, ".found-filter")["min-height"]).toBe("32px");
    expect(declared(desktop, ".found-filter").height).toBeUndefined();
  });

  it("wraps a title under 900 px instead of cutting it off, where it cannot be read by touch", () => {
    expect(declared(block.slice(phoneAt), ".found-card__title")).toMatchObject({
      "white-space": "normal",
    });
    expect(declared(block.slice(0, phoneAt), ".found-card__title")).toMatchObject({
      "white-space": "nowrap",
      "text-overflow": "ellipsis",
    });
  });

  it("holds no colour literal, only tokens", () => {
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(block).not.toMatch(/box-shadow|text-shadow/);
  });
});

describe("the design check", () => {
  it("records the From my games page in the Practice column", () => {
    const check = readFileSync(join(import.meta.dirname, "../DESIGN-CHECK.md"), "utf8");
    expect(check).toContain("**From my games**");
  });
});

describe("the read-only board", () => {
  it("is created on its element with the position and the orientation, and accepts no move", () => {
    render(<MiniBoard fen={scandinavian.fen} orientation="black" createBoard={recordingBoard} />);
    expect(made).toHaveLength(1);
    const [board] = made as [MadeBoard];
    expect(board.element).toBe(screen.getByTestId("found-board"));
    expect(board.config).toMatchObject({
      fen: scandinavian.fen,
      orientation: "black",
      viewOnly: true,
      coordinates: false,
    });
    expect(board.config.movable?.color).toBeUndefined();
    expect(board.config.draggable?.enabled).toBe(false);
    expect(board.config.selectable?.enabled).toBe(false);
    expect(board.config.premovable?.enabled).toBe(false);
    expect(board.config.drawable?.enabled).toBe(false);
    expect(board.config.events).toBeUndefined();
  });

  it("is destroyed with the card and made again for another position or side", () => {
    const view = render(
      <MiniBoard fen={kingsPawn.fen} orientation="white" createBoard={recordingBoard} />,
    );
    view.rerender(
      <MiniBoard fen={scandinavian.fen} orientation="black" createBoard={recordingBoard} />,
    );
    expect(made).toHaveLength(2);
    expect(made[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(made[1]?.config).toMatchObject({ fen: scandinavian.fen, orientation: "black" });
    view.unmount();
    expect(made[1]?.destroy).toHaveBeenCalledTimes(1);
  });

  it("is hidden from assistive technology, since the card's title, moves and chips say what it shows", () => {
    render(<MiniBoard fen={kingsPawn.fen} orientation="white" createBoard={recordingBoard} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(
      screen.getByTestId("found-board").closest("[aria-hidden]")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });
});
