import { Chess } from "chess.js";
import { applyUci } from "../engine/moves.js";

export type AttemptStatus = "in_progress" | "solved" | "failed";

export interface AttemptState {
  solution: readonly string[];
  cursor: number;
  fen: string;
  answered: readonly string[];
  status: AttemptStatus;
  failedPly: number | null;
}

export type AnswerOutcome =
  | { accepted: true; state: AttemptState; reply: string | null }
  | { accepted: false; state: AttemptState; reason: "illegal" | "finished" };

export function startAttempt(fen: string, solution: readonly string[]): AttemptState {
  return { solution, cursor: 0, fen, answered: [], status: "in_progress", failedPly: null };
}

// Compared as a whole string, so a missing or different promotion piece is never defaulted.
function isLegalUci(fen: string, uci: string): boolean {
  return new Chess(fen)
    .moves({ verbose: true })
    .some((move) => `${move.from}${move.to}${move.promotion ?? ""}` === uci);
}

export function answer(state: AttemptState, uci: string): AnswerOutcome {
  if (state.status !== "in_progress") return { accepted: false, state, reason: "finished" };
  if (!isLegalUci(state.fen, uci)) return { accepted: false, state, reason: "illegal" };

  const answered = [...state.answered, uci];
  if (uci !== state.solution[state.cursor]) {
    const failed = { ...state, answered, status: "failed" as const, failedPly: state.cursor };
    return { accepted: true, state: failed, reply: null };
  }

  const board = new Chess(state.fen);
  applyUci(board, uci);
  const replyUci = state.solution[state.cursor + 1] ?? null;
  if (replyUci === null) {
    const solved = { ...state, fen: board.fen(), answered, status: "solved" as const };
    return { accepted: true, state: solved, reply: null };
  }
  applyUci(board, replyUci);
  const next = { ...state, fen: board.fen(), cursor: state.cursor + 2, answered };
  return { accepted: true, state: next, reply: replyUci };
}
