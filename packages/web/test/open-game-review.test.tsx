import type { GameDetail, GameRepertoireReview } from "@chess-coach/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Chess } from "chess.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardFactory } from "../src/components/Board.js";
import { OpenGame } from "../src/components/OpenGame.js";
import { COACH_GAME_SOURCE, START_FEN } from "./fixtures.js";
import { serverApi } from "./server-api.js";

const LONDON_SANS = [
  "d4",
  "d5",
  "Bf4",
  "Nf6",
  "e3",
  "e6",
  "Nf3",
  "c5",
  "Nbd2",
  "Nc6",
  "h3",
  "Be7",
  "c3",
  "O-O",
];

function buildGame(
  overrides: Partial<GameDetail> & { id?: number; sans?: readonly string[] } = {},
): GameDetail {
  const { sans = LONDON_SANS, ...rest } = overrides;
  const chess = new Chess();
  const color = rest.player_color ?? "white";
  const moves = sans.map((san, index) => {
    const played = chess.move(san);
    const isPlayer = (index % 2 === 0) === (color === "white");
    return {
      ply: index + 1,
      san: played.san,
      uci: `${played.from}${played.to}${played.promotion ?? ""}`,
      is_player: isPlayer,
      eval_before_cp: null,
      eval_after_cp: null,
      cp_loss: null,
      classification: null,
      best_move_san: null,
      fen_after: chess.fen(),
    };
  });
  return {
    ...COACH_GAME_SOURCE,
    id: 11,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T01:00:00.000Z",
    player_color: color,
    target_elo: 1200,
    result: "1-0",
    termination: "resign",
    initial_fen: START_FEN,
    moves,
    ...rest,
  };
}

function boardRecorder(): { factory: BoardFactory; fens: string[] } {
  const fens: string[] = [];
  const factory: BoardFactory = (_element, config) => {
    if (config.fen) fens.push(config.fen);
    return {
      set: (next: { fen?: string }) => {
        if (next.fen) fens.push(next.fen);
      },
      destroy: vi.fn(),
    } as never;
  };
  return { factory, fens };
}

afterEach(cleanup);

describe("OpenGame repertoire review strip", () => {
  it("draws no strip when repertoire_review is null or absent", () => {
    const { factory } = boardRecorder();
    const { rerender } = render(
      <OpenGame
        server={serverApi()}
        game={buildGame({ repertoire_review: null })}
        summary={undefined}
        createBoard={factory}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("repertoire-review")).toBeNull();

    const withoutField = buildGame();
    delete withoutField.repertoire_review;
    rerender(
      <OpenGame
        server={serverApi()}
        game={withoutField}
        summary={undefined}
        createBoard={factory}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("repertoire-review")).toBeNull();
  });

  it("shows the unit name and move count for an in_book game", () => {
    const { factory } = boardRecorder();
    const review: GameRepertoireReview = {
      repertoire_id: 3,
      group_name: "London System",
      variation_name: "Main lines",
      outcome: "in_book",
      followed_plies: 14,
      left: null,
    };
    const { rerender } = render(
      <OpenGame
        server={serverApi()}
        game={buildGame({ repertoire_review: review })}
        summary={undefined}
        createBoard={factory}
        onClose={vi.fn()}
      />,
    );
    const strip = screen.getByTestId("repertoire-review");
    expect(within(strip).getByText("London System · Main lines")).toBeTruthy();
    expect(within(strip).getByText("In your line for the first 7 moves.")).toBeTruthy();
    expect(within(strip).queryAllByRole("button")).toEqual([]);

    rerender(
      <OpenGame
        server={serverApi()}
        game={buildGame({
          id: 12,
          repertoire_review: { ...review, followed_plies: 2 },
        })}
        summary={undefined}
        createBoard={factory}
        onClose={vi.fn()}
      />,
    );
    expect(
      within(screen.getByTestId("repertoire-review")).getByText(
        "In your line for the first 1 move.",
      ),
    ).toBeTruthy();
  });

  it("hides the student's line move until requested, reveals it with its note, jumps to the ply, and resets on another game", () => {
    const { factory, fens } = boardRecorder();
    const londonGame = buildGame({
      id: 21,
      repertoire_review: {
        repertoire_id: 5,
        group_name: "London System",
        variation_name: "Main lines",
        outcome: "departed",
        followed_plies: 12,
        left: {
          ply: 13,
          by: "student",
          played_san: "c3",
          line_san: "Bd3",
          line_note: "Develops the bishop before locking the center.",
          stored_replies: [],
        },
      },
    });
    const { rerender } = render(
      <OpenGame
        server={serverApi()}
        game={londonGame}
        summary={undefined}
        createBoard={factory}
        onClose={vi.fn()}
      />,
    );

    const strip = screen.getByTestId("repertoire-review");
    expect(within(strip).getByText("London System · Main lines")).toBeTruthy();
    expect(within(strip).getByText("You left your line at move 7.")).toBeTruthy();
    expect(strip.textContent).not.toContain("Bd3");
    expect(strip.textContent).not.toContain("Develops the bishop");

    fireEvent.click(within(strip).getByRole("button", { name: "Go to move 7" }));
    expect(screen.getByTestId("ply-13").getAttribute("aria-current")).toBe("true");
    expect(fens.at(-1)).toBe(londonGame.moves[12]?.fen_after);

    const showButton = within(strip).getByRole("button", { name: "Show my line's move" });
    fireEvent.click(showButton);
    expect(within(strip).queryByRole("button", { name: "Show my line's move" })).toBeNull();
    expect(within(strip).getByText("Your line plays 7.Bd3")).toBeTruthy();
    expect(within(strip).getByText("Develops the bishop before locking the center.")).toBeTruthy();

    // Opening another game hides the line's move again.
    const nextGame = buildGame({
      id: 22,
      player_color: "black",
      repertoire_review: {
        repertoire_id: 6,
        group_name: "Caro-Kann Defense",
        variation_name: "Classical",
        outcome: "departed",
        followed_plies: 5,
        left: {
          ply: 6,
          by: "student",
          played_san: "e6",
          line_san: "Bf5",
          line_note: null,
          stored_replies: [],
        },
      },
    });
    rerender(
      <OpenGame
        server={serverApi()}
        game={nextGame}
        summary={undefined}
        createBoard={factory}
        onClose={vi.fn()}
      />,
    );
    const nextStrip = screen.getByTestId("repertoire-review");
    expect(within(nextStrip).getByText("Caro-Kann Defense · Classical")).toBeTruthy();
    expect(within(nextStrip).getByText("You left your line at move 3.")).toBeTruthy();
    expect(nextStrip.textContent).not.toContain("Bf5");
    const nextShow = within(nextStrip).getByRole("button", { name: "Show my line's move" });
    fireEvent.click(nextShow);
    expect(within(nextStrip).getByText("Your line plays 3...Bf5")).toBeTruthy();
  });

  it("shows opponent departure for Black and White opponents, stored replies or empty message, and jumps to the ply", () => {
    const { factory, fens } = boardRecorder();
    const whiteGame = buildGame({
      id: 31,
      player_color: "white",
      repertoire_review: {
        repertoire_id: 8,
        group_name: "Italian Game",
        variation_name: "Classical Variation (4.c3)",
        outcome: "reply_not_stored",
        followed_plies: 7,
        left: {
          ply: 8,
          by: "opponent",
          played_san: "c5",
          line_san: null,
          line_note: null,
          stored_replies: ["Bc5", "Nf6"],
        },
      },
    });
    const { rerender } = render(
      <OpenGame
        server={serverApi()}
        game={whiteGame}
        summary={undefined}
        createBoard={factory}
        onClose={vi.fn()}
      />,
    );

    const strip = screen.getByTestId("repertoire-review");
    expect(within(strip).getByText("Italian Game · Classical Variation (4.c3)")).toBeTruthy();
    expect(
      within(strip).getByText("Your opponent left your line at move 4 with 4...c5."),
    ).toBeTruthy();
    expect(within(strip).getByText("Your line answers 4...Bc5, 4...Nf6.")).toBeTruthy();
    fireEvent.click(within(strip).getByRole("button", { name: "Go to move 4" }));
    expect(screen.getByTestId("ply-8").getAttribute("aria-current")).toBe("true");
    expect(fens.at(-1)).toBe(whiteGame.moves[7]?.fen_after);

    const blackGame = buildGame({
      id: 32,
      player_color: "black",
      repertoire_review: {
        repertoire_id: 9,
        group_name: "Caro-Kann Defense",
        variation_name: "Advance",
        outcome: "reply_not_stored",
        followed_plies: 4,
        left: {
          ply: 5,
          by: "opponent",
          played_san: "e3",
          line_san: null,
          line_note: null,
          stored_replies: ["Nc3", "e5"],
        },
      },
    });
    rerender(
      <OpenGame
        server={serverApi()}
        game={blackGame}
        summary={undefined}
        createBoard={factory}
        onClose={vi.fn()}
      />,
    );
    const blackStrip = screen.getByTestId("repertoire-review");
    expect(
      within(blackStrip).getByText("Your opponent left your line at move 3 with 3.e3."),
    ).toBeTruthy();
    expect(within(blackStrip).getByText("Your line answers 3.Nc3, 3.e5.")).toBeTruthy();
    fireEvent.click(within(blackStrip).getByRole("button", { name: "Go to move 3" }));
    expect(screen.getByTestId("ply-5").getAttribute("aria-current")).toBe("true");
    expect(fens.at(-1)).toBe(blackGame.moves[4]?.fen_after);

    const emptyRepliesGame = buildGame({
      id: 33,
      player_color: "white",
      repertoire_review: {
        repertoire_id: 8,
        group_name: "Italian Game",
        variation_name: "Classical Variation (4.c3)",
        outcome: "reply_added",
        followed_plies: 7,
        left: {
          ply: 8,
          by: "opponent",
          played_san: "c5",
          line_san: null,
          line_note: null,
          stored_replies: [],
        },
      },
    });
    rerender(
      <OpenGame
        server={serverApi()}
        game={emptyRepliesGame}
        summary={undefined}
        createBoard={factory}
        onClose={vi.fn()}
      />,
    );
    const emptyStrip = screen.getByTestId("repertoire-review");
    expect(
      within(emptyStrip).getByText("Your opponent left your line at move 4 with 4...c5."),
    ).toBeTruthy();
    expect(within(emptyStrip).getByText("Your line has no reply stored here.")).toBeTruthy();
  });
});
