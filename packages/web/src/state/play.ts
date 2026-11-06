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

export interface LineStep {
  fen: string;
  from: string;
  to: string;
}

// The positions a line of UCI moves walks through from `fen`; it stops at a move that does not apply.
export function positionsAlong(fen: string, line: readonly string[]): LineStep[] {
  const steps: LineStep[] = [];
  try {
    const chess = new Chess(fen);
    for (const uci of line) {
      const squares = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
      const move = chess.move(uci.length > 4 ? { ...squares, promotion: uci.slice(4) } : squares);
      steps.push({ fen: chess.fen(), from: move.from, to: move.to });
    }
  } catch {
    // A move the position does not allow ends the line where it stands.
  }
  return steps;
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
  const label = signedPawns(clamped);
  return { fillPercent, label, description: `Evaluation ${label} for you` };
}

// A true minus sign, so the number lines up with the plus in a mono column.
export function signedPawns(cp: number): string {
  const text = (Math.abs(cp) / 100).toFixed(1);
  if (cp > 0) return `+${text}`;
  return cp < 0 ? `\u2212${text}` : text;
}

export function plyLabel(ply: number, san: string, spaced = false): string {
  const number = Math.ceil(ply / 2);
  const dots = ply % 2 === 1 ? "." : "...";
  return `${number}${dots}${spaced ? " " : ""}${san}`;
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

export type Classification = NonNullable<ActivityMove["classification"]>;

// Only the three grades that cost something get text beside the dot; the rest stay a dot.
export const MARK_TEXT: Partial<Record<Classification, string>> = {
  inaccuracy: "?!",
  mistake: "?",
  blunder: "??",
};

export function lastBlunder(moves: ActivityMove[]): ActivityMove | null {
  return moves.findLast((move) => move.is_player && move.classification === "blunder") ?? null;
}

export interface BlunderFacts {
  move: string;
  played: string | null;
  best: string | null;
  lost: string | null;
}

// The server reports evaluations from the student's side, so the best line was worth what the
// move left plus what it threw away.
export function blunderFacts(move: ActivityMove): BlunderFacts {
  const { eval_after_cp: after, cp_loss: loss, best_move_san: best } = move;
  const bestEval = after !== null && loss !== null ? after + loss : null;
  return {
    move: plyLabel(move.ply, move.san, true),
    played: after === null ? null : signedPawns(after),
    best: best === null ? null : bestEval === null ? best : `${best} (${signedPawns(bestEval)})`,
    lost: loss === null ? null : (loss / 100).toFixed(1),
  };
}

// The offer to take a blunder back exists only while undo does and the move it would undo is the
// graded blunder, so it lapses by itself once the game moves on.
export function takeBackOffer(activity: ActivityState | null): ActivityMove | null {
  if (activity?.kind !== "live_game" || !controlState(activity).undo) return null;
  const last = activity.moves.findLast((move) => move.is_player);
  return last?.classification === "blunder" ? last : null;
}
