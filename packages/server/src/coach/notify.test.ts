import { describe, expect, it } from "vitest";
import type {
  DifficultyChangeNotification,
  GameEndNotification,
  NotificationContent,
  PlyQuestionNotification,
  TurnNotification,
} from "../game/notifications.js";
import {
  type PuzzleResultNotification,
  renderNotifications,
  renderPuzzleResult,
  renderSrsAnswer,
  renderTrainingSummary,
  type SrsAnswerNotification,
  type TrainingSummaryNotification,
} from "./notify.js";

const FEN = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

function turn(ply: number, overrides: Partial<TurnNotification> = {}): TurnNotification {
  return {
    type: "turn",
    game_id: 1,
    ply,
    move_number: Math.ceil(ply / 2),
    player_san: "Nf3",
    player_uci: "g1f3",
    cp_loss: 10,
    classification: "great",
    best_san: "d4",
    engine_reply_san: "Nc6",
    fen: FEN,
    ...overrides,
  };
}

const end: GameEndNotification = {
  type: "game_end",
  game_id: 1,
  result: "0-1",
  termination: "resign",
  player_color: "white",
  fen: FEN,
  costliest_moves: [
    {
      ply: 3,
      san: "Nf3",
      cp_loss: 200,
      classification: "mistake",
      best_san: "d4",
      fen_before: "fen-before-3",
      card_id: 11,
    },
    {
      ply: 5,
      san: "Bc4",
      cp_loss: 200,
      classification: "mistake",
      best_san: null,
      fen_before: "fen-before-5",
      card_id: null,
    },
  ],
  cards: { created: 1, skipped: 0 },
};

describe("renderNotifications", () => {
  it("renders one row in full with move label, grade, best move, reply and position", () => {
    const text = renderNotifications([turn(3, { cp_loss: 320, classification: "blunder" })]);
    expect(text).toContain("The student played 2. Nf3 (blunder, cp loss 320; best was d4).");
    expect(text).toContain("The engine replied 2... Nc6.");
    expect(text).toContain(`Position now (FEN): ${FEN}`);
    expect(text).not.toContain("Several updates");
  });

  it("says so when the move ended the game", () => {
    const text = renderNotifications([turn(3, { engine_reply_san: null })]);
    expect(text).toContain("no reply");
  });

  it("folds two rows: the current position, the earlier notable move, the last one in full", () => {
    const text = renderNotifications([
      turn(1, { player_san: "e4", cp_loss: 150, classification: "inaccuracy", best_san: "d4" }),
      turn(3, { cp_loss: 5 }),
    ]);
    expect(text).toContain("Several updates arrived while you were busy (2 in all).");
    expect(text).toContain(`Current position after move 2 (FEN): ${FEN}`);
    expect(text).toContain("- 1. e4 (inaccuracy, cp loss 150; best was d4)");
    expect(text).toContain("The latest move in full:\nThe student played 2. Nf3");
    expect(text.indexOf("Current position")).toBeLessThan(text.indexOf("Earlier moves"));
    expect(text.indexOf("Earlier moves")).toBeLessThan(text.indexOf("The latest move"));
  });

  it("lists only the earlier moves at or above 81 cp among five", () => {
    const text = renderNotifications([
      turn(1, { player_san: "a3", cp_loss: 80 }),
      turn(3, { player_san: "b3", cp_loss: 81, classification: "inaccuracy" }),
      turn(5, { player_san: "c3", cp_loss: 400, classification: "blunder" }),
      turn(7, { player_san: "h3", cp_loss: 0, classification: "best" }),
      turn(9, { player_san: "Nf3", cp_loss: 500, classification: "blunder" }),
    ]);
    expect(text).toContain("(5 in all)");
    expect(text).toContain("- 2. b3 (inaccuracy, cp loss 81");
    expect(text).toContain("- 3. c3 (blunder, cp loss 400");
    expect(text).not.toContain("1. a3");
    expect(text).not.toContain("4. h3");
    expect(text).toContain("The student played 5. Nf3 (blunder, cp loss 500");
  });

  it("states that nothing earlier was notable when every cp loss is under 81", () => {
    const rows = [1, 3, 5, 7, 9].map((ply) => turn(ply, { cp_loss: 80 }));
    const text = renderNotifications(rows);
    expect(text).toContain("No earlier move lost 81 cp or more.");
    expect(text).not.toContain("Earlier moves with");
    expect(text).toContain("The latest move in full:");
  });

  it("renders a resignation alone with the costliest moves in order", () => {
    const text = renderNotifications([end]);
    expect(text).toContain("The game is over: 0-1 by resignation. The student played white.");
    expect(text).toContain("- 2. Nf3 (mistake, cp loss 200; best was d4)");
    expect(text).toContain("- 3. Bc4 (mistake, cp loss 200; no better move was found)");
  });

  it("appends the end of the game after the last move when they arrive together", () => {
    const items: NotificationContent[] = [turn(1), end];
    const text = renderNotifications(items);
    expect(text).toContain("The latest move in full:");
    expect(text.indexOf("The latest move")).toBeLessThan(text.indexOf("The game is over"));
    expect(text).not.toContain("No earlier move");
  });
});

describe("game end walk-through", () => {
  it("names each move with its position before and its card id, and forbids a second batch", () => {
    const text = renderNotifications([end]);
    expect(text).toContain("position before (FEN): fen-before-3; card id 11");
    expect(text).toContain("position before (FEN): fen-before-5; no card");
    expect(text).toContain("(1 new, 0 already existed)");
    expect(text).toContain("do not call create_srs_cards");
    expect(text).toContain("show_position");
    expect(text).toContain("explain_card");
  });

  it("gives no walk-through when no student move was graded", () => {
    const text = renderNotifications([{ ...end, costliest_moves: [] }]);
    expect(text).not.toContain("show_position");
  });
});

describe("ply question", () => {
  const question: PlyQuestionNotification = {
    type: "ply_question",
    game_id: 7,
    ply: 12,
    san: "Qxb7",
    is_player: true,
    fen_before: FEN,
    cp_loss: 310,
    classification: "blunder",
    best_san: "Qd2",
  };

  it("renders the stored position, move and grade, and asks for the board", () => {
    const text = renderNotifications([question]);
    expect(text).toContain("game 7 and asks about 6... Qxb7, played by the student");
    expect(text).toContain("blunder, cp loss 310; best was Qd2");
    expect(text).toContain(`Position before the move (FEN): ${FEN}`);
    expect(text).toContain("show_position");
  });

  it("says an engine move was not graded", () => {
    const text = renderNotifications([
      { ...question, is_player: false, cp_loss: null, classification: null, best_san: null },
    ]);
    expect(text).toContain("played by the engine (this move was not graded)");
  });

  it("is kept when it arrives together with a turn", () => {
    const text = renderNotifications([turn(1), question]);
    expect(text).toContain("The latest move in full:");
    expect(text).toContain("asks about 6... Qxb7");
  });
});

describe("renderSrsAnswer", () => {
  const base: SrsAnswerNotification = {
    type: "srs_answer",
    card_id: 7,
    prompt_fen: FEN,
    answered_uci: "g1f3",
    answered_san: "Nf3",
    expected_uci: "d2d4",
    expected_san: "d4",
    correct: false,
  };

  it("tells the coach about a miss with both moves", () => {
    expect(renderSrsAnswer(base)).toBe(
      `The student missed review card 7: they played Nf3 and the expected move was d4.\nPosition (FEN): ${FEN}\nPractice notification: follow During Practice.`,
    );
  });

  it("reports a correct answer without naming an expected move", () => {
    expect(renderSrsAnswer({ ...base, correct: true, answered_san: "d4" })).toBe(
      `The student answered review card 7 correctly with d4.\nPosition (FEN): ${FEN}\nPractice notification: follow During Practice.`,
    );
  });

  it("falls back to UCI when a move has no SAN", () => {
    expect(renderSrsAnswer({ ...base, answered_san: null, expected_san: null })).toContain(
      "they played g1f3 and the expected move was d2d4",
    );
  });
});

describe("the student's reasoning in a training result", () => {
  const reasoning = {
    messages: ["I want to look at the knight", "maybe the bishop instead"],
    explored: [
      { at_ms: 12_000, kind: "move" as const, line: "1... Nf6 Bxf7+ Kxf7" },
      { at_ms: 15_400, kind: "move" as const, line: "1... Nf6" },
      { at_ms: 20_000, kind: "undo" as const, line: null },
      { at_ms: 22_000, kind: "move" as const, line: "1... Nc6" },
      { at_ms: 25_000, kind: "reset" as const, line: null },
    ],
  };
  const miss: SrsAnswerNotification = {
    type: "srs_answer",
    card_id: 7,
    prompt_fen: FEN,
    answered_uci: "g1f3",
    answered_san: "Nf3",
    expected_uci: "d2d4",
    expected_san: "d4",
    correct: false,
  };

  it("lists the messages, one line per explored event and the verdict on a review card", () => {
    expect(renderSrsAnswer({ ...miss, reasoning })).toBe(
      [
        `The student missed review card 7: they played Nf3 and the expected move was d4.`,
        `Position (FEN): ${FEN}`,
        "What the student wrote:",
        "- I want to look at the knight",
        "- maybe the bishop instead",
        "Explored:",
        "+12s  1... Nf6 Bxf7+ Kxf7",
        "+15s  1... Nf6",
        "+20s  undo",
        "+22s  1... Nc6",
        "+25s  reset",
        "Answer: Nf3 (wrong)",
        "Practice notification: follow During Practice.",
      ].join("\n"),
    );
  });

  it("says nothing was written or explored instead of leaving the block out", () => {
    const text = renderSrsAnswer({
      ...miss,
      correct: true,
      reasoning: { messages: [], explored: [] },
    });
    expect(text).toContain("What the student wrote: nothing");
    expect(text).toContain("Explored: nothing");
    expect(text).toContain("Answer: Nf3 (correct)");
  });

  it("adds the same blocks to a puzzle result and leaves old rows unchanged", () => {
    const puzzle: PuzzleResultNotification = {
      type: "puzzle_result",
      puzzle_id: "f1",
      motif: "fork",
      difficulty: "easy",
      fen: FEN,
      solved: false,
      answered_uci: ["g1f3"],
      expected_uci: "d2d4",
      expected_san: "d4",
    };
    const plain = renderNotifications([puzzle]);
    expect(plain).not.toContain("What the student wrote");
    const text = renderNotifications([{ ...puzzle, reasoning }]);
    expect(text).toContain("- maybe the bishop instead");
    expect(text).toContain("+20s  undo");
    expect(text).toContain("Answer: g1f3 (wrong)");
  });
});

describe("the tries in a training result", () => {
  const tries = [
    { at_ms: 4_000, uci: "g1f3", san: "Nf3", correct: false },
    { at_ms: 9_600, uci: "c2c4", san: null, correct: false },
    { at_ms: 15_000, uci: "d2d4", san: "d4", correct: true },
  ];
  const card: SrsAnswerNotification = {
    type: "srs_answer",
    card_id: 7,
    prompt_fen: FEN,
    answered_uci: "g1f3",
    answered_san: "Nf3",
    expected_uci: "d2d4",
    expected_san: "d4",
    correct: false,
  };

  it("lists every try with its offset and correctness, and that no solution was shown", () => {
    const text = renderSrsAnswer({
      ...card,
      reasoning: { messages: [], explored: [], tries, gave_up: false },
    });
    expect(text).toBe(
      [
        "The student missed review card 7 on the first try with Nf3, then found d4.",
        `Position (FEN): ${FEN}`,
        "What the student wrote: nothing",
        "Explored: nothing",
        "Tries:",
        "+4s  Nf3 (wrong)",
        "+10s  c2c4 (wrong)",
        "+15s  d4 (right)",
        "Solution shown: no",
        "Practice notification: follow During Practice.",
      ].join("\n"),
    );
  });

  it("says a card was given up, and that the solution was shown", () => {
    const text = renderSrsAnswer({
      ...card,
      answered_uci: "0000",
      answered_san: null,
      reasoning: { messages: [], explored: [], tries: [], gave_up: true },
    });
    expect(text).toContain("The student gave up on review card 7 and was shown d4.");
    expect(text).toContain("Tries: none\nSolution shown: yes");
    expect(text).not.toContain("0000");
  });

  it("says a puzzle was solved after wrong tries, or given up, with its position", () => {
    const puzzle: PuzzleResultNotification = {
      type: "puzzle_result",
      puzzle_id: "f1",
      motif: "fork",
      difficulty: "easy",
      fen: FEN,
      solved: true,
      answered_uci: ["g1f3", "c2c4", "d2d4"],
      expected_uci: null,
      expected_san: null,
      first_try: false,
      tries: 2,
      gave_up: false,
      reasoning: { messages: [], explored: [], tries, gave_up: false },
    };
    const retried = renderNotifications([puzzle]);
    expect(retried).toContain("The student solved the fork puzzle f1 (easy) after 2 wrong tries.");
    expect(retried).toContain(`Position (FEN): ${FEN}`);
    const gaveUp = renderNotifications([
      {
        ...puzzle,
        solved: false,
        gave_up: true,
        expected_uci: "d2d4",
        expected_san: "d4",
        reasoning: { messages: [], explored: [], tries: tries.slice(0, 1), gave_up: true },
      },
    ]);
    expect(gaveUp).toContain(
      "The student gave up on the fork puzzle f1 (easy); the expected move was d4.",
    );
    expect(gaveUp).toContain("+4s  Nf3 (wrong)\nSolution shown: yes");
  });
});

describe("practice notification pointer", () => {
  const card: SrsAnswerNotification = {
    type: "srs_answer",
    card_id: 7,
    prompt_fen: FEN,
    answered_uci: "g1f3",
    answered_san: "Nf3",
    expected_uci: "d2d4",
    expected_san: "d4",
    correct: false,
  };
  const puzzle: PuzzleResultNotification = {
    type: "puzzle_result",
    puzzle_id: "f1",
    motif: "fork",
    difficulty: "easy",
    fen: FEN,
    solved: true,
    answered_uci: ["d2d4"],
    expected_uci: null,
    expected_san: null,
    first_try: true,
    tries: 0,
    gave_up: false,
  };

  it.each([
    ["a review-card answer", renderSrsAnswer(card)],
    ["a puzzle result", renderPuzzleResult(puzzle)],
    [
      "a training summary",
      renderTrainingSummary({ type: "training_summary", mode: "puzzles", solved: 4, failed: 1 }),
    ],
  ])("ends %s with the During Practice pointer", (_name, text) => {
    expect(text.endsWith("\nPractice notification: follow During Practice.")).toBe(true);
  });

  it("words each queue kind in the summary, openings as opening positions", () => {
    const summary = (mode: TrainingSummaryNotification["mode"]): string =>
      renderTrainingSummary({ type: "training_summary", mode, solved: 4, failed: 1 });
    expect(summary("puzzles")).toContain("4 of 5 puzzles solved, 1 failed.");
    expect(summary("srs")).toContain("4 of 5 review cards solved, 1 failed.");
    expect(summary("openings")).toContain("4 of 5 opening positions solved, 1 failed.");
    expect(summary("openings")).not.toContain("puzzles solved");
  });
});

describe("difficulty change", () => {
  const change: DifficultyChangeNotification = {
    type: "difficulty_change",
    from_elo: 600,
    to_elo: 650,
    reason: "streak_up",
    game_id: 4,
  };

  it("names the old level, the new one and the reason", () => {
    const text = renderNotifications([change]);
    expect(text).toContain("from 600 to 650");
    expect(text).toContain("the student won the last two games");
  });

  it("states the lowering reason and survives being folded with a turn", () => {
    const down = { ...change, from_elo: 650, to_elo: 600, reason: "streak_down" as const };
    const text = renderNotifications([turn(1), down]);
    expect(text).toContain("from 650 to 600 because the student lost the last two games");
  });
});
