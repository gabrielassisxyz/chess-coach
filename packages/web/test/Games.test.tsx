import type { GameDetail, GameSummary } from "@chess-coach/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardFactory } from "../src/components/Board.js";
import { useServer } from "../src/hooks/useServer.js";
import { Games } from "../src/screens/Games.js";
import type { GamesApi } from "../src/state/games-api.js";
import { createFakeSocket, FakeSocket } from "./fake-socket.js";
import { COACH_GAME_SOURCE, idleImportApi, START_FEN } from "./fixtures.js";

const SANS = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"];

function fixtureGame(): GameDetail {
  const chess = new Chess();
  const moves = SANS.map((san, index) => {
    const played = chess.move(san);
    return {
      ply: index + 1,
      san,
      uci: `${played.from}${played.to}`,
      is_player: index % 2 === 0,
      eval_before_cp: null,
      eval_after_cp: null,
      cp_loss: index % 2 === 0 ? (index === 2 ? 120 : 10) : null,
      classification:
        index % 2 === 0 ? (index === 2 ? ("inaccuracy" as const) : ("great" as const)) : null,
      best_move_san: index === 2 ? "d4" : null,
      fen_after: chess.fen(),
    };
  });
  return {
    ...COACH_GAME_SOURCE,
    id: 7,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T01:00:00.000Z",
    player_color: "white",
    target_elo: 1200,
    result: "0-1",
    termination: "resign",
    initial_fen: START_FEN,
    mistakes_count: 3,
    moves,
  };
}

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
  worst_moment: { ply: 3, san: "Nf3", cp_loss: 120, classification: "inaccuracy" },
  cards_count: 2,
  mistakes_count: 3,
};

const game = fixtureGame();
const api: GamesApi = {
  listGames: async () => [summary],
  getGame: async () => game,
};

const boardSets: string[] = [];
const factory: BoardFactory = (_element, config) => {
  if (config.fen) boardSets.push(config.fen);
  return {
    set: (next: { fen?: string }) => {
      if (next.fen) boardSets.push(next.fen);
    },
    destroy: vi.fn(),
  } as never;
};

const onCoachIdle = vi.fn();
let detail: GameDetail = game;
const detailApi: GamesApi = { ...api, getGame: async () => detail };

function Harness() {
  const server = useServer({ createSocket: createFakeSocket });
  return (
    <Games
      server={server}
      api={detailApi}
      importApi={idleImportApi}
      createBoard={factory}
      onCoachIdle={onCoachIdle}
    />
  );
}

const commands = (): { type: string; ply?: number }[] =>
  FakeSocket.latest.sent as { type: string; ply?: number }[];

async function openGame(): Promise<void> {
  render(<Harness />);
  act(() => FakeSocket.latest.open());
  act(() =>
    FakeSocket.latest.receive({
      type: "bootstrap",
      conversations: { play: [], games: [], practice: [] },
      activity: null,
    }),
  );
  fireEvent.doubleClick(await screen.findByRole("row", { name: /1200/ }));
  await screen.findByRole("button", { name: "Next" });
  // The game is set from a promise callback outside act(), so React may commit the DOM before it
  // has run the passive effects that build the board and arm the debounce. Wait for the board.
  await waitFor(() => expect(boardSets.length).toBeGreaterThan(0));
  await act(async () => {});
}

const press = (key: string, target: Element | Window = window): void => {
  act(() => {
    fireEvent.keyDown(target, { key });
  });
};

beforeEach(() => {
  detail = game;
  onCoachIdle.mockClear();
  FakeSocket.reset();
  boardSets.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("games list and stepping", () => {
  it("lists the game and opens it on the starting position, telling the server once", async () => {
    await openGame();
    expect(boardSets.at(-1)).toBe(START_FEN);
    expect(commands()).toEqual([expect.objectContaining({ type: "open_game", game_id: 7 })]);
  });

  it("steps with the arrow keys, Home and End, clamped, and renders each position locally", async () => {
    await openGame();
    press("ArrowRight");
    expect(boardSets.at(-1)).toBe(game.moves[0]?.fen_after);
    press("End");
    expect(boardSets.at(-1)).toBe(game.moves[5]?.fen_after);
    press("ArrowRight");
    expect(boardSets.at(-1)).toBe(game.moves[5]?.fen_after);
    press("ArrowLeft");
    expect(boardSets.at(-1)).toBe(game.moves[4]?.fen_after);
    press("Home");
    expect(boardSets.at(-1)).toBe(START_FEN);
    press("ArrowLeft");
    expect(boardSets.at(-1)).toBe(START_FEN);
  });

  it("selects a row by click and highlights it, with its grade shown", async () => {
    await openGame();
    fireEvent.click(screen.getByTestId("ply-3"));
    expect(screen.getByTestId("ply-3").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("ply-1").getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("ply-detail").textContent).toContain(
      "2. Nf3, Inaccuracy, cp loss 120, best was d4",
    );
    expect(boardSets.at(-1)).toBe(game.moves[2]?.fen_after);
  });
});

describe("open game header and position line", () => {
  it("titles the game, and counts the full moves and the accuracy from the list", async () => {
    await openGame();
    expect(screen.getByRole("heading", { name: "White vs Stockfish 1200" })).toBeTruthy();
    expect(screen.getByText(/^Coached · .+ · 0–1 in 3 · accuracy 50%$/)).toBeTruthy();
  });

  it("says which move it is on above the board, three steps in", async () => {
    await openGame();
    expect(screen.getByTestId("position-line").textContent).toBe("move 0 of 6");
    press("ArrowRight");
    press("ArrowRight");
    press("ArrowRight");
    expect(screen.getByTestId("position-line").textContent).toBe("2. Nf3 · move 3 of 6");
  });

  it("puts the coach panel's idle words on the move and takes them back on leaving", async () => {
    await openGame();
    expect(onCoachIdle).toHaveBeenLastCalledWith(null);
    press("ArrowRight");
    press("ArrowRight");
    press("ArrowRight");
    expect(onCoachIdle).toHaveBeenLastCalledWith("looking at move 2");
    fireEvent.click(screen.getByRole("button", { name: "All games" }));
    expect(onCoachIdle).toHaveBeenLastCalledWith(null);
  });

  it("goes back to the list and keeps it", async () => {
    await openGame();
    fireEvent.click(screen.getByRole("button", { name: "All games" }));
    expect(await screen.findByRole("table", { name: "Finished games" })).toBeTruthy();
  });
});

describe("select_review_ply debounce", () => {
  it("sends one command for a burst of steps, never earlier than 150 ms after the last", async () => {
    await openGame();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (let i = 0; i < 5; i++) {
      press("ArrowRight");
      act(() => vi.advanceTimersByTime(50));
    }
    expect(commands().filter((c) => c.type === "select_review_ply")).toEqual([]);
    act(() => vi.advanceTimersByTime(100));
    expect(commands().filter((c) => c.type === "select_review_ply")).toEqual([
      expect.objectContaining({ ply: 5, game_id: 7 }),
    ]);
    expect(commands().map((c) => c.type)).toEqual(["open_game", "select_review_ply"]);
  });

  it("sends nothing while the student has not moved off the position the server holds", async () => {
    await openGame();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    press("ArrowRight");
    press("ArrowLeft");
    act(() => vi.advanceTimersByTime(500));
    expect(commands().map((c) => c.type)).toEqual(["open_game"]);
  });
});

describe("keyboard focus", () => {
  it.each([
    ["textarea", () => document.createElement("textarea")],
    ["input", () => document.createElement("input")],
    [
      "contenteditable",
      () => {
        const div = document.createElement("div");
        div.setAttribute("contenteditable", "true");
        return div;
      },
    ],
  ])("does not step while a %s has focus", async (_name, build) => {
    await openGame();
    const field = build();
    document.body.append(field);
    field.focus();
    press("ArrowRight", field);
    press("End", field);
    expect(boardSets.at(-1)).toBe(START_FEN);
    field.remove();
    press("ArrowRight");
    expect(boardSets.at(-1)).toBe(game.moves[0]?.fen_after);
  });
});

describe("coach and cards", () => {
  it("asks about the selected ply only after a ply is selected", async () => {
    await openGame();
    const ask = screen.getByRole("button", { name: "Ask the coach about this move" });
    expect((ask as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("ply-3"));
    expect(screen.getByRole("button", { name: "Ask the coach about 2. Nf3" })).toBe(ask);
    fireEvent.click(ask);
    expect(commands()).toContainEqual(
      expect.objectContaining({ type: "ask_coach_about_ply", game_id: 7, ply: 3 }),
    );
  });

  it("shows the count after cards_created and keeps the button disabled", async () => {
    await openGame();
    fireEvent.click(screen.getByRole("button", { name: "Create cards from 3 mistakes" }));
    expect(commands()).toContainEqual(
      expect.objectContaining({ type: "create_cards", game_id: 7 }),
    );
    act(() => FakeSocket.latest.receive({ type: "cards_created", game_id: 7, count: 3 }));
    const done = screen.getByRole("button", { name: "3 cards created" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    act(() => FakeSocket.latest.receive({ type: "cards_created", game_id: 7, count: 0 }));
    expect(screen.getByRole("button", { name: "3 cards created" })).toBeTruthy();
  });
});

describe("create cards", () => {
  it("is disabled when the game has no mistakes", async () => {
    detail = { ...game, mistakes_count: 0 };
    await openGame();
    const button = screen.getByRole("button", { name: "Create cards from 0 mistakes" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("says mistake in the singular", async () => {
    detail = { ...game, mistakes_count: 1 };
    await openGame();
    expect(screen.getByRole("button", { name: "Create cards from 1 mistake" })).toBeTruthy();
  });
});

describe("coach demo", () => {
  it("shows the coach's position and stops stepping until the student goes back", async () => {
    await openGame();
    const demoFen = "8/8/8/8/8/8/8/K6k w - - 0 1";
    act(() =>
      FakeSocket.latest.receive({
        type: "activity",
        state: {
          kind: "demo",
          activity_id: 4,
          orientation: "white",
          fen: demoFen,
          turn: "white",
          last_move: null,
          legal_moves: [],
          input_enabled: false,
          pending: "none",
          returns_to: "review",
          moves_played: [],
        },
      }),
    );
    expect(boardSets.at(-1)).toBe(demoFen);
    press("ArrowRight");
    expect(boardSets.at(-1)).toBe(demoFen);
    fireEvent.click(screen.getByRole("button", { name: "Back to review" }));
    expect(commands().at(-1)).toMatchObject({ type: "leave_demo", activity_id: 4 });
  });
});

describe("failures", () => {
  it("says so when the list cannot be loaded", async () => {
    const broken: GamesApi = { ...api, listGames: async () => Promise.reject(new Error("down")) };
    render(
      <Games server={{} as never} api={broken} importApi={idleImportApi} createBoard={factory} />,
    );
    await waitFor(() => expect(screen.getByText(/The games could not be loaded/)).toBeTruthy());
  });
});
