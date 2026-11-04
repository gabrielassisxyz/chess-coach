import { Chessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { Config } from "@lichess-org/chessground/config";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Board, type BoardFactory } from "../src/components/Board.js";
import { legalMovesOf, liveGame } from "./fixtures.js";

const PROMOTION_FEN = "8/P6k/8/8/8/8/8/K7 w - - 0 1";

// Counts what the component creates and destroys, and keeps the config it handed over.
class RecordingBoard {
  created: Config[] = [];
  destroyed = 0;
  sets: Config[] = [];
  readonly factory: BoardFactory = (_element, config) => {
    this.created.push(config);
    return {
      set: (next: Config) => this.sets.push(next),
      destroy: () => {
        this.destroyed += 1;
      },
    } as unknown as Api;
  };
  get live(): number {
    return this.created.length - this.destroyed;
  }
}

afterEach(cleanup);

describe("Board lifecycle", () => {
  it("keeps exactly one instance and one move callback after a Strict Mode double mount", () => {
    const recorder = new RecordingBoard();
    render(
      <StrictMode>
        <Board activity={liveGame()} onMove={vi.fn()} createBoard={recorder.factory} />
      </StrictMode>,
    );
    expect(recorder.live).toBe(1);
    const registered = recorder.created.slice(recorder.destroyed);
    expect(registered).toHaveLength(1);
    expect(registered.filter((config) => config.events?.move)).toHaveLength(1);
  });

  it("draws one real chessground board under Strict Mode", () => {
    const { container } = render(
      <StrictMode>
        <Board activity={liveGame()} onMove={vi.fn()} />
      </StrictMode>,
    );
    expect(container.querySelectorAll(".cg-wrap")).toHaveLength(1);
    expect(container.querySelectorAll("cg-board")).toHaveLength(1);
  });

  it("updates through set() instead of recreating the board", () => {
    const recorder = new RecordingBoard();
    const { rerender } = render(
      <Board activity={liveGame()} onMove={vi.fn()} createBoard={recorder.factory} />,
    );
    const next = liveGame({ activity_id: 2, input_enabled: false, legal_moves: [] });
    rerender(<Board activity={next} onMove={vi.fn()} createBoard={recorder.factory} />);
    expect(recorder.created).toHaveLength(1);
    expect(recorder.sets.at(-1)?.movable?.color).toBeUndefined();
    expect(recorder.sets.at(-1)?.movable?.dests?.size).toBe(0);
  });

  it("restores the position when the server refused a move or a promotion was cancelled", () => {
    const recorder = new RecordingBoard();
    const promotion = liveGame({ fen: PROMOTION_FEN, legal_moves: legalMovesOf(PROMOTION_FEN) });
    const props = { activity: promotion, onMove: vi.fn(), createBoard: recorder.factory };
    const { rerender } = render(<Board {...props} syncToken={0} />);
    const before = recorder.sets.length;
    rerender(<Board {...props} syncToken={1} />);
    expect(recorder.sets).toHaveLength(before + 1);
    act(() => recorder.created[0]?.events?.move?.("a7", "a8"));
    expect(screen.getByTestId("promotion-chooser")).toBeTruthy();
    const beforeCancel = recorder.sets.length;
    fireEvent.keyDown(document, { key: "Escape" });
    expect(recorder.sets).toHaveLength(beforeCancel + 1);
  });

  it("destroys the instance on unmount", () => {
    const recorder = new RecordingBoard();
    const { unmount } = render(
      <Board activity={liveGame()} onMove={vi.fn()} createBoard={recorder.factory} />,
    );
    unmount();
    expect(recorder.live).toBe(0);
  });
});

describe("Board configuration", () => {
  it("maps legal_moves to dests and gives the student the movable colour", () => {
    const recorder = new RecordingBoard();
    render(<Board activity={liveGame()} onMove={vi.fn()} createBoard={recorder.factory} />);
    const config = recorder.created[0] as Config;
    expect(config.movable?.free).toBe(false);
    expect(config.movable?.color).toBe("white");
    expect(config.movable?.dests?.get("e2")).toEqual(["e3", "e4"]);
    expect(config.movable?.dests?.get("g1")).toEqual(["f3", "h3"]);
    expect(config.draggable?.enabled).toBe(false);
    expect(config.premovable?.enabled).toBe(false);
    expect(config.selectable?.enabled).toBe(true);
  });

  it("withholds the movable colour while input is disabled", () => {
    const recorder = new RecordingBoard();
    render(
      <Board
        activity={liveGame({ input_enabled: false, legal_moves: [] })}
        onMove={vi.fn()}
        createBoard={recorder.factory}
      />,
    );
    expect(recorder.created[0]?.movable?.color).toBeUndefined();
  });

  it("highlights the last move and a king in check", () => {
    const recorder = new RecordingBoard();
    render(
      <Board
        activity={liveGame({
          fen: "rnb1kbnr/pppp1ppp/8/4p3/7q/5P2/PPPPP1PP/RNBQKBNR w KQkq - 1 3",
          last_move: { from: "d8", to: "h4" },
        })}
        onMove={vi.fn()}
        createBoard={recorder.factory}
      />,
    );
    const config = recorder.created[0] as Config;
    expect(config.lastMove).toEqual(["d8", "h4"]);
    expect(config.check).toBe("white");
  });
});

// Chessground measures the board with getBoundingClientRect, which a DOM without layout reports
// as zero; a fixed square lets a click land on a real square.
const BOARD_PX = 800;
const realRect = Element.prototype.getBoundingClientRect;

function trustingFactory(): BoardFactory {
  return (element, config) => Chessground(element, { ...config, trustAllEvents: true });
}

function click(board: HTMLElement, square: string, orientation: "white" | "black" = "white") {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const column = orientation === "white" ? file : 7 - file;
  const row = orientation === "white" ? 7 - rank : rank;
  const cell = BOARD_PX / 8;
  const point = { clientX: (column + 0.5) * cell, clientY: (row + 0.5) * cell, button: 0 };
  act(() => {
    fireEvent.mouseDown(board, point);
    fireEvent.mouseUp(board, point);
  });
}

// Chessground reports a user move through a 1ms timer, so a test waits for it to fire; an
// assertion that nothing was sent is only meaningful after that window has passed.
const settle = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

describe("Board click-to-move", () => {
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const size = this.tagName === "CG-BOARD" ? BOARD_PX : 0;
      return new DOMRect(0, 0, size, size);
    };
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
  });

  function mount(activity = liveGame()) {
    const onMove = vi.fn();
    const { container } = render(
      <Board activity={activity} onMove={onMove} createBoard={trustingFactory()} />,
    );
    return { onMove, board: container.querySelector("cg-board") as HTMLElement };
  }

  it("sends exactly one move for a piece click then a legal square click", async () => {
    const { onMove, board } = mount();
    click(board, "e2");
    click(board, "e4");
    await settle();
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith("e2", "e4");
  });

  it("sends nothing for an illegal destination", async () => {
    const { onMove, board } = mount();
    click(board, "e2");
    click(board, "e5");
    await settle();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("sends nothing while input is disabled", async () => {
    const { onMove, board } = mount(liveGame({ input_enabled: false, legal_moves: [] }));
    click(board, "e2");
    click(board, "e4");
    await settle();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("opens the chooser for a promotion and sends the chosen piece, never a default", async () => {
    const { onMove, board } = mount(
      liveGame({ fen: PROMOTION_FEN, legal_moves: legalMovesOf(PROMOTION_FEN) }),
    );
    click(board, "a7");
    click(board, "a8");
    await settle();
    expect(onMove).not.toHaveBeenCalled();
    expect(screen.getByTestId("promotion-chooser")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Promote to/ })).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Promote to knight" }));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith("a7", "a8", "n");
    expect(screen.queryByTestId("promotion-chooser")).toBeNull();
  });

  it("cancels a promotion with Escape without sending anything", async () => {
    const { onMove, board } = mount(
      liveGame({ fen: PROMOTION_FEN, legal_moves: legalMovesOf(PROMOTION_FEN) }),
    );
    click(board, "a7");
    click(board, "a8");
    await settle();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onMove).not.toHaveBeenCalled();
    expect(screen.queryByTestId("promotion-chooser")).toBeNull();
  });
});
