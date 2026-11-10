import type {
  LegalMoveEntry,
  PlayedMove,
  QueueOutcome,
  TrainingActivity,
  TrainingMode,
  WrongTry,
} from "@chess-coach/shared";
import { Chess } from "chess.js";
import {
  formatElapsed,
  MISSED_TRY,
  motifLabel,
  OPENING_MOTIFS,
  type TrainingView,
} from "./practice.js";

// The view model of the puzzle column: what the header, the move list, the ratings row and the
// state card say for a given training activity. Pure functions, so the column renders them.

const KIND_WORD: Record<TrainingMode, string> = {
  srs: "Card",
  puzzles: "Puzzle",
  openings: "Opening",
  repertoire: "Line",
};

const sideWord = (side: "white" | "black"): string => (side === "white" ? "White" : "Black");

export interface ItemHeading {
  title: string;
  tag: string | null;
  openingName: string | null;
}

// The tag names only what the student already knows: the motif they chose, the colour of an
// opening drill, or, on an Any-motif run, the pattern once the item has ended.
export function headingOf(training: TrainingActivity, runMotif: string | null): ItemHeading {
  const { item, mode } = training;
  const title = `${KIND_WORD[mode]} ${item.position_in_queue} of ${item.queue_length}`;
  if (item.kind !== "puzzle") return { title, tag: null, openingName: null };
  const openingName = item.opening_name ?? null;
  if (mode === "openings") {
    return { title, tag: `As ${sideWord(training.orientation)}`, openingName };
  }
  if (runMotif === OPENING_MOTIFS.italian) {
    return { title, tag: "Italian Opening", openingName };
  }
  if (runMotif) return { title, tag: motifLabel(runMotif), openingName };
  const ended = training.status === "solved" || training.status === "failed";
  return { title, tag: ended ? motifLabel(item.motif) : null, openingName };
}

// The line pinned over the conversation: which item is on the board and which side the student
// plays, with the pattern only when the heading would show it too.
export function contextLineOf(training: TrainingActivity, runMotif: string | null): string {
  const heading = headingOf(training, runMotif);
  const [kind, position] = heading.title.split(" ");
  const parts = [`${kind} ${position}`];
  if (heading.tag) parts.push(heading.tag);
  parts.push(`you play ${sideWord(training.orientation)}`);
  return parts.join(" \u00b7 ");
}

export interface WhyChip {
  key: string;
  text: string;
}

// Offered once an item ended after at least one wrong try, about the first wrong move. The text
// is what the student would type, so it is in the language of the conversation (Portuguese, like
// the chat's own buttons), not the language of the column.
export function whyChipOf(training: TrainingActivity): WhyChip | null {
  const ended =
    training.status === "solved" || training.status === "failed" || training.status === "rated";
  if (!ended) return null;
  const wrong = wrongTriesOf(training)[0];
  if (!wrong) return null;
  const san = wrong.san ?? wrong.uci;
  return {
    key: `${training.served_at}:${training.item.position_in_queue}`,
    text: `Por que ${san} foi ruim?`,
  };
}

// A puzzle solved first try without a hint leaves the coach silent; this is the button's label and
// whether it is on offer. It is gone once pressed, since the server then reports `requested`.
export const ASK_COACH_LABEL = "Pedir comentário do coach";
export const coachCommentOffered = (training: TrainingActivity): boolean =>
  training.coach_comment === "offered";

export const movesOf = (training: TrainingActivity): PlayedMove[] => training.moves ?? [];
export const wrongTriesOf = (training: TrainingActivity): WrongTry[] => training.wrong_tries ?? [];

export function outcomesOf(training: TrainingActivity): QueueOutcome[] {
  if (training.queue_outcomes) return training.queue_outcomes;
  const { position_in_queue: at, queue_length: length } = training.item;
  return Array.from({ length }, (_, index) => (index + 1 === at ? "current" : "pending"));
}

export function startFenOf(training: TrainingActivity): string {
  return training.item.kind === "card" ? training.item.prompt_fen : training.item.fen;
}

export interface MoveCell {
  ply: number;
  san: string;
  // `pending` is the ply the student is on, drawn empty; `solution` is the line shown after a give-up.
  by: "student" | "reply" | "solution" | "pending";
  wrongTries: WrongTry[];
}

export interface MoveRow {
  number: number;
  // A Black start opens with an ellipsis where White's move would be.
  white: MoveCell | "ellipsis" | null;
  black: MoveCell | null;
}

function applyUci(board: Chess, uci: string): string {
  const move = board.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci.length > 4 ? { promotion: uci.slice(4) } : {}),
  });
  return move.san;
}

function solutionCells(fen: string, ucis: readonly string[], firstPly: number): MoveCell[] {
  const board = new Chess(fen);
  const cells: MoveCell[] = [];
  try {
    ucis.forEach((uci, offset) => {
      cells.push({
        ply: firstPly + offset,
        san: applyUci(board, uci),
        by: "solution",
        wrongTries: [],
      });
    });
  } catch {
    // A move the position does not allow ends the shown line where it stands.
  }
  return cells;
}

// Rows numbered from the start position's move counter. The ply the student is on is an empty
// cell while the item is open, so a wrong try before any right move has a row to hang under.
export function moveRowsOf(training: TrainingActivity): MoveRow[] {
  const [, side, , , , fullmove] = startFenOf(training).split(" ");
  const cells: MoveCell[] = movesOf(training).map((move) => ({
    ply: move.ply,
    san: move.san,
    by: move.by,
    wrongTries: [],
  }));
  if (training.gave_up && training.solution_line) {
    cells.push(...solutionCells(training.fen, training.solution_line, cells.length));
  }
  const open =
    training.summary === null &&
    (training.status === "prompt" || training.status === "in_progress");
  if (open) cells.push({ ply: cells.length, san: "", by: "pending", wrongTries: [] });
  for (const wrong of wrongTriesOf(training)) cells[wrong.ply]?.wrongTries.push(wrong);

  const blackStarts = side === "b";
  const base = Number(fullmove) || 1;
  const rows = new Map<number, MoveRow>();
  cells.forEach((cell, index) => {
    const white = blackStarts ? index % 2 === 1 : index % 2 === 0;
    const number = base + Math.floor((blackStarts ? index + 1 : index) / 2);
    const row = rows.get(number) ?? { number, white: null, black: null };
    if (white) row.white = cell;
    else {
      row.black = cell;
      if (row.white === null) row.white = "ellipsis";
    }
    rows.set(number, row);
  });
  return [...rows.values()];
}

// "31… Bf3 ✗": the wrong try as a variation under the ply it was tried at.
export function variationText(
  number: number,
  white: boolean,
  san: string | null,
  uci: string,
): string {
  return `${number}${white ? "." : "…"} ${san ?? uci} ✗`;
}

export type CardTone = "neutral" | "right" | "wrong";

export interface StateCard {
  tone: CardTone;
  title: string;
  body: string;
}

function countWord(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// Without the line (an older server), a solved card is one move and a puzzle as many as its cursor says.
function studentMoveCount(training: TrainingActivity): number {
  if (training.moves) return training.moves.filter((move) => move.by === "student").length;
  if (training.item.kind === "card") return training.gave_up ? 0 : 1;
  if (training.item.kind === "repertoire") return 0;
  return Math.floor(training.item.cursor / 2) + (training.status === "solved" ? 1 : 0);
}

function endedStats(training: TrainingActivity, elapsedMs: number): string[] {
  const studentMoves = studentMoveCount(training);
  const parts = studentMoves > 0 ? [countWord(studentMoves, "move", "moves")] : [];
  if (training.tries > 0) parts.push(countWord(training.tries, "wrong try", "wrong tries"));
  parts.push(formatElapsed(elapsedMs));
  return parts;
}

// One card per moment, the title in the colour and the word together.
export function stateCardOf(
  training: TrainingActivity,
  view: TrainingView,
  scratchLine: string[] | null,
  elapsedMs: number,
): StateCard {
  if (scratchLine !== null) {
    const line = scratchLine.join(" ");
    if (view.open) {
      return {
        tone: "neutral",
        title: "Exploring",
        body: line === "" ? "Nothing yet. Moves here are not graded." : line,
      };
    }
    return {
      tone: "neutral",
      title: "Analysing",
      body: line === "" ? "Move the pieces freely. Nothing here is graded." : line,
    };
  }
  if (view.summary) {
    return {
      tone: view.summary.failed === 0 ? "right" : "neutral",
      title: "Session finished",
      body: `${view.summary.solved} solved, ${view.summary.failed} failed`,
    };
  }
  if (view.open) {
    if (view.status === MISSED_TRY) {
      const san = training.last_try?.san ?? training.last_try?.uci ?? "That";
      return { tone: "wrong", title: "Not that move", body: `${san}. Try something else.` };
    }
    if (training.status === "in_progress") {
      return { tone: "right", title: "Best move", body: "Keep going. Your move again." };
    }
    const hint = training.hint_square ? ` Look at the piece on ${training.hint_square}.` : "";
    return {
      tone: "neutral",
      title: "Your move",
      body: `${sideWord(training.orientation)} to play. Find the best move.${hint}`,
    };
  }
  const stats = endedStats(training, elapsedMs);
  if (training.status === "failed") {
    const expected = view.expected ? [`Expected ${view.expected}`] : [];
    return { tone: "wrong", title: "Solution shown", body: [...expected, ...stats].join(" · ") };
  }
  return {
    tone: "right",
    title: training.status === "rated" ? "Rated" : "Solved",
    body: stats.join(" · "),
  };
}

export interface RatingsRow {
  yours: number | null;
  change: number | null;
  // The puzzle's rating stays hidden until the item ends, so it does not hint at the difficulty.
  puzzle: number | null;
  revealed: boolean;
}

export function ratingsOf(training: TrainingActivity, view: TrainingView): RatingsRow {
  return {
    yours: training.student_rating ?? null,
    change: training.rating_change ?? null,
    puzzle: training.item.kind === "puzzle" ? (training.item.rating ?? null) : null,
    revealed: !view.open,
  };
}

// A true minus sign, so the change lines up with the plus in a mono column.
export function signedCount(value: number): string {
  if (value > 0) return `+${value}`;
  return value < 0 ? `−${Math.abs(value)}` : "0";
}

export interface BoardPosition {
  fen: string;
  lastMove: { from: string; to: string } | null;
}

// The position after the first `count` moves of the line, for stepping back through the item.
export function positionAfter(
  startFen: string,
  ucis: readonly string[],
  count: number,
): BoardPosition {
  const board = new Chess(startFen);
  let lastMove: BoardPosition["lastMove"] = null;
  try {
    for (const uci of ucis.slice(0, count)) {
      applyUci(board, uci);
      lastMove = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
    }
  } catch {
    // A move the position does not allow ends the line where it stands.
  }
  return { fen: board.fen(), lastMove };
}

export function legalMovesIn(fen: string): LegalMoveEntry[] {
  const entries = new Map<string, LegalMoveEntry>();
  for (const move of new Chess(fen).moves({ verbose: true })) {
    const key = `${move.from}${move.to}`;
    const entry = entries.get(key) ?? { from: move.from, to: move.to };
    if (move.promotion) {
      entry.promotions = [
        ...(entry.promotions ?? []),
        move.promotion as LegalMoveEntry["promotions"] extends (infer P)[] | undefined ? P : never,
      ];
    }
    entries.set(key, entry);
  }
  return [...entries.values()];
}

export interface LocalBoard {
  fen: string;
  turn: "white" | "black";
  lastMove: BoardPosition["lastMove"];
  legalMoves: LegalMoveEntry[];
  sans: string[];
}

// Free analysis after the answer runs on the client alone: the position, its legal moves and the
// line's SAN all come from chess.js, and nothing is sent or graded.
export function localBoard(fen: string, ucis: readonly string[]): LocalBoard {
  const board = new Chess(fen);
  const sans: string[] = [];
  let lastMove: BoardPosition["lastMove"] = null;
  for (const uci of ucis) {
    sans.push(applyUci(board, uci));
    lastMove = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
  }
  const next = board.fen();
  return {
    fen: next,
    turn: board.turn() === "w" ? "white" : "black",
    lastMove,
    legalMoves: legalMovesIn(next),
    sans,
  };
}

export function isLegalIn(fen: string, uci: string): boolean {
  try {
    applyUci(new Chess(fen), uci);
    return true;
  } catch {
    return false;
  }
}
