import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CardOrigin, TrainingActivity } from "@chess-coach/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PracticeColumn } from "../src/components/PracticeColumn.js";
import { trainingView } from "../src/state/practice.js";
import {
  contextLineOf,
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
import { repertoireActivity } from "./practice-fixtures.js";

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
    suggested_grade: null,
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

// The same item in a queue drawn around the student's rating, which has no length.
function unbounded(overrides: Partial<TrainingActivity> = {}): TrainingActivity {
  const { queue_length: _length, ...item } = puzzle().item;
  return puzzle({ item: item as TrainingActivity["item"], ...overrides });
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

  it("counts the item without a total when the queue has no length", () => {
    expect(headingOf(unbounded(), null)).toEqual({
      title: "Puzzle 3",
      tag: null,
      openingName: null,
    });
    expect(headingOf(unbounded({ status: "solved" }), "fork").title).toBe("Puzzle 3");
    expect(contextLineOf(unbounded(), "fork")).toBe("Puzzle 3 \u00b7 Fork \u00b7 you play White");
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

  it("shows an Italian Opening run's opening name in the Practice column", () => {
    const training = puzzle({
      mode: "puzzles",
      run_motif: "opening-italian",
      item: {
        ...puzzle().item,
        opening_name: "Italian Game: Giuoco Piano",
      } as TrainingActivity["item"],
    });
    expect(headingOf(training, "opening-italian")).toEqual({
      title: "Puzzle 3 of 10",
      tag: "Italian Opening",
      openingName: "Italian Game: Giuoco Piano",
    });
    const html = renderToStaticMarkup(
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
    expect(html).toContain("Italian Opening");
    expect(html).toContain('class="practice-item__opening-name">Italian Game: Giuoco Piano</p>');
  });
});

// A review card at the third place of a queue of twenty; without an origin it is the item an older
// server sent.
function reviewCard(
  origin?: CardOrigin,
  overrides: Partial<TrainingActivity> = {},
): TrainingActivity {
  return puzzle({
    mode: "srs",
    item: {
      kind: "card",
      card_id: 7,
      exposure_id: "ex-1",
      prompt_fen: START_FEN,
      student_color: "white",
      rating_preview: { "1": 1 / 60, "2": 0.1, "3": 10 / 60, "4": 192 },
      position_in_queue: 3,
      queue_length: 20,
      ...(origin ? { origin } : {}),
    },
    ...overrides,
  });
}

describe("the heading of a review card", () => {
  const TAGS = [
    ["puzzle", "Missed puzzle"],
    ["game", "From your game"],
    ["coach", "Coach card"],
  ] as const;

  const renderColumn = (training: TrainingActivity): string =>
    renderToStaticMarkup(
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

  it.each(TAGS)("says in the tag what a card of origin %s was made from", (origin, tag) => {
    expect(headingOf(reviewCard(origin), null)).toEqual({
      title: "Card 3 of 20",
      tag,
      openingName: null,
    });
  });

  it.each(TAGS)("is drawn beside the title, in a puzzle's tag, for origin %s", (origin, tag) => {
    const title = '<h2 class="practice-item__title">Card 3 of 20</h2>';
    expect(renderColumn(reviewCard(origin))).toContain(
      `${title}<span class="practice-item__tag">${tag}</span>`,
    );
  });

  it("says it from the first move to the end of the item", () => {
    for (const status of ["prompt", "in_progress", "solved", "failed", "rated"] as const) {
      expect(headingOf(reviewCard("puzzle", { status }), null)).toMatchObject({
        title: "Card 3 of 20",
        tag: "Missed puzzle",
      });
    }
  });

  // A card that comes back inside the training lengthens the queue, and the title must not grow
  // with the origin on top of that.
  it("keeps the title to the card's place in the queue, whatever the origin", () => {
    const late = reviewCard("game");
    late.item = { ...late.item, position_in_queue: 22, queue_length: 35 };
    expect(headingOf(late, null)).toEqual({
      title: "Card 22 of 35",
      tag: "From your game",
      openingName: null,
    });
  });

  it("keeps the heading it had, with no tag, for a card that names no origin", () => {
    expect(headingOf(reviewCard(), null)).toEqual({
      title: "Card 3 of 20",
      tag: null,
      openingName: null,
    });
    const html = renderColumn(reviewCard());
    expect(html).toContain('<h2 class="practice-item__title">Card 3 of 20</h2>');
    expect(html).not.toContain("practice-item__tag");
  });

  it("leaves the line over the conversation as it was, with no origin in it", () => {
    for (const [origin] of TAGS) {
      expect(contextLineOf(reviewCard(origin), null)).toBe("Card 3 · you play White");
    }
    expect(contextLineOf(reviewCard(), null)).toBe("Card 3 · you play White");
    expect(contextLineOf(puzzle(), "fork")).toBe("Puzzle 3 · Fork · you play White");
  });

  it("is recorded with the card's note in the Practice column of the design check", () => {
    const check = readFileSync(join(import.meta.dirname, "../DESIGN-CHECK.md"), "utf8");
    // The paragraphs are wrapped, so a phrase may break across a line.
    const paragraph = check
      .split("\n\n")
      .map((text) => text.replace(/\s+/g, " "))
      .find(
        (text) =>
          text.startsWith("The Practice column was re-checked") && text.includes("review card"),
      );
    expect(paragraph).toBeDefined();
    for (const said of [
      "in the tag beside the title",
      "`Missed puzzle`",
      "`From your game`",
      "`Coach card`",
      "the card's explanation",
      "Why",
      "test/practice-item.test.ts",
      "M1 and M2",
    ]) {
      expect(paragraph).toContain(said);
    }
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

describe("the note of a position from the student's games", () => {
  const NOTE = { san: "Nf3", text: "Develops the knight toward the center and eyes the e5 pawn." };
  const cardOf = (training: TrainingActivity, scratch: string[] | null = null) =>
    stateCardOf(training, trainingView(training), scratch, 88_000);
  const found = (overrides: Partial<TrainingActivity> = {}) =>
    puzzle({ mode: "found", note: NOTE, ...overrides });
  const solved = (overrides: Partial<TrainingActivity> = {}) =>
    found({
      status: "solved",
      moves: [{ ply: 0, uci: "g1f3", san: "Nf3", by: "student" }],
      ...overrides,
    });
  const shown = (overrides: Partial<TrainingActivity> = {}) =>
    found({
      status: "failed",
      gave_up: true,
      expected: { uci: "g1f3", san: "Nf3" },
      ...overrides,
    });

  const render = (training: TrainingActivity): string =>
    renderToStaticMarkup(
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

  it("titles the note by its move and carries its text in the card of a solved item", () => {
    expect(cardOf(solved())).toEqual({
      tone: "right",
      title: "Solved",
      body: "1 move · 1:28",
      note: { title: "Why Nf3", body: NOTE.text },
    });
  });

  it("carries it in the card of an item whose solution was shown", () => {
    expect(cardOf(shown())).toEqual({
      tone: "wrong",
      title: "Solution shown",
      body: "Expected Nf3 · 1:28",
      note: { title: "Why Nf3", body: NOTE.text },
    });
  });

  it("names the note's own move, not the move the student played", () => {
    const withAlternative = solved({
      moves: [{ ply: 0, uci: "b1c3", san: "Nc3", by: "student" }],
    });
    expect(cardOf(withAlternative).note).toEqual({ title: "Why Nf3", body: NOTE.text });
  });

  it("draws no note when the position has none: the card is the one it was", () => {
    expect(cardOf(solved({ note: null }))).toEqual({
      tone: "right",
      title: "Solved",
      body: "1 move · 1:28",
    });
    expect(cardOf(shown({ note: null }))).toEqual({
      tone: "wrong",
      title: "Solution shown",
      body: "Expected Nf3 · 1:28",
    });
    expect(cardOf(solved({ note: undefined }))).not.toHaveProperty("note");
  });

  it("draws no note before the item has ended, though the state were to carry one", () => {
    for (const open of [
      found(),
      found({ status: "in_progress" }),
      found({ hint_square: "g1" }),
      found({ tries: 1, last_try: { uci: "d2d3", san: "d3", correct: false } }),
    ]) {
      expect(cardOf(open)).not.toHaveProperty("note");
    }
  });

  it("draws no note over the free analysis or on the finished queue's card", () => {
    expect(cardOf(solved(), ["e4", "e5"])).not.toHaveProperty("note");
    expect(cardOf(solved({ summary: { solved: 3, failed: 1 } }))).not.toHaveProperty("note");
  });

  it("renders Why and the move, then the note, in the column once the item ended", () => {
    for (const ended of [solved(), shown()]) {
      const html = render(ended);
      expect(html).toContain('class="state-card__note-title">Why Nf3</p>');
      expect(html).toContain(`class="state-card__note-body">${NOTE.text}</p>`);
    }
  });

  it("renders no such line when the note is null, and none while the item is open", () => {
    expect(render(solved({ note: null }))).not.toContain("state-card__note");
    expect(render(shown({ note: null }))).not.toContain("state-card__note");
    expect(render(found())).not.toContain("state-card__note");
    expect(render(found({ hint_square: "g1" }))).not.toContain("state-card__note");
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

describe("a queue without a length", () => {
  it("draws the outcomes the server sent, with no segment for an item to come", () => {
    const served = unbounded({ queue_outcomes: ["solved", "failed", "current"] });
    expect(outcomesOf(served)).toEqual(["solved", "failed", "current"]);
  });

  it("draws only the item on the board when the server sent no outcomes", () => {
    const bare = unbounded();
    bare.queue_outcomes = undefined;
    expect(outcomesOf(bare)).toEqual(["current"]);
  });

  it("never reads Finish, wherever the item stands", () => {
    for (const position of [1, 10, 11, 40]) {
      const training = unbounded({ status: "solved" });
      if (training.item.kind === "puzzle") training.item.position_in_queue = position;
      expect(trainingView(training).advanceLabel).toBe("Next");
    }
    const last = puzzle({ status: "solved" });
    if (last.item.kind === "puzzle") last.item.position_in_queue = 10;
    expect(trainingView(last).advanceLabel).toBe("Finish");
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

describe("the answered idea under a repertoire drill's card", () => {
  const renderColumn = (training: TrainingActivity): string => {
    const view = trainingView(training);
    return renderToStaticMarkup(
      createElement(PracticeColumn, {
        training,
        view,
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
        card: stateCardOf(training, view, null, 0),
        elapsedMs: 0,
        scratchLine: null,
        shownPly: 0,
        engineStrip: null,
      }),
    );
  };

  it("shows Why with the move number and idea after an answer, and nothing before", () => {
    expect(renderColumn(repertoireActivity({}))).not.toContain("why-line");
    const html = renderColumn(
      repertoireActivity({ drill: { answered: { san: "c3", idea: "Prepare d4." } } }),
    );
    expect(html).toContain("why-line");
    expect(html).toContain("Why 4.c3");
    expect(html).toContain("Prepare d4.");
  });

  it("draws nothing when the answered move stores no idea", () => {
    expect(
      renderColumn(repertoireActivity({ drill: { answered: { san: "c3", idea: null } } })),
    ).not.toContain("why-line");
  });
});
