import type {
  ExpectedMove,
  RepertoireDrill,
  RepertoireDrillResult,
  RepertoireSummary,
  TrainingActivity,
} from "@chess-coach/shared";
import type { TrainingView } from "./practice.js";
import type { StateCard } from "./practice-item.js";

// The view model of a repertoire line drill: what the panel says about the line in play, the
// two hints, the result at the end. Pure functions, so the column and the board render them.

const countWord = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

// The position's own book name when it has one, else the variation the drill was started from:
// the first position of every line, before 1.e4, has no book name.
export function variationNameOf(
  drill: RepertoireDrill,
  listed: readonly RepertoireSummary[] | null,
): string | null {
  if (drill.opening_name) return drill.opening_name;
  return listed?.find((entry) => entry.id === drill.repertoire_id)?.variation_name ?? null;
}

// The move the board and the move list show on the current pass: the answer while a move is new,
// the move once the second hint asked for it, and nothing otherwise.
export function shownMoveOf(drill: RepertoireDrill): ExpectedMove | null {
  if (drill.hint.kind === "move") return { uci: drill.hint.uci, san: drill.hint.san };
  return drill.first_pass ? drill.answer : null;
}

// One hint button, asked twice: the idea first, then the move. While a move is new its answer is
// already on screen, so only the idea is left to ask for.
export function hintLabelOf(drill: RepertoireDrill): string | null {
  if (drill.hint.kind === "none") return "Ask for the idea";
  if (drill.hint.kind === "idea" && !drill.first_pass) return "Ask for the move";
  return null;
}

export interface DrillFact {
  key: "left" | "right" | "tries";
  label: string;
  value: number;
}

// `tries` counts the wrong tries on the line in play; the other two count the whole session.
export function drillFactsOf(training: TrainingActivity, drill: RepertoireDrill): DrillFact[] {
  return [
    { key: "left", label: "Moves left", value: drill.moves_left },
    { key: "right", label: "Right first try", value: drill.moves_right },
    { key: "tries", label: "Wrong tries", value: training.tries },
  ];
}

export function resultText(practised: number, firstTryRight: number): string {
  return `${countWord(practised, "move", "moves")} practised, ${firstTryRight} right first try`;
}

function summaryCard(result: RepertoireDrillResult): StateCard {
  return {
    tone: result.first_try_right === result.practised ? "right" : "neutral",
    title: "Session finished",
    body: resultText(result.practised, result.first_try_right),
  };
}

const sideWord = (color: "white" | "black"): string => (color === "white" ? "White" : "Black");

// A hint shows on the card under its own title; the idea keeps its text, the move is named.
function hintLine(drill: RepertoireDrill): { title: string; body: string } | null {
  const { hint } = drill;
  if (hint.kind === "idea") return { title: "The idea", body: hint.text };
  if (hint.kind === "move") return { title: "The move", body: `Play ${hint.san}.` };
  return null;
}

// A plain miss says nothing here: only a flagged try, a hint or a new move has words.
function openCard(training: TrainingActivity, drill: RepertoireDrill): StateCard {
  const hint = hintLine(drill);
  if (drill.flagged_opening) {
    return {
      tone: "neutral",
      title: `Good move, but that is the ${drill.flagged_opening}`,
      body: hint?.body ?? "It is not the move of this line. Try again.",
    };
  }
  if (hint) return { tone: "neutral", ...hint };
  if (drill.first_pass && drill.answer) {
    return {
      tone: "neutral",
      title: "New move",
      body: `Play ${drill.answer.san}. You will be asked for it on a later pass.`,
    };
  }
  return {
    tone: "neutral",
    title: "Your move",
    body: `${sideWord(training.orientation)} to play. Play the move of this line.`,
  };
}

function endedCard(training: TrainingActivity, drill: RepertoireDrill): StateCard {
  const left =
    drill.moves_left === 0
      ? "That was the last move to practise."
      : `${countWord(drill.moves_left, "move", "moves")} left to practise.`;
  if (training.status === "failed") {
    return {
      tone: "wrong",
      title: "Missed a move",
      body: `It comes back on a later pass. ${left}`,
    };
  }
  return { tone: "right", title: "Line played", body: left };
}

// The state card of a drill that is not being analysed: the result, the open move, or the line
// that just ended.
export function repertoireCardOf(
  training: TrainingActivity,
  drill: RepertoireDrill,
  view: TrainingView,
): StateCard {
  if (drill.result) return summaryCard(drill.result);
  return view.open ? openCard(training, drill) : endedCard(training, drill);
}

// A pass whose move was missed brings its line back, so the last pass the screen knows of is the
// last one only when nothing is left to practise.
export function nextEndsDrill(drill: RepertoireDrill): boolean {
  return drill.moves_left === 0;
}
