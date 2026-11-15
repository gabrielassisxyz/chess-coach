import type { GameSummary, ThemeStatsResponse } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Games } from "../src/screens/Games.js";
import { Practice } from "../src/screens/Practice.js";
import type { GamesApi } from "../src/state/games-api.js";
import { PRACTICE_PAGE_STORAGE_KEY } from "../src/state/practice-page.js";
import { COACH_GAME_SOURCE, idleImportApi } from "./fixtures.js";
import { noFoundPositions, progressOf } from "./practice-fixtures.js";
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

const noProgress = async (): Promise<never> => Promise.reject(new Error("offline"));
const emptyThemeStats = async (): Promise<ThemeStatsResponse> => ({
  days: "30",
  overall: { played: 0, first_try: 0, rating_avg: null, performance: null },
  overall_previous: null,
  themes: [],
  improvement_areas: [],
  strengths: [],
  unranked: 0,
});
const hub = {
  fetchProgress: async () => progressOf(),
  fetchRepertoires: async () => [],
  fetchRepertoireList: async () => ({ repertoires: [], met: [] }),
  fetchFoundPositions: async () => noFoundPositions,
  fetchThemeStats: emptyThemeStats,
};

describe("Practice states", () => {
  it("says so when the theme statistics cannot be loaded, still starts any theme, and retries only them", async () => {
    const second = deferred<ThemeStatsResponse>();
    const fetchThemeStats = vi
      .fn()
      .mockRejectedValueOnce(new Error("x"))
      .mockReturnValueOnce(second.promise);
    const fetchProgress = vi.fn(hub.fetchProgress);
    const fetchRepertoireList = vi.fn(hub.fetchRepertoireList);
    const server = serverApi();
    render(
      <Practice
        server={server}
        fetchThemeStats={fetchThemeStats}
        fetchProgress={fetchProgress}
        fetchRepertoires={hub.fetchRepertoires}
        fetchRepertoireList={fetchRepertoireList}
      />,
    );
    const card = await screen.findByRole("region", { name: "Puzzles by weakness" });
    const alert = await within(card).findByRole("alert");
    expect(alert.className).toContain("practice__failure");
    expect(alert.textContent).toBe("Your theme statistics could not be loaded.");
    const themes = screen.getByRole("region", { name: "Puzzle themes" });
    expect(
      (within(themes).getByRole("button", { name: /^Healthy mix/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(within(themes).getByRole("button", { name: /^Fork\b/ }));
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "puzzles",
      motif: "fork",
    });
  });

  it("retries only the theme statistics when Try again is pressed in the weakness card", async () => {
    const second = deferred<ThemeStatsResponse>();
    const fetchThemeStats = vi
      .fn()
      .mockRejectedValueOnce(new Error("x"))
      .mockReturnValueOnce(second.promise);
    const fetchProgress = vi.fn(hub.fetchProgress);
    const fetchRepertoireList = vi.fn(hub.fetchRepertoireList);
    render(
      <Practice
        server={serverApi()}
        fetchThemeStats={fetchThemeStats}
        fetchProgress={fetchProgress}
        fetchRepertoires={hub.fetchRepertoires}
        fetchRepertoireList={fetchRepertoireList}
      />,
    );
    const card = await screen.findByRole("region", { name: "Puzzles by weakness" });
    await within(card).findByRole("alert");

    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(within(card).getByRole("status").textContent).toBe("Loading your theme statistics.");
    expect(fetchThemeStats).toHaveBeenCalledTimes(2);
    expect(fetchProgress).toHaveBeenCalledTimes(1);
    expect(fetchRepertoireList).toHaveBeenCalledTimes(1);

    await act(async () => {
      second.resolve(await emptyThemeStats());
      await second.promise;
    });
    expect(within(card).queryByRole("alert")).toBeNull();
    expect(within(card).getByRole("button", { name: "Start a healthy mix" })).toBeTruthy();
  });

  it("keeps the weakness card on its error and Try again when the retry fails too, then recovers on a third press", async () => {
    const fetchThemeStats = vi
      .fn()
      .mockRejectedValueOnce(new Error("x"))
      .mockRejectedValueOnce(new Error("y"))
      .mockResolvedValueOnce(await emptyThemeStats());
    render(<Practice server={serverApi()} {...hub} fetchThemeStats={fetchThemeStats} />);
    const card = await screen.findByRole("region", { name: "Puzzles by weakness" });
    await within(card).findByRole("alert");

    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    const again = await within(card).findByRole("alert");
    expect(again.textContent).toBe("Your theme statistics could not be loaded.");
    expect(within(card).queryByRole("status")).toBeNull();
    expect(fetchThemeStats).toHaveBeenCalledTimes(2);

    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(await within(card).findByRole("button", { name: "Start a healthy mix" })).toBeTruthy();
    expect(within(card).queryByRole("alert")).toBeNull();
    expect(fetchThemeStats).toHaveBeenCalledTimes(3);
  });

  it("still offers the review when card numbers cannot be loaded and retries only progress", async () => {
    const second = deferred<ReturnType<typeof progressOf>>();
    const fetchProgress = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(second.promise);
    const fetchThemeStats = vi.fn(hub.fetchThemeStats);
    const fetchRepertoireList = vi.fn(hub.fetchRepertoireList);
    render(
      <Practice
        server={serverApi()}
        fetchProgress={fetchProgress}
        fetchThemeStats={fetchThemeStats}
        fetchRepertoires={hub.fetchRepertoires}
        fetchRepertoireList={fetchRepertoireList}
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
    expect(fetchThemeStats).toHaveBeenCalledTimes(1);
    expect(fetchRepertoireList).toHaveBeenCalledTimes(1);

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

  it("shows a starting state until the server answers, then the refusal", async () => {
    const server = serverApi();
    const view = render(<Practice server={server} {...hub} />);
    await screen.findByRole("button", { name: /^Fork\b/ });
    fireEvent.click(await screen.findByRole("button", { name: "Review 4 cards" }));
    expect(server.send).toHaveBeenCalledWith({ type: "start_training", mode: "srs" });
    const starting = screen.getByRole("button", { name: "Starting" }) as HTMLButtonElement;
    expect(starting.disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: /^Healthy mix/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: /^Fork\b/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );

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
    fireEvent.click(await screen.findByRole("button", { name: /^Fork\b/ }));
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
    await screen.findByRole("button", { name: /^Fork\b/ });
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
    await screen.findByRole("button", { name: /^Fork\b/ });
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
    await screen.findByRole("button", { name: /^Fork\b/ });
    fireEvent.click(await screen.findByRole("button", { name: "Review 4 cards" }));
    expect(screen.getByRole("alert").textContent).toContain("not connected");
    expect(screen.queryByRole("button", { name: "Starting" })).toBeNull();
  });
});
