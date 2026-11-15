import type { RepertoireDrill } from "@chess-coach/shared";
import { describe, expect, it } from "vitest";
import { practiceIdleLabel, startFailureText, trainingView } from "../src/state/practice.js";
import {
  answeredLineOf,
  drillFactsOf,
  hintLabelOf,
  nextEndsDrill,
  repertoireCardOf,
  resultText,
  shownMoveOf,
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
  it("asks for the idea, then the move, then nothing", () => {
    expect(hintLabelOf(drillOf())).toBe("Ask for the idea");
    expect(hintLabelOf(drillOf({ hint: { kind: "idea", text: "x" } }))).toBe("Ask for the move");
    expect(hintLabelOf(drillOf({ hint: { kind: "move", uci: "c2c3", san: "c3" } }))).toBeNull();
  });

  it("leaves only the idea to ask for while a move is new", () => {
    const first = { first_pass: true, answer: { uci: "c2c3", san: "c3" } };
    expect(hintLabelOf(drillOf(first))).toBe("Ask for the idea");
    expect(hintLabelOf(drillOf({ ...first, hint: { kind: "idea", text: "x" } }))).toBeNull();
  });

  it("shows a move only for a new move or after the second hint", () => {
    expect(shownMoveOf(drillOf())).toBeNull();
    expect(shownMoveOf(drillOf({ hint: { kind: "idea", text: "x" } }))).toBeNull();
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

  it("gives the idea, then the move, each under its own title", () => {
    expect(cardOf({ drill: { hint: { kind: "idea", text: "Prepare d4." } } })).toEqual({
      tone: "neutral",
      title: "The idea",
      body: "Prepare d4.",
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
    const hintedSound = cardOf({
      drill: {
        flagged_opening: null,
        flagged_sound: true,
        hint: { kind: "idea", text: "Prepare d4." },
      },
    });
    expect(hintedSound).toEqual({
      tone: "neutral",
      title: "Good move, but this line plays another move",
      body: "Prepare d4.",
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

  it("draws nothing before any move is answered or when none is stored", () => {
    expect(lineOf({})).toBeNull();
    expect(lineOf({ drill: { answered: { san: "c3", idea: null } } })).toBeNull();
  });

  it("words the answered move with its number and idea", () => {
    expect(lineOf({ drill: { answered: { san: "c3", idea: "Prepare d4." } } })).toEqual({
      title: "Why 4.c3",
      body: "Prepare d4.",
    });
  });

  it("numbers a shown new move from the line played so far", () => {
    expect(
      lineOf({
        sans: ["e4", "e5"],
        drill: { answered: { san: "Nf3", idea: "Develop." } },
      }),
    ).toEqual({ title: "Why 2.Nf3", body: "Develop." });
  });
});
