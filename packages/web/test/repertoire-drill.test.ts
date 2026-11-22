import type { RepertoireDrill } from "@chess-coach/shared";
import { describe, expect, it } from "vitest";
import { practiceIdleLabel, startFailureText, trainingView } from "../src/state/practice.js";
import {
  answeredLineOf,
  canSkipFirstShowings,
  drillFactsOf,
  hintLabelOf,
  nextEndsDrill,
  repertoireCardOf,
  resultText,
  shownMoveOf,
  skipFirstShowingsPrompt,
  variationNameOf,
} from "../src/state/repertoire-drill.js";
import { CLASSICAL_VARIATION, repertoireActivity, repertoireList } from "./practice-fixtures.js";

const drillOf = (overrides: Partial<RepertoireDrill> = {}): RepertoireDrill =>
  repertoireActivity({ drill: overrides }).repertoire as RepertoireDrill;

describe("variationNameOf", () => {
  it("prefers the position's own opening name", () => {
    expect(variationNameOf(drillOf(), repertoireList)).toBe("Italian Game: Giuoco Piano");
  });

  it("falls back to the variation of the repertoire being drilled, and to nothing unknown", () => {
    const bare = drillOf({ opening_name: null });
    expect(variationNameOf(bare, repertoireList)).toBe(CLASSICAL_VARIATION);
    expect(variationNameOf(bare, [])).toBeNull();
    expect(variationNameOf(bare, null)).toBeNull();
    expect(variationNameOf({ ...bare, repertoire_id: 99 }, repertoireList)).toBeNull();
  });
});

describe("the hints", () => {
  it("shows the piece, then the move, then nothing", () => {
    expect(hintLabelOf(drillOf())).toBe("Show the piece");
    expect(hintLabelOf(drillOf({ hint: { kind: "piece", square: "c2" } }))).toBe("Show the move");
    expect(hintLabelOf(drillOf({ hint: { kind: "move", uci: "c2c3", san: "c3" } }))).toBeNull();
  });

  it("offers no hint button on a first showing, whose answer and note are already shown", () => {
    const first = { first_pass: true, answer: { uci: "c2c3", san: "c3" } };
    expect(hintLabelOf(drillOf(first))).toBeNull();
    expect(hintLabelOf(drillOf({ ...first, hint: { kind: "piece", square: "c2" } }))).toBeNull();
  });

  it("shows a move only for a new move or after the second hint", () => {
    expect(shownMoveOf(drillOf())).toBeNull();
    expect(shownMoveOf(drillOf({ hint: { kind: "piece", square: "c2" } }))).toBeNull();
    expect(shownMoveOf(drillOf({ first_pass: true, answer: { uci: "c2c3", san: "c3" } }))).toEqual({
      uci: "c2c3",
      san: "c3",
    });
    expect(shownMoveOf(drillOf({ hint: { kind: "move", uci: "d2d4", san: "d4" } }))).toEqual({
      uci: "d2d4",
      san: "d4",
    });
  });
});

describe("the counts", () => {
  it("reads the wrong-try counter from the pass and the rest from the session", () => {
    const training = repertoireActivity({
      training: { tries: 3 },
      drill: { moves_left: 7, moves_right: 2 },
    });
    expect(drillFactsOf(training, training.repertoire as RepertoireDrill)).toEqual([
      { key: "left", label: "Moves left", value: 7 },
      { key: "right", label: "Right first try", value: 2 },
      { key: "tries", label: "Wrong tries", value: 3 },
    ]);
  });

  it("finishes after a pass only when no move is left, however long the queue looks", () => {
    expect(nextEndsDrill(drillOf({ moves_left: 0 }))).toBe(true);
    expect(nextEndsDrill(drillOf({ moves_left: 1 }))).toBe(false);
  });
});

describe("the state card", () => {
  const cardOf = (options: Parameters<typeof repertoireActivity>[0]) => {
    const training = repertoireActivity(options);
    return repertoireCardOf(
      training,
      training.repertoire as RepertoireDrill,
      trainingView(training),
    );
  };

  it("asks for the move without giving it away", () => {
    expect(cardOf({})).toEqual({
      tone: "neutral",
      title: "Your move",
      body: "White to play. Play the move of this line.",
    });
  });

  it("gives the answer of a new move and says it comes back", () => {
    expect(cardOf({ drill: { first_pass: true, answer: { uci: "c2c3", san: "c3" } } })).toEqual({
      tone: "neutral",
      title: "New move",
      body: "Play c3. You will be asked for it on a later pass.",
    });
  });

  it("names the piece square, then the move, each under its own title", () => {
    expect(cardOf({ drill: { hint: { kind: "piece", square: "c2" } } })).toEqual({
      tone: "neutral",
      title: "The piece",
      body: "Look at the piece on c2.",
    });
    expect(cardOf({ drill: { hint: { kind: "move", uci: "c2c3", san: "c3" } } })).toEqual({
      tone: "neutral",
      title: "The move",
      body: "Play c3.",
    });
  });

  it("names the other opening or warns on any sound move, and says nothing for a plain miss", () => {
    const named = cardOf({ drill: { flagged_opening: "Scotch Game", flagged_sound: true } });
    expect(named).toEqual({
      tone: "neutral",
      title: "Good move, but that is the Scotch Game",
      body: "It is not the move of this line. Try again.",
    });
    const unnamedSound = cardOf({ drill: { flagged_opening: null, flagged_sound: true } });
    expect(unnamedSound).toEqual({
      tone: "neutral",
      title: "Good move, but this line plays another move",
      body: "It is not the move of this line. Try again.",
    });
    const hintedPieceSound = cardOf({
      drill: {
        flagged_opening: null,
        flagged_sound: true,
        hint: { kind: "piece", square: "c2" },
      },
    });
    expect(hintedPieceSound).toEqual({
      tone: "neutral",
      title: "Good move, but this line plays another move",
      body: "Look at the piece on c2.",
    });
    const hintedMoveOpening = cardOf({
      drill: {
        flagged_opening: "Scotch Game",
        flagged_sound: true,
        hint: { kind: "move", uci: "c2c3", san: "c3" },
      },
    });
    expect(hintedMoveOpening).toEqual({
      tone: "neutral",
      title: "Good move, but that is the Scotch Game",
      body: "Play c3.",
    });
    const plain = cardOf({
      training: { tries: 2, last_try: { uci: "d2d3", san: "d3", correct: false } },
      drill: { flagged_opening: null, flagged_sound: false },
    });
    expect(plain).toEqual(cardOf({}));
  });

  it("reads the end of a line by how it went and what is left", () => {
    const over = { input_enabled: false, legal_moves: [] };
    expect(cardOf({ training: { ...over, status: "solved" }, drill: { moves_left: 1 } })).toEqual({
      tone: "right",
      title: "Line played",
      body: "1 move left to practise.",
    });
    expect(cardOf({ training: { ...over, status: "failed" }, drill: { moves_left: 0 } })).toEqual({
      tone: "wrong",
      title: "Missed a move",
      body: "It comes back on a later pass. That was the last move to practise.",
    });
  });

  it("says how many moves were practised and how many were right first try", () => {
    const summary = { solved: 9, failed: 3 };
    const card = cardOf({
      training: { summary, input_enabled: false, legal_moves: [] },
      drill: { result: { practised: 12, first_try_right: 9 } },
    });
    expect(card).toEqual({
      tone: "neutral",
      title: "Session finished",
      body: "12 moves practised, 9 right first try",
    });
    const perfect = cardOf({
      training: { summary: { solved: 2, failed: 0 }, input_enabled: false, legal_moves: [] },
      drill: { result: { practised: 2, first_try_right: 2 } },
    });
    expect(perfect.tone).toBe("right");
    expect(resultText(1, 0)).toBe("1 move practised, 0 right first try");
  });
});

describe("what the hub and the coach say", () => {
  it("words a line that ended for the coach panel, not as a solved puzzle", () => {
    const over = { status: "solved" as const, input_enabled: false, legal_moves: [] };
    expect(practiceIdleLabel(repertoireActivity({ training: over }))).toBe("line finished");
    expect(practiceIdleLabel(repertoireActivity())).toBe("waiting for your answer");
  });

  it("explains a refused line drill by its scope", () => {
    expect(startFailureText("repertoire", "due", "empty_queue", null)).toBe(
      "No move of this opening is due right now. Choose All moves to practise it anyway.",
    );
    expect(startFailureText("repertoire", "all", "empty_queue", null)).toBe(
      "This opening holds no move yet.",
    );
    expect(startFailureText("repertoire", "missed", "empty_queue", null)).toBe(
      "No move of this opening has been missed often enough lately. Choose All moves to practise it anyway.",
    );
    expect(
      startFailureText("repertoire", "all", "not_in_training", "training is not available"),
    ).toContain("Training could not start.");
  });
});

describe("the answered idea", () => {
  const lineOf = (options: Parameters<typeof repertoireActivity>[0]) => {
    const training = repertoireActivity(options);
    return answeredLineOf(training, training.repertoire as RepertoireDrill);
  };

  it("draws nothing before any move is answered, and shows a fallback body when no note is stored", () => {
    expect(lineOf({})).toBeNull();
    expect(lineOf({ drill: { answered: { san: "c3", idea: null, asked: false } } })).toEqual({
      title: "Why 4.c3",
      body: "No note for this move yet.",
      asked: false,
    });
  });

  it("words the answered move with its number, idea and asked state", () => {
    expect(
      lineOf({ drill: { answered: { san: "c3", idea: "Prepare d4.", asked: true } } }),
    ).toEqual({
      title: "Why 4.c3",
      body: "Prepare d4.",
      asked: true,
    });
  });

  it("numbers a shown new move from the line played so far", () => {
    expect(
      lineOf({
        sans: ["e4", "e5"],
        drill: { answered: { san: "Nf3", idea: "Develop.", asked: false } },
      }),
    ).toEqual({ title: "Why 2.Nf3", body: "Develop.", asked: false });
  });
});

describe("skipping first showings", () => {
  it("offers to skip only on a first showing with new moves left in the level", () => {
    const first = { first_pass: true, answer: { uci: "c2c3", san: "c3" } };
    expect(canSkipFirstShowings(drillOf({ ...first, new_moves: 3 }))).toBe(true);
    expect(canSkipFirstShowings(drillOf({ ...first, new_moves: 0 }))).toBe(false);
    expect(canSkipFirstShowings(drillOf({ first_pass: false, answer: null, new_moves: 5 }))).toBe(
      false,
    );
    expect(canSkipFirstShowings(drillOf({ first_pass: true, answer: null, new_moves: 5 }))).toBe(
      false,
    );
  });

  it("words the confirmation by level and singular or plural count", () => {
    const note = "They will be asked without the answer from now on. This cannot be undone.";
    expect(skipFirstShowingsPrompt(drillOf({ new_moves: 1, level: "variation" }))).toEqual({
      question: "Skip first practice for 1 new move of this line?",
      note,
    });
    expect(skipFirstShowingsPrompt(drillOf({ new_moves: 12 }))).toEqual({
      question: "Skip first practice for 12 new moves of this line?",
      note,
    });
    expect(skipFirstShowingsPrompt(drillOf({ new_moves: 4, level: "group" }))).toEqual({
      question: "Skip first practice for 4 new moves of this opening?",
      note,
    });
    expect(skipFirstShowingsPrompt(drillOf({ new_moves: 1, level: "side" }))).toEqual({
      question: "Skip first practice for 1 new move of this colour?",
      note,
    });
    expect(skipFirstShowingsPrompt(drillOf({ new_moves: 7, level: "side" }))).toEqual({
      question: "Skip first practice for 7 new moves of this colour?",
      note,
    });
  });
});
