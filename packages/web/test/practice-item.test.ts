import type { TrainingActivity } from "@chess-coach/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PracticeColumn } from "../src/components/PracticeColumn.js";
import { trainingView } from "../src/state/practice.js";
import {
  headingOf,
  localBoard,
  moveRowsOf,
  outcomesOf,
  positionAfter,
  ratingsOf,
  signedCount,
  stateCardOf,
  variationText,
} from "../src/state/practice-item.js";
import { legalMovesOf, START_FEN } from "./fixtures.js";

// Black to move at move 31, as the prototype's puzzle.
const BLACK_START = "5rk1/5p1p/Qp4p1/7b/2K5/1P4P1/5P1P/8 b - - 0 31";

function puzzle(overrides: Partial<TrainingActivity> = {}): TrainingActivity {
  return {
    kind: "training",
    activity_id: 4,
    orientation: "white",
    fen: START_FEN,
    turn: "white",
    last_move: null,
    legal_moves: legalMovesOf(START_FEN),
    input_enabled: true,
    pending: "none",
    mode: "puzzles",
    item: {
      kind: "puzzle",
      puzzle_id: "f1",
      motif: "fork",
      difficulty: "easy",
      fen: START_FEN,
      cursor: 0,
      reply_uci: null,
      rating: 1400,
      position_in_queue: 3,
      queue_length: 10,
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
    hint_square: null,
    summary: null,
    moves: [],
    wrong_tries: [],
    queue_outcomes: [
      "solved",
      "failed",
      "current",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ],
    student_rating: 1353,
    rating_change: null,
    ...overrides,
  };
}

describe("headingOf", () => {
  it("counts the item and names only what the student already knows", () => {
    expect(headingOf(puzzle(), null)).toEqual({
      title: "Puzzle 3 of 10",
      tag: null,
      openingName: null,
    });
    expect(headingOf(puzzle({ status: "solved" }), null)).toEqual({
      title: "Puzzle 3 of 10",
      tag: "Fork",
      openingName: null,
    });
    expect(headingOf(puzzle(), "fork")).toEqual({
      title: "Puzzle 3 of 10",
      tag: "Fork",
      openingName: null,
    });
    expect(headingOf(puzzle(), "opening-italian").tag).toBe("Italian Opening");
    expect(headingOf(puzzle({ mode: "openings", orientation: "black" }), null).tag).toBe(
      "As Black",
    );
  });

  it("shows an opening drill's name when present and no name when null", () => {
    const renderColumn = (openingName: string | null) => {
      const training = puzzle({
        mode: "openings",
        item: { ...puzzle().item, opening_name: openingName } as TrainingActivity["item"],
      });
      return renderToStaticMarkup(
        createElement(PracticeColumn, {
          training,
          view: trainingView(training),
          actions: {
            showSolution() {},
            rate() {},
            next() {},
            end() {},
            hint() {},
            toggleScratch() {},
            takeBack() {},
            resetLine() {},
          },
          card: stateCardOf(training, trainingView(training), null, 0),
          elapsedMs: 0,
          scratchLine: null,
          shownPly: 0,
          engineStrip: null,
        }),
      );
    };
    expect(renderColumn("Italian Game")).toContain(
      'class="practice-item__opening-name">Italian Game</p>',
    );
    expect(renderColumn(null)).not.toContain("practice-item__opening-name");
  });
});

describe("moveRowsOf", () => {
  it("numbers the rows from the start position and opens a Black start with an ellipsis", () => {
    const rows = moveRowsOf(
      puzzle({
        item: { ...puzzle().item, fen: BLACK_START } as TrainingActivity["item"],
        status: "in_progress",
        moves: [
          { ply: 0, uci: "h5e2", san: "Be2+", by: "student" },
          { ply: 1, uci: "c4d4", san: "Kd4", by: "reply" },
        ],
        wrong_tries: [{ ply: 0, uci: "h5f3", san: "Bf3" }],
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.number).toBe(31);
    expect(rows[0]?.white).toBe("ellipsis");
    expect(rows[0]?.black).toMatchObject({ san: "Be2+", by: "student" });
    expect(rows[0]?.black?.wrongTries).toEqual([{ ply: 0, uci: "h5f3", san: "Bf3" }]);
    expect(rows[1]).toMatchObject({ number: 32, white: { san: "Kd4", by: "reply" } });
    expect(rows[1]?.black).toMatchObject({ by: "pending", ply: 2 });
  });

  it("holds the ply the student is on as an empty cell while the item is open", () => {
    const rows = moveRowsOf(puzzle({ wrong_tries: [{ ply: 0, uci: "e2e4", san: "e4" }] }));
    expect(rows).toEqual([
      {
        number: 1,
        white: { ply: 0, san: "", by: "pending", wrongTries: [{ ply: 0, uci: "e2e4", san: "e4" }] },
        black: null,
      },
    ]);
  });

  it("continues with the solution, dimmed, once the student gave up", () => {
    const rows = moveRowsOf(
      puzzle({
        status: "failed",
        gave_up: true,
        solution_line: ["e2e4", "e7e5"],
        moves: [],
      }),
    );
    expect(rows[0]?.white).toMatchObject({ san: "e4", by: "solution" });
    expect(rows[0]?.black).toMatchObject({ san: "e5", by: "solution" });
  });

  it("writes a wrong try as a variation under its ply", () => {
    expect(variationText(31, false, "Bf3", "h5f3")).toBe("31… Bf3 ✗");
    expect(variationText(24, true, null, "a1b1")).toBe("24. a1b1 ✗");
  });
});

describe("stateCardOf", () => {
  const cardOf = (training: TrainingActivity, scratch: string[] | null = null) =>
    stateCardOf(training, trainingView(training), scratch, 88_000);

  it("words each moment with the tone that colours it", () => {
    expect(cardOf(puzzle())).toEqual({
      tone: "neutral",
      title: "Your move",
      body: "White to play. Find the best move.",
    });
    expect(cardOf(puzzle({ hint_square: "e2" })).body).toContain("Look at the piece on e2.");
    expect(
      cardOf(puzzle({ tries: 1, last_try: { uci: "e2e3", san: "e3", correct: false } })),
    ).toEqual({ tone: "wrong", title: "Not that move", body: "e3. Try something else." });
    expect(cardOf(puzzle({ status: "in_progress" }))).toEqual({
      tone: "right",
      title: "Best move",
      body: "Keep going. Your move again.",
    });
  });

  it("sums the item up once it ended", () => {
    const solved = puzzle({
      status: "solved",
      tries: 1,
      moves: [
        { ply: 0, uci: "e2e4", san: "e4", by: "student" },
        { ply: 1, uci: "e7e5", san: "e5", by: "reply" },
        { ply: 2, uci: "g1f3", san: "Nf3", by: "student" },
      ],
    });
    expect(cardOf(solved)).toEqual({
      tone: "right",
      title: "Solved",
      body: "2 moves · 1 wrong try · 1:28",
    });
    const given = puzzle({ status: "failed", gave_up: true, expected: { uci: "e2e4", san: "e4" } });
    expect(cardOf(given)).toEqual({
      tone: "wrong",
      title: "Solution shown",
      body: "Expected e4 · 1:28",
    });
  });

  it("names the free line while exploring or analysing", () => {
    expect(cardOf(puzzle(), [])).toEqual({
      tone: "neutral",
      title: "Exploring",
      body: "Nothing yet. Moves here are not graded.",
    });
    expect(cardOf(puzzle({ status: "solved" }), ["e4", "e5"])).toEqual({
      tone: "neutral",
      title: "Analysing",
      body: "e4 e5",
    });
  });

  it("reports the finished queue", () => {
    expect(cardOf(puzzle({ status: "solved", summary: { solved: 7, failed: 3 } }))).toEqual({
      tone: "neutral",
      title: "Session finished",
      body: "7 solved, 3 failed",
    });
  });
});

describe("ratings and progress", () => {
  it("hides the puzzle rating until the item ends and signs the change", () => {
    const open = puzzle();
    expect(ratingsOf(open, trainingView(open))).toEqual({
      yours: 1353,
      change: null,
      puzzle: 1400,
      revealed: false,
    });
    const ended = puzzle({ status: "solved", rating_change: 8, student_rating: 1361 });
    expect(ratingsOf(ended, trainingView(ended))).toMatchObject({ change: 8, revealed: true });
    expect(signedCount(8)).toBe("+8");
    expect(signedCount(-16)).toBe("−16");
  });

  it("derives the outcomes from the position when the server sent none", () => {
    const bare = puzzle();
    bare.queue_outcomes = undefined;
    expect(outcomesOf(bare)).toEqual([
      "pending",
      "pending",
      "current",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });
});

describe("board positions", () => {
  it("steps back through the line", () => {
    const start = positionAfter(START_FEN, ["e2e4", "e7e5"], 0);
    expect(start).toEqual({ fen: START_FEN, lastMove: null });
    const after = positionAfter(START_FEN, ["e2e4", "e7e5"], 1);
    expect(after.fen.split(" ")[1]).toBe("b");
    expect(after.lastMove).toEqual({ from: "e2", to: "e4" });
  });

  it("runs a free line on the client with its legal moves and SAN", () => {
    const local = localBoard(START_FEN, ["e2e4", "e7e5"]);
    expect(local.sans).toEqual(["e4", "e5"]);
    expect(local.turn).toBe("white");
    expect(local.legalMoves.some((move) => move.from === "g1" && move.to === "f3")).toBe(true);
    expect(local.lastMove).toEqual({ from: "e7", to: "e5" });
  });
});
