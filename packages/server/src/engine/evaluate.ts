import { Chess } from "chess.js";
import { applyUci } from "./moves.js";
import { MATE_SCORE_CP } from "./parse.js";
import type { Searcher, SearchResult } from "./uci.js";

export type Classification = "best" | "great" | "good" | "inaccuracy" | "mistake" | "blunder";
export type StudentColor = "w" | "b";

export const EVALUATION_DEPTH = 16;

export interface PlayerMoveEvaluation {
  evalBeforeCp: number;
  evalAfterCp: number;
  cpLoss: number;
  classification: Classification;
  bestMoveUci: string | null;
  bestMoveSan: string | null;
}

export function classifyCpLoss(cpLoss: number): Classification {
  if (cpLoss <= 0) return "best";
  if (cpLoss <= 30) return "great";
  if (cpLoss <= 80) return "good";
  if (cpLoss <= 150) return "inaccuracy";
  if (cpLoss <= 300) return "mistake";
  return "blunder";
}

/** UCI scores are from the side to move; the student's view flips them when it is the other side. */
function studentView(result: SearchResult, studentColor: StudentColor): number {
  const position = new Chess(result.fen);
  const line = result.lines[0];
  // A terminal position can come back with no score line at all.
  const fromMover = line ? line.score : position.isCheckmate() ? -MATE_SCORE_CP : 0;
  return position.turn() === studentColor ? fromMover : -fromMover;
}

export async function evaluatePlayerMove(
  engine: Searcher,
  fenBefore: string,
  moveUci: string,
  studentColor: StudentColor,
): Promise<PlayerMoveEvaluation> {
  const position = new Chess(fenBefore);
  applyUci(position, moveUci);
  const before = await engine.search({ fen: fenBefore, depth: EVALUATION_DEPTH, multipv: 1 });
  const after = await engine.search({ fen: position.fen(), depth: EVALUATION_DEPTH, multipv: 1 });
  const evalBeforeCp = studentView(before, studentColor);
  const evalAfterCp = studentView(after, studentColor);
  // Search noise can rate the position after the move above the one before it.
  const cpLoss = Math.max(0, evalBeforeCp - evalAfterCp);
  return {
    evalBeforeCp,
    evalAfterCp,
    cpLoss,
    classification: classifyCpLoss(cpLoss),
    bestMoveUci: before.bestmove,
    bestMoveSan: before.bestmove ? applyUci(new Chess(fenBefore), before.bestmove).san : null,
  };
}
