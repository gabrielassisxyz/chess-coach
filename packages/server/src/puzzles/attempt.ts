import { Chess } from "chess.js";
import { applyUci } from "../engine/moves.js";

export type AttemptStatus = "in_progress" | "solved" | "failed";

/**
 * `answered` is every graded try in order, wrong ones included. `failed` means the student gave
 * up; `failedPly` is then the step they gave up at. A wrong try never ends the attempt.
 */
export interface AttemptState {
  solution: readonly string[];
  cursor: number;
  fen: string;
  answered: readonly string[];
  status: AttemptStatus;
  failedPly: number | null;
  wrongTries: number;
}

export type TryOutcome =
  | { accepted: true; correct: boolean; state: AttemptState; reply: string | null }
  | { accepted: false; state: AttemptState; reason: "illegal" | "finished" };

export function startAttempt(fen: string, solution: readonly string[]): AttemptState {
  return {
    solution,
    cursor: 0,
    fen,
    answered: [],
    status: "in_progress",
    failedPly: null,
    wrongTries: 0,
  };
}

// Compared as a whole string, so a missing or different promotion piece is never defaulted.
function isLegalUci(fen: string, uci: string): boolean {
  return new Chess(fen)
    .moves({ verbose: true })
    .some((move) => `${move.from}${move.to}${move.promotion ?? ""}` === uci);
}

// Lichess allows several mates in one, so on the last step any checkmate wins.
function deliversMate(fen: string, uci: string): boolean {
  const board = new Chess(fen);
  applyUci(board, uci);
  return board.isCheckmate();
}

/** Grades one try against the current step; a wrong one keeps the cursor and the position. */
export function tryMove(state: AttemptState, uci: string): TryOutcome {
  if (state.status !== "in_progress") return { accepted: false, state, reason: "finished" };
  if (!isLegalUci(state.fen, uci)) return { accepted: false, state, reason: "illegal" };

  const answered = [...state.answered, uci];
  const isLastStep = state.cursor + 1 >= state.solution.length;
  const alternativeMate = isLastStep && deliversMate(state.fen, uci);
  if (uci !== state.solution[state.cursor] && !alternativeMate) {
    const missed = { ...state, answered, wrongTries: state.wrongTries + 1 };
    return { accepted: true, correct: false, state: missed, reply: null };
  }

  const board = new Chess(state.fen);
  applyUci(board, uci);
  const replyUci = state.solution[state.cursor + 1] ?? null;
  if (replyUci === null) {
    // The attempt's own copy records the move played, which playedSolution reads back.
    const solution = [...state.solution.slice(0, state.cursor), uci];
    const solved = { ...state, solution, fen: board.fen(), answered, status: "solved" as const };
    return { accepted: true, correct: true, state: solved, reply: null };
  }
  applyUci(board, replyUci);
  const next = { ...state, fen: board.fen(), cursor: state.cursor + 2, answered };
  return { accepted: true, correct: true, state: next, reply: replyUci };
}

/** Ends an open attempt as given up, at the step it was on; a finished one is returned as is. */
export function giveUp(state: AttemptState): AttemptState {
  if (state.status !== "in_progress") return state;
  return { ...state, status: "failed", failedPly: state.cursor };
}

/** The moves left from the step the attempt stopped at, replies included. */
export function solutionLineOf(state: AttemptState): string[] {
  return state.solution.slice(state.cursor);
}

/** Solved without a single wrong try on any step. */
export function solvedFirstTry(state: AttemptState): boolean {
  return state.status === "solved" && state.wrongTries === 0;
}
