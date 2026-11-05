import type { GameSummary } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Games } from "../src/screens/Games.js";
import { Practice } from "../src/screens/Practice.js";
import type { GamesApi } from "../src/state/games-api.js";
import { COACH_GAME_SOURCE, idleImportApi } from "./fixtures.js";
import { serverApi } from "./server-api.js";

afterEach(cleanup);

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
    expect(await screen.findByText(/Finish a game on the Play screen/)).toBeTruthy();
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
    expect(await screen.findByRole("list", { name: "Finished games" })).toBeTruthy();
    expect(listGames).toHaveBeenCalledTimes(2);
  });

  it("says a game could not be opened and keeps the list to pick another", async () => {
    const getGame = vi.fn<GamesApi["getGame"]>().mockRejectedValue(new Error("gone"));
    render(<Games server={serverApi()} api={gamesApi({ getGame })} importApi={idleImportApi} />);
    fireEvent.click(await screen.findByRole("button", { name: /1200/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("pick another game");
    expect(screen.getByRole("list", { name: "Finished games" })).toBeTruthy();
  });
});

const motifs = async () => [{ motif: "fork", count: 4 }];
const noProgress = async (): Promise<never> => Promise.reject(new Error("offline"));
const hub = { fetchMotifs: motifs, fetchProgress: noProgress };

describe("Practice states", () => {
  it("shows the motif rows only once the list has loaded", async () => {
    let resolve: (value: { motif: string; count: number }[]) => void = () => {};
    const fetchMotifs = () => new Promise<{ motif: string; count: number }[]>((r) => (resolve = r));
    render(<Practice server={serverApi()} {...hub} fetchMotifs={fetchMotifs} />);
    expect(screen.getByText("Loading motifs.")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /fork/ })).toBeNull();
    await act(async () => resolve([{ motif: "fork", count: 4 }]));
    expect(screen.getByRole("radio", { name: /fork/ })).toBeTruthy();
    expect(screen.queryByText("Loading motifs.")).toBeNull();
  });

  it("says so when the motif list cannot be loaded and still allows any motif", async () => {
    render(
      <Practice
        server={serverApi()}
        {...hub}
        fetchMotifs={async () => Promise.reject(new Error("x"))}
      />,
    );
    expect(await screen.findByText(/could not be loaded.*Any motif/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Start any motif" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("says to restart the server when no puzzle is loaded at all", async () => {
    render(<Practice server={serverApi()} {...hub} fetchMotifs={async () => []} />);
    expect(await screen.findByText(/Restart the server/)).toBeTruthy();
  });

  it("still offers the review when the card numbers cannot be loaded", async () => {
    render(<Practice server={serverApi()} {...hub} />);
    expect(await screen.findByText("Your card numbers are not available.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review due cards" })).toBeTruthy();
  });

  it("shows a starting state until the server answers, then the refusal", async () => {
    const server = serverApi();
    const view = render(<Practice server={server} {...hub} />);
    await screen.findByRole("radio", { name: /fork/ });
    fireEvent.click(screen.getByRole("button", { name: "Review due cards" }));
    expect(server.send).toHaveBeenCalledWith({ type: "start_training", mode: "srs", size: 10 });
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
    expect(screen.getByRole("button", { name: "Review due cards" })).toBeTruthy();
  });

  it("names the motif when a drill has no puzzles for it", async () => {
    const server = serverApi();
    const view = render(<Practice server={server} {...hub} />);
    fireEvent.click(await screen.findByRole("radio", { name: /fork/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start fork" }));
    expect(server.send).toHaveBeenCalledWith({
      type: "start_training",
      mode: "puzzles",
      motif: "fork",
      size: 10,
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
    expect((await screen.findByRole("alert")).textContent).toContain("There are no fork puzzles");
  });

  it("shows the server's message and a next step when a start fails for another reason", async () => {
    const server = serverApi();
    const view = render(<Practice server={server} {...hub} />);
    await screen.findByRole("radio", { name: /fork/ });
    fireEvent.click(screen.getByRole("button", { name: "Review due cards" }));
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
    await screen.findByRole("radio", { name: /fork/ });
    fireEvent.click(screen.getByRole("button", { name: "Review due cards" }));
    view.rerender(<Practice server={{ ...server, connection: "reconnecting" }} {...hub} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not connected"));
    expect(
      (screen.getByRole("button", { name: "Review due cards" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("does not enter the starting state when the command could not be sent", async () => {
    const server = serverApi(null, { send: vi.fn(() => false) });
    render(<Practice server={server} {...hub} />);
    await screen.findByRole("radio", { name: /fork/ });
    fireEvent.click(screen.getByRole("button", { name: "Review due cards" }));
    expect(screen.getByRole("alert").textContent).toContain("not connected");
    expect(screen.queryByRole("button", { name: "Starting" })).toBeNull();
  });
});
