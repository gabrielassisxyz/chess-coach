import type { GameSummary, OpeningDrillsResponse } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Games } from "../src/screens/Games.js";
import { Practice } from "../src/screens/Practice.js";
import type { GamesApi } from "../src/state/games-api.js";
import { PRACTICE_PAGE_STORAGE_KEY } from "../src/state/practice-page.js";
import { COACH_GAME_SOURCE, idleImportApi } from "./fixtures.js";
import { openPracticePage, progressOf } from "./practice-fixtures.js";
import { serverApi } from "./server-api.js";

afterEach(cleanup);
// The hub stores the page it shows, which would open the next test's hub on it.
afterEach(() => window.localStorage.removeItem(PRACTICE_PAGE_STORAGE_KEY));

const summary: GameSummary = {
  ...COACH_GAME_SOURCE,
  id: 7,
  started_at: "2026-01-01T00:00:00.000Z",
  finished_at: "2026-01-01T01:00:00.000Z",
  player_color: "white",
  target_elo: 1200,
  result: "0-1",
  termination: "resign",
  move_count: 6,
  accuracy: 0.5,
};

const never = <T,>() => new Promise<T>(() => {});
const gamesApi = (overrides: Partial<GamesApi>): GamesApi => ({
  listGames: async () => [summary],
  getGame: never,
  ...overrides,
});

describe("Games states", () => {
  it("says what to do when there are no finished games", async () => {
    render(
      <Games
        server={serverApi()}
        api={gamesApi({ listGames: async () => [] })}
        importApi={idleImportApi}
      />,
    );
    expect(await screen.findByText(/appears in this list the moment it ends/)).toBeTruthy();
  });

  it("shows a loading note while the list is on its way", () => {
    render(
      <Games server={serverApi()} api={gamesApi({ listGames: never })} importApi={idleImportApi} />,
    );
    expect(screen.getByRole("status").textContent).toBe("Loading games.");
  });

  it("offers a retry that loads the list again after a fetch failure", async () => {
    const listGames = vi
      .fn<GamesApi["listGames"]>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce([summary]);
    render(<Games server={serverApi()} api={gamesApi({ listGames })} importApi={idleImportApi} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Check that the server");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("status").textContent).toBe("Loading games.");
    expect(await screen.findByRole("table", { name: "Finished games" })).toBeTruthy();
    expect(listGames).toHaveBeenCalledTimes(2);
  });

  it("says a game could not be opened and keeps the list to pick another", async () => {
    const getGame = vi.fn<GamesApi["getGame"]>().mockRejectedValue(new Error("gone"));
    render(<Games server={serverApi()} api={gamesApi({ getGame })} importApi={idleImportApi} />);
    fireEvent.doubleClick(await screen.findByRole("row", { name: /1200/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("pick another game");
    expect(screen.getByRole("table", { name: "Finished games" })).toBeTruthy();
  });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const motifs = async () => [{ motif: "fork", count: 4 }];
const noProgress = async (): Promise<never> => Promise.reject(new Error("offline"));
const hub = {
  fetchMotifs: motifs,
  fetchProgress: async () => progressOf(),
  fetchRepertoires: async () => [],
  fetchRepertoireList: async () => ({ repertoires: [], met: [] }),
  fetchOpeningDrills: async () => ({ white: [], black: [] }),
};

describe("Practice states", () => {
  it("shows the fixed motifs while the counts load, then fills the library ones", async () => {
    let resolve: (value: { motif: string; count: number }[]) => void = () => {};
    const fetchMotifs = () => new Promise<{ motif: string; count: number }[]>((r) => (resolve = r));
    render(<Practice server={serverApi()} {...hub} fetchMotifs={fetchMotifs} />);
    expect(screen.getByText("Loading motifs.")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /hanging piece/i })).toBeTruthy();
    await act(async () => resolve([{ motif: "opening_trap", count: 4 }]));
    expect(screen.queryByText("Loading motifs.")).toBeNull();
    expect(screen.getByRole("radio", { name: /opening trap, 4 puzzles/i })).toBeTruthy();
  });

  it("says so when the motif list cannot be loaded, still allows any motif, and retries only motifs", async () => {
    const second = deferred<{ motif: string; count: number }[]>();
    const fetchMotifs = vi
      .fn()
      .mockRejectedValueOnce(new Error("x"))
      .mockReturnValueOnce(second.promise);
    const fetchProgress = vi.fn(hub.fetchProgress);
    const fetchRepertoires = vi.fn(hub.fetchRepertoires);
    const fetchRepertoireList = vi.fn(hub.fetchRepertoireList);
    const fetchOpeningDrills = vi.fn(hub.fetchOpeningDrills);
    render(
      <Practice
        server={serverApi()}
        fetchMotifs={fetchMotifs}
        fetchProgress={fetchProgress}
        fetchRepertoires={fetchRepertoires}
        fetchRepertoireList={fetchRepertoireList}
        fetchOpeningDrills={fetchOpeningDrills}
      />,
    );
    const card = await screen.findByRole("region", { name: "Puzzles by motif" });
    const alert = await within(card).findByRole("alert");
    expect(alert.className).toContain("practice__failure");
    expect(alert.textContent).toBe(
      "The motif list could not be loaded. You can still drill with Any motif.",
    );
    expect(
      (within(card).getByRole("button", { name: "Start any motif" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(within(card).getByRole("status").textContent).toBe("Loading motifs.");
    expect(fetchMotifs).toHaveBeenCalledTimes(2);
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    expect(fetchRepertoires).toHaveBeenCalledTimes(1);
    expect(fetchOpeningDrills).toHaveBeenCalledTimes(1);

    await act(async () => {
      second.resolve([{ motif: "opening_trap", count: 4 }]);
      await second.promise;
    });
    expect(within(card).queryByRole("alert")).toBeNull();
    expect(within(card).getByRole("radio", { name: /opening trap, 4 puzzles/i })).toBeTruthy();
  });

  it("keeps the motif card on its error and Try again when the retry fails too, then recovers on a third press", async () => {
    const fetchMotifs = vi
      .fn()
      .mockRejectedValueOnce(new Error("x"))
      .mockRejectedValueOnce(new Error("y"))
      .mockResolvedValueOnce([{ motif: "opening_trap", count: 4 }]);
    render(<Practice server={serverApi()} {...hub} fetchMotifs={fetchMotifs} />);
    const card = await screen.findByRole("region", { name: "Puzzles by motif" });
    await within(card).findByRole("alert");

    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    const again = await within(card).findByRole("alert");
    expect(again.textContent).toBe(
      "The motif list could not be loaded. You can still drill with Any motif.",
    );
    expect(within(card).queryByRole("status")).toBeNull();
    expect(fetchMotifs).toHaveBeenCalledTimes(2);

    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(
      await within(card).findByRole("radio", { name: /opening trap, 4 puzzles/i }),
    ).toBeTruthy();
    expect(within(card).queryByRole("alert")).toBeNull();
    expect(fetchMotifs).toHaveBeenCalledTimes(3);
  });

  it("says to restart the server when no puzzle is loaded at all", async () => {
    render(<Practice server={serverApi()} {...hub} fetchMotifs={async () => []} />);
    expect(await screen.findByText(/Restart the server/)).toBeTruthy();
  });

  it("still offers the review when card numbers cannot be loaded and retries only progress", async () => {
    const second = deferred<ReturnType<typeof progressOf>>();
    const fetchProgress = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(second.promise);
    const fetchMotifs = vi.fn(hub.fetchMotifs);
    const fetchRepertoires = vi.fn(hub.fetchRepertoires);
    const fetchRepertoireList = vi.fn(hub.fetchRepertoireList);
    const fetchOpeningDrills = vi.fn(hub.fetchOpeningDrills);
    render(
      <Practice
        server={serverApi()}
        fetchProgress={fetchProgress}
        fetchMotifs={fetchMotifs}
        fetchRepertoires={fetchRepertoires}
        fetchRepertoireList={fetchRepertoireList}
        fetchOpeningDrills={fetchOpeningDrills}
      />,
    );
    const card = await screen.findByRole("region", { name: "Due cards" });
    const alert = await within(card).findByRole("alert");
    expect(alert.className).toContain("practice__failure");
    expect(alert.textContent).toBe("Your card numbers could not be loaded.");
    expect(within(card).getByRole("button", { name: "Review due cards" })).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(within(card).getByRole("status").textContent).toBe("Loading your cards.");
    expect(fetchProgress).toHaveBeenCalledTimes(2);
    expect(fetchMotifs).toHaveBeenCalledTimes(1);
    expect(fetchRepertoires).toHaveBeenCalledTimes(1);
    expect(fetchOpeningDrills).toHaveBeenCalledTimes(1);

    await act(async () => {
      second.resolve(progressOf());
      await second.promise;
    });
    expect(within(card).queryByRole("alert")).toBeNull();
    expect(within(card).getByRole("button", { name: "Review 4 cards" })).toBeTruthy();
  });

  it("keeps the review fallback when card numbers fail without retrying", async () => {
    render(<Practice server={serverApi()} {...hub} fetchProgress={noProgress} />);
    const card = await screen.findByRole("region", { name: "Due cards" });
    expect((await within(card).findByRole("alert")).textContent).toBe(
      "Your card numbers could not be loaded.",
    );
    expect(within(card).getByRole("button", { name: "Review due cards" })).toBeTruthy();
  });

  it("offers Try again in Openings when game drills fail and retries only opening drills", async () => {
    const second = deferred<OpeningDrillsResponse>();
    const fetchOpeningDrills = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockReturnValueOnce(second.promise);
    const fetchProgress = vi.fn(hub.fetchProgress);
    const fetchMotifs = vi.fn(hub.fetchMotifs);
    const fetchRepertoires = vi.fn(hub.fetchRepertoires);
    render(
      <Practice
        server={serverApi()}
        fetchProgress={fetchProgress}
        fetchMotifs={fetchMotifs}
        fetchRepertoires={fetchRepertoires}
        fetchRepertoireList={hub.fetchRepertoireList}
        fetchOpeningDrills={fetchOpeningDrills}
      />,
    );
    openPracticePage("Openings");

    const card = await screen.findByRole("region", { name: "Openings" });
    const alert = await within(card).findByRole("alert");
    expect(alert.className).toContain("practice__failure");
    expect(alert.textContent).toBe("The positions from your games could not be loaded.");

    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(within(card).getByRole("status").textContent).toBe("Loading positions from your games.");
    expect(fetchOpeningDrills).toHaveBeenCalledTimes(2);
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    expect(fetchMotifs).toHaveBeenCalledTimes(1);
    expect(fetchRepertoires).toHaveBeenCalledTimes(1);

    await act(async () => {
      second.resolve({
        white: [
          {
            opening: "Sicilian Defense",
            positions: 6,
            attempts_30d: 0,
            first_try_30d: 0,
            repertoire_id: null,
          },
        ],
        black: [],
      });
      await second.promise;
    });
    expect(within(card).queryByRole("alert")).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Drill Sicilian Defense as White" }),
    ).toBeTruthy();
  });

  it("shows a starting state until the server answers, then the refusal", async () => {
    const server = serverApi();
    const view = render(<Practice server={server} {...hub} />);
    await screen.findByRole("radio", { name: /fork/i });
    fireEvent.click(await screen.findByRole("button", { name: "Review 4 cards" }));
    expect(server.send).toHaveBeenCalledWith({ type: "start_training", mode: "srs" });
    const starting = screen.getByRole("button", { name: "Starting" }) as HTMLButtonElement;
    expect(starting.disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Start any motif" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    view.rerender(
      <Practice
        server={{
          ...server,
          errorCount: 1,
          lastError: "no review card is due",
          lastErrorCode: "empty_queue",
        }}
        {...hub}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("Nothing is due right now");
    expect(screen.getByRole("alert").textContent).toContain("Create cards");
    expect(screen.getByRole("button", { name: "Review 4 cards" })).toBeTruthy();
  });

  it("names the motif when a drill has no puzzles for it", async () => {
    const server = serverApi();
    const view = render(<Practice server={server} {...hub} />);
    fireEvent.click(await screen.findByRole("radio", { name: /fork/i }));
    fireEvent.click(screen.getByRole("button", { name: "Start Fork" }));
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "puzzles",
      motif: "fork",
    });
    view.rerender(
      <Practice
        server={{
          ...server,
          errorCount: 1,
          lastError: "no puzzle matches",
          lastErrorCode: "empty_queue",
        }}
        {...hub}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("There are no Fork puzzles");
  });

  it("shows the server's message and a next step when a start fails for another reason", async () => {
    const server = serverApi();
    const view = render(<Practice server={server} {...hub} />);
    await screen.findByRole("radio", { name: /fork/i });
    fireEvent.click(await screen.findByRole("button", { name: "Review 4 cards" }));
    view.rerender(
      <Practice
        server={{
          ...server,
          errorCount: 1,
          lastError: "finish the game first",
          lastErrorCode: "game_in_progress",
        }}
        {...hub}
      />,
    );
    const alert = (await screen.findByRole("alert")).textContent ?? "";
    expect(alert).toContain("finish the game first");
    expect(alert).toContain("Try again");
  });

  it("ends the wait when the connection drops before the server answers", async () => {
    const server = serverApi();
    const view = render(<Practice server={server} {...hub} />);
    await screen.findByRole("radio", { name: /fork/i });
    fireEvent.click(await screen.findByRole("button", { name: "Review 4 cards" }));
    view.rerender(<Practice server={{ ...server, connection: "reconnecting" }} {...hub} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not connected"));
    expect(
      (screen.getByRole("button", { name: "Review 4 cards" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("does not enter the starting state when the command could not be sent", async () => {
    const server = serverApi(null, { send: vi.fn(() => false) });
    render(<Practice server={server} {...hub} />);
    await screen.findByRole("radio", { name: /fork/i });
    fireEvent.click(await screen.findByRole("button", { name: "Review 4 cards" }));
    expect(screen.getByRole("alert").textContent).toContain("not connected");
    expect(screen.queryByRole("button", { name: "Starting" })).toBeNull();
  });
});
