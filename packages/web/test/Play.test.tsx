import type { ActivityState, TrainingActivity } from "@chess-coach/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardFactory } from "../src/components/Board.js";
import { Chat } from "../src/components/Chat.js";
import { CoachActions } from "../src/components/CoachActions.js";
import type { ServerApi } from "../src/hooks/useServer.js";
import { Play } from "../src/screens/Play.js";
import { BOARD_STORAGE_KEY } from "../src/state/board-theme.js";
import { CLASSIFICATION_LABEL, controlState, evalView } from "../src/state/play.js";
import { dayWords, type PlayFactsApi } from "../src/state/play-facts.js";
import { idleFactsApi, liveGame, move, START_FEN } from "./fixtures.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(idleFactsApi.getProgress));
  window.localStorage.clear();
  delete document.documentElement.dataset.board;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function facts(overrides: Partial<PlayFactsApi> = {}): PlayFactsApi {
  return {
    getGame: async () => ({ target_elo: 1100, started_at: new Date().toISOString() }) as never,
    getProgress: async () =>
      ({
        rating_history: [
          { played_at: "2026-01-01T00:00:00Z", rating: 380, time_class: "rapid" },
          { played_at: "2026-02-01T00:00:00Z", rating: 411, time_class: "blitz" },
        ],
      }) as never,
    ...overrides,
  };
}

// 9. a3 was a blunder: the student fell from +1.2 to -3.1 and the engine replied.
const blunderMoves = [
  move(17, {
    san: "a3",
    is_player: true,
    eval_before_cp: 120,
    eval_after_cp: -310,
    cp_loss: 430,
    best_move_san: "Qe4",
    classification: "blunder",
  }),
  move(18, { san: "Nxc2+", is_player: false }),
];

const inertBoard: BoardFactory = () => ({ set: vi.fn(), destroy: vi.fn() }) as never;

function api(activity: ActivityState | null, overrides: Partial<ServerApi> = {}): ServerApi {
  return {
    items: [],
    permissions: [],
    lastError: null,
    errorCount: 0,
    lastErrorCode: null,
    turn: "idle",
    localCount: 0,
    activity,
    currentElo: null,
    cardsCreated: {},
    coachMessages: 0,
    reconnectAttempt: 0,
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
  const classes = Object.keys(CLASSIFICATION_LABEL) as (keyof typeof CLASSIFICATION_LABEL)[];
  const graded = classes.flatMap((classification, index) => [
    move(index * 2 + 1, { classification }),
    move(index * 2 + 2),
  ]);

  it("puts a dot of its grade on every classified ply and the word beside it as text", () => {
    render(<Play server={api(liveGame({ moves: graded }))} createBoard={inertBoard} />);
    const list = screen.getByRole("list", { name: "Moves" });
    for (const [index, classification] of classes.entries()) {
      const cell = within(list).getByTestId(`ply-${index * 2 + 1}`);
      expect(within(cell).getByTestId("dot").className).toContain(`--${classification}`);
      expect(cell.textContent).toContain(CLASSIFICATION_LABEL[classification]);
    }
    expect(within(list).getAllByRole("listitem")).toHaveLength(classes.length);
  });

  it("marks inaccuracy, mistake and blunder with ?!, ? and ??, and nothing else", () => {
    render(<Play server={api(liveGame({ moves: graded }))} createBoard={inertBoard} />);
    const marks = screen.getAllByTestId("mark");
    expect(marks.map((mark) => mark.firstElementChild?.textContent)).toEqual(["?!", "?", "??"]);
    expect(marks.map((mark) => mark.className)).toEqual([
      "movelist__mark movelist__mark--inaccuracy",
      "movelist__mark movelist__mark--mistake",
      "movelist__mark movelist__mark--blunder",
    ]);
  });

  it("gives an unclassified engine ply a plain dot and no mark", () => {
    render(<Play server={api(liveGame({ moves: twoPlies }))} createBoard={inertBoard} />);
    expect(screen.queryAllByTestId("mark")).toHaveLength(0);
    for (const dot of screen.getAllByTestId("dot")) expect(dot.className).toContain("--none");
  });

  it("flags the blunder cell the card names and the latest ply", () => {
    render(<Play server={api(liveGame({ moves: blunderMoves }))} createBoard={inertBoard} />);
    expect(screen.getByTestId("ply-17").getAttribute("data-flagged")).toBe("true");
    expect(screen.getByTestId("ply-18").getAttribute("data-flagged")).toBeNull();
    expect(screen.getByTestId("ply-18").getAttribute("aria-current")).toBe("true");
  });
});

describe("game header and player labels", () => {
  it("names the game, the side and the engine's Elo once the game is looked up", async () => {
    const server = api(liveGame({ game_id: 14, orientation: "white", moves: twoPlies }));
    render(<Play server={server} createBoard={inertBoard} factsApi={facts()} />);
    expect(await screen.findByText("White vs Stockfish \u00b7 1100")).toBeTruthy();
    expect(screen.getByText("Game 14 \u00b7 today")).toBeTruthy();
  });

  it("labels the engine above the board and the student's latest rating below it", async () => {
    render(<Play server={api(liveGame())} createBoard={inertBoard} factsApi={facts()} />);
    await waitFor(() =>
      expect(document.querySelector(".table__top")?.textContent).toContain("1100"),
    );
    expect(document.querySelector(".table__top")?.textContent).toContain("Stockfish");
    expect(document.querySelector(".table__bottom")?.textContent).toBe("You411");
  });

  it("leaves the rating out when progress has none or cannot be read", async () => {
    const noHistory = facts({ getProgress: async () => ({ rating_history: [] }) as never });
    const view = render(
      <Play server={api(liveGame())} createBoard={inertBoard} factsApi={noHistory} />,
    );
    await waitFor(() =>
      expect(document.querySelector(".table__top")?.textContent).toContain("1100"),
    );
    expect(document.querySelector(".table__bottom")?.textContent).toBe("");
    view.unmount();

    const failing = facts({ getProgress: async () => Promise.reject(new Error("down")) });
    render(<Play server={api(liveGame())} createBoard={inertBoard} factsApi={failing} />);
    await waitFor(() =>
      expect(document.querySelector(".table__top")?.textContent).toContain("1100"),
    );
    expect(document.querySelector(".table__bottom")?.textContent).toBe("");
  });

  it("keeps the colour and drops the Elo when the game cannot be looked up", async () => {
    const failing = facts({ getGame: async () => Promise.reject(new Error("down")) });
    render(
      <Play
        server={api(liveGame({ game_id: 3, orientation: "black" }))}
        createBoard={inertBoard}
        factsApi={failing}
      />,
    );
    expect(await screen.findByText("Black vs Stockfish")).toBeTruthy();
    expect(screen.getByText("Game 3")).toBeTruthy();
  });

  it("words the day as today, yesterday or the date", () => {
    const now = new Date(2026, 5, 10, 12);
    expect(dayWords(new Date(2026, 5, 10, 1).toISOString(), now)).toBe("today");
    expect(dayWords(new Date(2026, 5, 9, 23).toISOString(), now)).toBe("yesterday");
    expect(dayWords("2026-05-01T10:00:00.000Z", now)).toBe("2026-05-01");
  });
});

describe("blunder card", () => {
  it("names the move, what it left, the best move and the loss from the ply's numbers", () => {
    render(<Play server={api(liveGame({ moves: blunderMoves }))} createBoard={inertBoard} />);
    const card = screen.getByTestId("blunder-card");
    expect(card.textContent).toBe("Blunder9. a3 \u00b7 \u22123.1Best was Qe4 (+1.2). Lost 4.3.");
  });

  it("writes a black move with three dots and ignores the engine's blunders", () => {
    const black = [
      move(2, {
        san: "a6",
        is_player: true,
        eval_after_cp: 50,
        cp_loss: 400,
        best_move_san: "Nf6",
        classification: "blunder",
      }),
    ];
    render(
      <Play
        server={api(liveGame({ orientation: "black", moves: black }))}
        createBoard={inertBoard}
      />,
    );
    expect(screen.getByTestId("blunder-card").textContent).toContain("1... a6 \u00b7 +0.5");
    cleanup();
    const engine = [move(2, { is_player: false, cp_loss: 500, classification: "blunder" })];
    render(<Play server={api(liveGame({ moves: engine }))} createBoard={inertBoard} />);
    expect(screen.queryByTestId("blunder-card")).toBeNull();
  });

  it("is absent while the student has no blunder", () => {
    render(<Play server={api(liveGame({ moves: twoPlies }))} createBoard={inertBoard} />);
    expect(screen.queryByTestId("blunder-card")).toBeNull();
  });

  it("sits under the move list and above the controls", () => {
    render(<Play server={api(liveGame({ moves: blunderMoves }))} createBoard={inertBoard} />);
    const order = [...document.querySelectorAll(".play > *")].map((node) => node.className);
    const list = order.indexOf("movelist");
    const card = order.indexOf("blunder-card");
    const controls = order.indexOf("controls");
    expect(list).toBeGreaterThan(-1);
    expect(card).toBe(list + 1);
    expect(controls).toBe(card + 1);
  });
});

describe("controls order", () => {
  it("lists Undo, Resign and Abort, then New game last", () => {
    render(<Play server={api(liveGame({ moves: twoPlies }))} createBoard={inertBoard} />);
    const names = within(document.querySelector(".controls") as HTMLElement)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual(["Undo", "Resign", "Abort", "New game"]);
  });
});

describe("board settings", () => {
  const open = () => fireEvent.click(screen.getByRole("button", { name: "Board settings" }));

  it("offers the four themes from the gear, Lichess selected by default", () => {
    render(<Play server={api(liveGame())} createBoard={inertBoard} />);
    expect(screen.queryByRole("radio")).toBeNull();
    open();
    const labels = screen.getAllByRole("radio").map((radio) => radio.parentElement?.textContent);
    expect(labels).toEqual(["Lichess", "Chess.com", "Slate", "Deep teal"]);
    expect((screen.getByLabelText("Lichess") as HTMLInputElement).checked).toBe(true);
  });

  it("applies the chosen theme through data-board and persists it", () => {
    render(<Play server={api(liveGame())} createBoard={inertBoard} />);
    open();
    fireEvent.click(screen.getByLabelText("Deep teal"));
    expect(document.documentElement.dataset.board).toBe("teal");
    expect(window.localStorage.getItem(BOARD_STORAGE_KEY)).toBe("teal");
    fireEvent.click(screen.getByLabelText("Lichess"));
    expect(document.documentElement.dataset.board).toBeUndefined();
    expect(window.localStorage.getItem(BOARD_STORAGE_KEY)).toBe("lichess");
  });

  it("starts from the stored theme and ignores a value it does not know", () => {
    window.localStorage.setItem(BOARD_STORAGE_KEY, "slate");
    render(<Play server={api(liveGame())} createBoard={inertBoard} />);
    expect(document.documentElement.dataset.board).toBe("slate");
    cleanup();
    delete document.documentElement.dataset.board;
    window.localStorage.setItem(BOARD_STORAGE_KEY, "neon");
    render(<Play server={api(liveGame())} createBoard={inertBoard} />);
    expect(document.documentElement.dataset.board).toBeUndefined();
  });
});

describe("coach actions after a blunder", () => {
  const withActions = (server: ServerApi) =>
    render(<Chat server={server} actions={<CoachActions server={server} />} />);

  it("offers Take back and Keep playing while undo is available after a blunder", () => {
    withActions(api(liveGame({ moves: blunderMoves })));
    expect(screen.getByRole("button", { name: "Take back 9.a3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep playing" })).toBeTruthy();
  });

  it("sends undo for the current activity on Take back", () => {
    const send = vi.fn(() => true);
    withActions(api(liveGame({ activity_id: 5, moves: blunderMoves }), { send }));
    fireEvent.click(screen.getByRole("button", { name: "Take back 9.a3" }));
    expect(send).toHaveBeenCalledWith({ type: "undo", activity_id: 5 });
  });

  it("hides both on Keep playing without sending anything", () => {
    const send = vi.fn(() => true);
    withActions(api(liveGame({ moves: blunderMoves }), { send }));
    fireEvent.click(screen.getByRole("button", { name: "Keep playing" }));
    expect(screen.queryByRole("button", { name: /Take back/ })).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("is absent when undo is not available", () => {
    const evaluating = liveGame({ phase: "evaluating", moves: blunderMoves, input_enabled: false });
    withActions(api(evaluating));
    expect(screen.queryByRole("button", { name: /Take back/ })).toBeNull();
  });

  it("is absent once the student has played on or when the last move was not a blunder", () => {
    const playedOn = [
      ...blunderMoves,
      move(19, { is_player: true, classification: "good" }),
      move(20),
    ];
    withActions(api(liveGame({ moves: playedOn })));
    expect(screen.queryByRole("button", { name: /Take back/ })).toBeNull();
    cleanup();
    const mistake = [move(1, { classification: "mistake" }), move(2)];
    withActions(api(liveGame({ moves: mistake })));
    expect(screen.queryByRole("button", { name: /Take back/ })).toBeNull();
  });

  it("renders under the latest coach message, not after the student's reply", () => {
    const items = [
      { type: "text" as const, key: "a", role: "assistant" as const, text: "Coach says" },
      { type: "text" as const, key: "b", role: "user" as const, text: "Student replies" },
    ];
    withActions(api(liveGame({ moves: blunderMoves }), { items }));
    const column = document.querySelector(".chat__column") as HTMLElement;
    const kinds = [...column.children].map((node) =>
      node.matches(".coach-actions") ? "actions" : node.textContent,
    );
    expect(kinds.slice(0, 3)).toEqual(["Coach says", "actions", "Student replies"]);
  });
});

describe("eval bar", () => {
  const view = (cp: number) => evalView([move(1, { eval_after_cp: cp })]);

  it("clamps the bar and the number to plus or minus 1000", () => {
    expect(view(4000)).toMatchObject({ fillPercent: 100, label: "+10.0" });
    expect(view(-4000)).toMatchObject({ fillPercent: 0, label: "\u221210.0" });
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

  it("scales the fill vertically from the bottom, so the student's share rises", () => {
    const moves = [move(1, { eval_after_cp: 500 })];
    render(<Play server={api(liveGame({ moves }))} createBoard={inertBoard} />);
    const fill = document.querySelector(".eval__fill") as HTMLElement;
    expect(fill.style.transform).toBe("scaleY(0.75)");
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

  it("starts the dialog at the server's current Elo and sends the value it shows", () => {
    const send = vi.fn(() => true);
    render(<Play server={api(null, { send, currentElo: 850 })} createBoard={inertBoard} />);
    fireEvent.click(screen.getByRole("button", { name: "New game" }));
    const dialog = screen.getByRole("dialog", { name: "New game" });
    expect((within(dialog).getByLabelText("Engine Elo") as HTMLInputElement).value).toBe("850");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start" }));
    expect(send).toHaveBeenCalledWith({ type: "new_game", color: "white", elo: 850 });
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

  it("explains an invalid Elo next to the field and clears the message when it is fixed", () => {
    render(<Play server={api(null)} createBoard={inertBoard} />);
    fireEvent.click(screen.getByRole("button", { name: "New game" }));
    const input = screen.getByLabelText("Engine Elo");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("false");
    for (const bad of ["99", "3191", "", "12.5"]) {
      fireEvent.change(input, { target: { value: bad } });
      const message = screen.getByRole("alert");
      expect(message.textContent).toBe("Enter a whole number from 100 to 3190.");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")).toBe(message.id);
    }
    fireEvent.change(input, { target: { value: "1500" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("false");
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

function trainingActivity(): TrainingActivity {
  return {
    kind: "training",
    activity_id: 11,
    orientation: "white",
    fen: START_FEN,
    turn: "white",
    last_move: null,
    legal_moves: [],
    input_enabled: true,
    pending: "none",
    mode: "puzzles",
    item: {
      kind: "puzzle",
      puzzle_id: "p1",
      motif: "fork",
      difficulty: "easy",
      fen: START_FEN,
      cursor: 0,
      reply_uci: null,
      position_in_queue: 1,
      queue_length: 5,
    },
    status: "prompt",
    served_at: "2026-03-01T00:00:00.000Z",
    expected: null,
    exploring: { fen: START_FEN, line_san: [], trail: [] },
    tries: 0,
    last_try: null,
    gave_up: false,
    solution_line: null,
    suggested_quality: null,
    summary: null,
  };
}

describe("play during training", () => {
  it("shows the unfinished live game read-only with the note and the button, and a drag sends no move", () => {
    const send = vi.fn(() => true);
    const game = liveGame({ moves: twoPlies });
    let drag: ((from: string, to: string) => void) | undefined;
    const board: BoardFactory = (_element, config) => {
      drag = config.events?.move as typeof drag;
      return { set: vi.fn(), destroy: vi.fn() } as never;
    };
    const goToPractice = vi.fn();
    render(
      <Play
        server={api(trainingActivity(), { send })}
        liveGame={game}
        onGoToPractice={goToPractice}
        createBoard={board}
      />,
    );
    expect(screen.getByText("A practice session is open")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go to Practice" }));
    expect(goToPractice).toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "Moves" })).toBeTruthy();
    expect(screen.getByTestId("board")).toBeTruthy();
    drag?.("e2", "e4");
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "move" }));
  });

  it("shows only the note and the button with no board when no live game is unfinished", () => {
    render(
      <Play
        server={api(trainingActivity())}
        liveGame={null}
        onGoToPractice={() => undefined}
        createBoard={inertBoard}
      />,
    );
    expect(screen.getByText("A practice session is open")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to Practice" })).toBeTruthy();
    expect(screen.queryByTestId("board")).toBeNull();
    expect(screen.queryByRole("list", { name: "Moves" })).toBeNull();
  });
});
