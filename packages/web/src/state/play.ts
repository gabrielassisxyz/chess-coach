import type {
  ActivityMove,
  ActivityState,
  LegalMoveEntry,
  PromotionPiece,
} from "@chess-coach/shared";
import type { Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";

export const EVAL_CLAMP_CP = 1000;
export const MATE_CP = 10000;

export function destsFrom(legalMoves: LegalMoveEntry[]): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  for (const move of legalMoves) {
    const from = move.from as Key;
    dests.set(from, [...(dests.get(from) ?? []), move.to as Key]);
  }
  return dests;
}

export function promotionsFor(
  legalMoves: LegalMoveEntry[],
  from: string,
  to: string,
): PromotionPiece[] | null {
  const entry = legalMoves.find((move) => move.from === from && move.to === to);
  return entry?.promotions && entry.promotions.length > 0 ? entry.promotions : null;
}

export function checkedColor(fen: string): "white" | "black" | false {
  try {
    const chess = new Chess(fen);
    if (!chess.inCheck()) return false;
    return chess.turn() === "w" ? "white" : "black";
  } catch {
    return false;
  }
}

export function movesOf(activity: ActivityState | null): ActivityMove[] {
  if (activity?.kind === "live_game") return activity.moves;
  if (activity?.kind === "review") return activity.game.moves;
  return [];
}

export interface EvalView {
  fillPercent: number;
  label: string;
  description: string;
}

// The server already reports evaluations from the student's side, so positive favours the student.
export function evalView(moves: ActivityMove[]): EvalView | null {
  const latest = moves.findLast((move) => move.is_player && move.eval_after_cp !== null);
  if (!latest || latest.eval_after_cp === null) return null;
  const raw = latest.eval_after_cp;
  const clamped = Math.max(-EVAL_CLAMP_CP, Math.min(EVAL_CLAMP_CP, raw));
  const fillPercent = 50 + (clamped / EVAL_CLAMP_CP) * 50;
  if (Math.abs(raw) >= MATE_CP) {
    const side = raw > 0 ? "you" : "the engine";
    return { fillPercent, label: "M", description: `Mate for ${side}` };
  }
  const pawns = (clamped / 100).toFixed(1);
  const label = clamped > 0 ? `+${pawns}` : pawns;
  return { fillPercent, label, description: `Evaluation ${label} for you` };
}

export interface MoveRow {
  number: number;
  white: ActivityMove | null;
  black: ActivityMove | null;
}

export function moveRows(moves: ActivityMove[]): MoveRow[] {
  const rows = new Map<number, MoveRow>();
  for (const move of moves) {
    const number = Math.ceil(move.ply / 2);
    const row = rows.get(number) ?? { number, white: null, black: null };
    if (move.ply % 2 === 1) row.white = move;
    else row.black = move;
    rows.set(number, row);
  }
  return [...rows.values()];
}

export interface ControlState {
  undo: boolean;
  resign: boolean;
  abort: boolean;
  newGame: boolean;
  backToGame: boolean;
}

export function controlState(activity: ActivityState | null): ControlState {
  const live = activity?.kind === "live_game" ? activity : null;
  const running = live !== null && live.phase !== "finished";
  return {
    undo: live?.phase === "player_turn" && live.moves.length >= 2,
    resign: running,
    abort: running,
    newGame: activity?.kind !== "demo" && !running,
    backToGame: activity?.kind === "demo",
  };
}

export const CLASSIFICATION_LABEL: Record<NonNullable<ActivityMove["classification"]>, string> = {
  best: "Best",
  great: "Great",
  good: "Good",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder",
};
