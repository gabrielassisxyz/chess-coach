import type { GameSummary, ImportStatus } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Games } from "../src/screens/Games.js";
import {
  dateLabel,
  filterGames,
  lossLabel,
  outcomeOf,
  sourceCounts,
  timeClassOf,
  totalsOf,
} from "../src/state/games.js";
import type { GamesApi } from "../src/state/games-api.js";
import type { ImportApi } from "../src/state/import-api.js";
import { COACH_GAME_SOURCE, idleImportApi } from "./fixtures.js";
import { serverApi } from "./server-api.js";

afterEach(cleanup);

function game(over: Partial<GameSummary> & { id: number }): GameSummary {
  return {
    ...COACH_GAME_SOURCE,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T01:00:00.000Z",
    player_color: "white",
    target_elo: 1100,
    result: "1-0",
    termination: "resign",
    move_count: 30,
    accuracy: 0.6,
    ...over,
  };
}

const chesscom = { source: "chesscom", opponent: "mateus_rj", opponent_rating: 438 } as const;
const italian = { eco: "C50", name: "Italian Game" } as const;
const scandinavian = { eco: "B01", name: "Scandinavian Defense: Main Line" } as const;
const LIBRARY: GameSummary[] = [
  game({ id: 1, result: "1-0", opening: italian }),
  game({ id: 2, result: "0-1", accuracy: 0.4, opening: scandinavian, ...chesscom }),
  game({
    id: 3,
    result: "0-1",
    player_color: "black",
    accuracy: null,
    grading: "running",
    ...chesscom,
  }),
  game({
    id: 4,
    result: "0-1",
    accuracy: 0.8,
    worst_moment: { ply: 40, san: "Rxe5", cp_loss: 500, classification: "blunder" },
    cards_count: 3,
  }),
  game({ id: 5, result: "1/2-1/2", source: "pgn", opponent: "kasparov" }),
];

const listing = (games: GameSummary[]): GamesApi => ({
  listGames: async () => games,
  getGame: () => new Promise(() => {}),
});

function mount(games: GameSummary[], importApi: ImportApi = idleImportApi, extra = {}) {
  return render(
    <Games server={serverApi()} api={listing(games)} importApi={importApi} {...extra} />,
  );
}

const rows = (): HTMLElement[] => within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("game list state", () => {
  it("reads the outcome from the side the student played", () => {
    expect(outcomeOf({ result: "1-0", player_color: "white" })).toBe("won");
    expect(outcomeOf({ result: "1-0", player_color: "black" })).toBe("lost");
    expect(outcomeOf({ result: "0-1", player_color: "black" })).toBe("won");
    expect(outcomeOf({ result: "1/2-1/2", player_color: "black" })).toBe("drawn");
    expect(outcomeOf({ result: null, player_color: "white" })).toBeNull();
  });

  it("filters by source and result together and counts the sources", () => {
    expect(filterGames(LIBRARY, "all", "lost").map((g) => g.id)).toEqual([2, 4]);
    expect(filterGames(LIBRARY, "chesscom", "all").map((g) => g.id)).toEqual([2, 3]);
    expect(filterGames(LIBRARY, "coach", "lost").map((g) => g.id)).toEqual([4]);
    expect(sourceCounts(LIBRARY)).toEqual({ all: 5, coach: 2, chesscom: 2, pgn: 1 });
  });

  it("totals the visible games, averaging only graded accuracy", () => {
    expect(totalsOf(LIBRARY)).toEqual({
      games: 5,
      won: 2,
      lost: 2,
      drawn: 1,
      averageAccuracy: 60,
    });
    expect(totalsOf([]).averageAccuracy).toBeNull();
  });

  it("words dates, losses and time classes", () => {
    const now = new Date(2026, 9, 28, 15);
    expect(dateLabel(new Date(2026, 9, 28, 1).toISOString(), now)).toBe("Today");
    expect(dateLabel(new Date(2026, 9, 27, 23).toISOString(), now)).toBe("Yesterday");
    expect(dateLabel(new Date(2026, 9, 26, 12).toISOString(), now)).toBe("Mon");
    expect(dateLabel(new Date(2026, 9, 12, 12).toISOString(), now)).toBe("12 Oct");
    expect(dateLabel(new Date(2025, 9, 12, 12).toISOString(), now)).toBe("12 Oct 2025");
    expect(lossLabel(430)).toBe("−4.3");
    expect(["60", "180", "300+5", "600", "1/86400", null].map(timeClassOf)).toEqual([
      "bullet",
      "blitz",
      "blitz",
      "rapid",
      "daily",
      null,
    ]);
  });
});

describe("games table", () => {
  it("fills the worst moment and the cards cells, and leaves them empty while grading", async () => {
    mount(LIBRARY);
    await screen.findByRole("table");
    const blundered = rows()[3] as HTMLElement;
    expect(within(blundered).getByText(/20…Rxe5 · −5\.0/)).toBeTruthy();
    expect(within(blundered).getByText("??")).toBeTruthy();
    const cells = within(blundered).getAllByRole("cell");
    expect(cells.at(-1)?.textContent).toBe("3");
    const grading = within(rows()[2] as HTMLElement).getAllByRole("cell");
    expect(grading[6]?.textContent).toBe("grading");
    expect(grading[7]?.textContent).toBe("–");
    expect(grading[8]?.textContent).toBe("–");
  });

  it("names the opponent with the source tag", async () => {
    mount(LIBRARY);
    await screen.findByRole("table");
    expect(within(rows()[1] as HTMLElement).getByText("mateus_rj 438")).toBeTruthy();
    expect(within(rows()[1] as HTMLElement).getByText("Chess.com")).toBeTruthy();
    expect(within(rows()[0] as HTMLElement).getByText("Stockfish 1100")).toBeTruthy();
  });

  it("gives the opening a column of its own, name and ECO code, with the full name on hover", async () => {
    mount(LIBRARY);
    await screen.findByRole("table");
    const headers = screen.getAllByRole("columnheader").map((header) => header.textContent);
    expect(headers.slice(0, 5)).toEqual(["Date", "Opponent", "You", "Opening", "Result"]);
    const cell = within(rows()[1] as HTMLElement).getAllByRole("cell")[3] as HTMLElement;
    expect(within(cell).getByText("Scandinavian Defense: Main Line")).toBeTruthy();
    expect(within(cell).getByText("B01")).toBeTruthy();
    expect(cell.querySelector("[title]")?.getAttribute("title")).toBe(
      "Scandinavian Defense: Main Line (B01)",
    );
  });

  it("leaves the opening cell as a dash when no position was named", async () => {
    mount(LIBRARY);
    await screen.findByRole("table");
    const cell = within(rows()[3] as HTMLElement).getAllByRole("cell")[3] as HTMLElement;
    expect(cell.textContent).toBe("–");
  });

  it("filters to Lost and puts the totals of the shown rows in the footer", async () => {
    mount(LIBRARY);
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "All · 5" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Coached · 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Lost" }));
    expect(rows()).toHaveLength(2);
    expect(screen.getByTestId("games-footer").textContent).toContain(
      "2 games · 0 won · 2 lost · 0 drawn · average accuracy 60%",
    );
    fireEvent.click(screen.getByRole("button", { name: "Coached · 2" }));
    expect(rows()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Drawn" }));
    expect(screen.getByText("No games match these filters.")).toBeTruthy();
  });

  it("opens a game on Enter and on double-click, not on a single click", async () => {
    const getGame = vi.fn<GamesApi["getGame"]>(() => new Promise(() => {}));
    render(
      <Games
        server={serverApi()}
        api={{ listGames: async () => LIBRARY, getGame }}
        importApi={idleImportApi}
      />,
    );
    await screen.findByRole("table");
    fireEvent.click(rows()[1] as HTMLElement);
    expect(getGame).not.toHaveBeenCalled();
    fireEvent.keyDown(rows()[1] as HTMLElement, { key: "Enter" });
    expect(getGame).toHaveBeenLastCalledWith(2);
    fireEvent.doubleClick(rows()[0] as HTMLElement);
    expect(getGame).toHaveBeenLastCalledWith(1);
  });
});

describe("a phone", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens a game on a single tap, since a double tap zooms", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query.includes("max-width: 899px"), media: query })),
    );
    const getGame = vi.fn<GamesApi["getGame"]>(() => new Promise(() => {}));
    render(
      <Games
        server={serverApi()}
        api={{ listGames: async () => LIBRARY, getGame }}
        importApi={idleImportApi}
      />,
    );
    await screen.findByRole("table");
    fireEvent.click(rows()[1] as HTMLElement);
    expect(getGame).toHaveBeenCalledWith(2);
  });
});

describe("grading line and the import form", () => {
  it("says how many games are grading, polls, and refreshes the list when it drains", async () => {
    const statuses: ImportStatus[] = [
      { pending: 1, failed: 0, running: { game_id: 3, graded_plies: 3, total_plies: 30 } },
      { pending: 0, failed: 0, running: null },
    ];
    const status = vi.fn(async () => statuses.shift() ?? { pending: 0, failed: 0, running: null });
    const listGames = vi.fn(async () => LIBRARY);
    render(
      <Games
        server={serverApi()}
        api={{ listGames, getGame: () => new Promise(() => {}) }}
        importApi={{ ...idleImportApi, status }}
        pollMs={20}
      />,
    );
    expect(await screen.findByText("Grading 2 games…")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Grading 2 games…")).toBeNull());
    await waitFor(() => expect(listGames).toHaveBeenCalledTimes(2));
  });

  it("opens the form inset from the Import button", async () => {
    mount(LIBRARY);
    await screen.findByRole("table");
    expect(screen.queryByLabelText("Username")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Import from Chess.com…" }));
    expect(screen.getByLabelText("Username")).toBeTruthy();
    expect(screen.getByText(/about 20 s per game/)).toBeTruthy();
  });

  it("shows the form and a way to Play when there are no games", async () => {
    const onOpenPlay = vi.fn();
    mount([], idleImportApi, { onOpenPlay });
    expect(await screen.findByLabelText("Username")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start a coached game →" }));
    expect(onOpenPlay).toHaveBeenCalledTimes(1);
  });
});

describe("a partial import", () => {
  const listed = (uuid: string) => ({
    uuid,
    url: "https://www.chess.com/game/live/1",
    played_at: "2026-10-28T12:00:00.000Z",
    opponent: "x",
    student_color: "white" as const,
    result: "1-0" as const,
    time_control: "600",
    student_rating: 400,
    opponent_rating: 410,
    already_imported: false,
  });

  async function importWithFailures(importChessCom: ImportApi["importChessCom"]) {
    mount(LIBRARY, {
      ...idleImportApi,
      listChessCom: async () => [listed("a"), listed("b"), listed("c")],
      importChessCom,
    });
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Import from Chess.com…" }));
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "rafa_400" } });
    fireEvent.click(screen.getByRole("button", { name: "Fetch games" }));
    const list = await screen.findByRole("list", { name: "Chess.com games" });
    for (const box of within(list).getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    await screen.findByText("Import didn't finish");
  }

  it("names what was saved and retries only the failed ids", async () => {
    const importChessCom = vi
      .fn<ImportApi["importChessCom"]>()
      .mockResolvedValueOnce({
        imported: 1,
        skipped: 0,
        failed: [
          { id: "b", message: "timed out after 20 s" },
          { id: "c", message: "timed out after 20 s" },
        ],
      })
      .mockResolvedValueOnce({ imported: 2, skipped: 0 });
    await importWithFailures(importChessCom);
    const card = screen.getByRole("alert");
    expect(card.textContent).toContain("1 of 3 games were saved");
    expect(card.textContent).toContain("the other 2 could not be fetched");
    fireEvent.click(within(card).getByRole("button", { name: "Retry the 2" }));
    await waitFor(() => expect(screen.queryByText("Import didn't finish")).toBeNull());
    expect(importChessCom).toHaveBeenLastCalledWith("rafa_400", ["b", "c"]);
  });

  it("keeps the card with the smaller count when the retry is partial too, and dismisses", async () => {
    const importChessCom = vi
      .fn<ImportApi["importChessCom"]>()
      .mockResolvedValueOnce({
        imported: 1,
        skipped: 0,
        failed: [
          { id: "b", message: "timed out" },
          { id: "c", message: "timed out" },
        ],
      })
      .mockResolvedValueOnce({
        imported: 1,
        skipped: 0,
        failed: [{ id: "c", message: "timed out" }],
      });
    await importWithFailures(importChessCom);
    fireEvent.click(screen.getByRole("button", { name: "Retry the 2" }));
    await screen.findByRole("button", { name: "Retry the 1" });
    expect(screen.getByRole("alert").textContent).toContain("2 of 3 games were saved");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Import didn't finish")).toBeNull();
  });

  it("says why when the retry itself fails, and offers it again", async () => {
    const importChessCom = vi
      .fn<ImportApi["importChessCom"]>()
      .mockResolvedValueOnce({ imported: 1, skipped: 0, failed: [{ id: "b", message: "slow" }] })
      .mockRejectedValueOnce(new Error("Chess.com is not answering"));
    await importWithFailures(importChessCom);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry the 1" }));
    });
    expect(await screen.findByText("Chess.com is not answering")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Retry the 1" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
