import type { ActivityState } from "@chess-coach/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardFactory } from "../src/components/Board.js";
import type { ServerApi } from "../src/hooks/useServer.js";
import { Play } from "../src/screens/Play.js";
import { CLASSIFICATION_LABEL, controlState, evalView } from "../src/state/play.js";
import { liveGame, move } from "./fixtures.js";

afterEach(cleanup);

const inertBoard: BoardFactory = () => ({ set: vi.fn(), destroy: vi.fn() }) as never;

function api(activity: ActivityState | null, overrides: Partial<ServerApi> = {}): ServerApi {
  return {
    items: [],
    permissions: [],
    lastError: null,
    errorCount: 0,
    localCount: 0,
    activity,
    cardsCreated: {},
    connection: "connected",
    say: vi.fn(() => true),
    approve: vi.fn(),
    dismissError: vi.fn(),
    send: vi.fn(() => true),
    ...overrides,
  };
}

const twoPlies = [move(1), move(2)];

describe("move list", () => {
  it("shows a badge with its text for every classification, two plies per row", () => {
    const classes = Object.keys(CLASSIFICATION_LABEL) as (keyof typeof CLASSIFICATION_LABEL)[];
    const moves = classes.flatMap((classification, index) => [
      move(index * 2 + 1, { classification }),
      move(index * 2 + 2),
    ]);
    render(<Play server={api(liveGame({ moves }))} createBoard={inertBoard} />);
    const badges = screen.getAllByTestId("badge");
    expect(badges.map((badge) => badge.textContent)).toEqual(Object.values(CLASSIFICATION_LABEL));
    classes.forEach((classification, index) => {
      expect(badges[index]?.className).toContain(`badge--${classification}`);
    });
    const rows = within(screen.getByRole("list", { name: "Moves" })).getAllByRole("listitem");
    expect(rows).toHaveLength(classes.length);
    expect(rows[0]?.textContent).toContain("1.");
  });

  it("puts no badge on an unclassified engine ply", () => {
    render(<Play server={api(liveGame({ moves: twoPlies }))} createBoard={inertBoard} />);
    expect(screen.queryAllByTestId("badge")).toHaveLength(0);
  });
});

describe("eval bar", () => {
  const view = (cp: number) => evalView([move(1, { eval_after_cp: cp })]);

  it("clamps the bar and the number to plus or minus 1000", () => {
    expect(view(4000)).toMatchObject({ fillPercent: 100, label: "+10.0" });
    expect(view(-4000)).toMatchObject({ fillPercent: 0, label: "-10.0" });
    expect(view(150)).toMatchObject({ fillPercent: 57.5, label: "+1.5" });
    expect(view(0)).toMatchObject({ fillPercent: 50, label: "0.0" });
  });

  it("shows M for a mate in either direction", () => {
    expect(view(10000)?.label).toBe("M");
    expect(view(-10000)).toMatchObject({ label: "M", fillPercent: 0 });
  });

  it("reads the latest student move and ignores engine plies", () => {
    const moves = [
      move(1, { eval_after_cp: 30 }),
      move(2, { eval_after_cp: -999 }),
      move(3, { eval_after_cp: null }),
    ];
    expect(evalView(moves)?.label).toBe("+0.3");
    expect(evalView([])).toBeNull();
  });

  it("renders the label beside the bar", () => {
    const moves = [move(1, { eval_after_cp: 250 })];
    render(<Play server={api(liveGame({ moves }))} createBoard={inertBoard} />);
    expect(screen.getByTestId("eval-label").textContent).toBe("+2.5");
  });
});

describe("control enablement", () => {
  const phases = ["player_turn", "evaluating", "engine_turn", "finished"] as const;

  it.each(phases)("undo in %s with two plies", (phase) => {
    const state = liveGame({ phase, moves: twoPlies });
    expect(controlState(state).undo).toBe(phase === "player_turn");
  });

  it("needs two plies before undo", () => {
    expect(controlState(liveGame({ moves: [move(1)] })).undo).toBe(false);
    expect(controlState(liveGame({ moves: twoPlies })).undo).toBe(true);
  });

  it("resign and abort follow a running game; new game follows its absence", () => {
    expect(controlState(liveGame())).toMatchObject({ resign: true, abort: true, newGame: false });
    const finished = liveGame({ phase: "finished", result: "1-0", termination: "checkmate" });
    expect(controlState(finished)).toMatchObject({ resign: false, abort: false, newGame: true });
    expect(controlState(null)).toMatchObject({ resign: false, newGame: true, backToGame: false });
  });

  it("offers Back to game only in a demo", () => {
    const demo: ActivityState = {
      ...liveGame(),
      kind: "demo",
      returns_to: "live_game",
      moves_played: [],
    } as never;
    expect(controlState(demo)).toMatchObject({ backToGame: true, newGame: false });
    expect(controlState(liveGame()).backToGame).toBe(false);
  });

  it("disables the Undo button while the engine is being evaluated", () => {
    const state = liveGame({ phase: "evaluating", moves: twoPlies, input_enabled: false });
    render(<Play server={api(state)} createBoard={inertBoard} />);
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("controls send commands against the current activity", () => {
  it("sends undo, resign and abort with the activity id", () => {
    const send = vi.fn(() => true);
    const state = liveGame({ activity_id: 7, moves: twoPlies });
    render(<Play server={api(state, { send })} createBoard={inertBoard} />);
    for (const name of ["Undo", "Resign", "Abort"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    expect(send.mock.calls).toEqual([
      [{ type: "undo", activity_id: 7 }],
      [{ type: "resign", activity_id: 7 }],
      [{ type: "abort", activity_id: 7 }],
    ]);
  });

  it("starts a new game from the dialog at Elo 600 by default", () => {
    const send = vi.fn(() => true);
    render(<Play server={api(null, { send })} createBoard={inertBoard} />);
    fireEvent.click(screen.getByRole("button", { name: "New game" }));
    const dialog = screen.getByRole("dialog", { name: "New game" });
    expect((within(dialog).getByLabelText("Engine Elo") as HTMLInputElement).value).toBe("600");
    fireEvent.click(within(dialog).getByLabelText("black"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    expect(send).toHaveBeenCalledWith({ type: "new_game", color: "black", elo: 600 });
  });

  it("refuses an Elo outside 100..3190", () => {
    const send = vi.fn(() => true);
    render(<Play server={api(null, { send })} createBoard={inertBoard} />);
    fireEvent.click(screen.getByRole("button", { name: "New game" }));
    const input = screen.getByLabelText("Engine Elo");
    for (const bad of ["99", "3191", "", "12.5"]) {
      fireEvent.change(input, { target: { value: bad } });
      expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("sends a move command carrying the promotion and the activity id", () => {
    const send = vi.fn(() => true);
    let moveCallback: ((from: string, to: string) => void) | undefined;
    const board: BoardFactory = (_element, config) => {
      moveCallback = config.events?.move as typeof moveCallback;
      return { set: vi.fn(), destroy: vi.fn() } as never;
    };
    render(<Play server={api(liveGame({ activity_id: 3 }), { send })} createBoard={board} />);
    moveCallback?.("e2", "e4");
    expect(send).toHaveBeenCalledWith({
      type: "move",
      from: "e2",
      to: "e4",
      promotion: undefined,
      activity_id: 3,
    });
  });
});
