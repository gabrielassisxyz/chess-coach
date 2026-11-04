import type { Chess, Color, PieceSymbol } from "chess.js";
import type {
  GamePhase,
  GameRecord,
  GameResult,
  MoveRecord,
  PlayerColor,
  Termination,
} from "../db/games.js";
import type { Classification } from "../engine/evaluate.js";

export type Promotion = "q" | "r" | "b" | "n";

export interface LegalMove {
  from: string;
  to: string;
  promotions?: Promotion[];
}

export interface SnapshotMove {
  ply: number;
  san: string;
  uci: string;
  isPlayer: boolean;
  evalBeforeCp: number | null;
  evalAfterCp: number | null;
  cpLoss: number | null;
  classification: Classification | null;
  bestMoveSan: string | null;
}

export interface GameSnapshot {
  gameId: number;
  fen: string;
  turn: PlayerColor;
  playerColor: PlayerColor;
  phase: GamePhase;
  legalMoves: LegalMove[];
  moves: SnapshotMove[];
  lastMove: { from: string; to: string; san: string; ply: number } | null;
  material: { white: number; black: number };
  result: GameResult | null;
  termination: Termination | null;
}

const PIECE_VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PROMOTION_ORDER: Promotion[] = ["q", "r", "b", "n"];

export function legalMoves(chess: Chess): LegalMove[] {
  const byKey = new Map<string, LegalMove>();
  for (const move of chess.moves({ verbose: true })) {
    const key = `${move.from}${move.to}`;
    const entry = byKey.get(key) ?? { from: move.from, to: move.to };
    if (move.promotion) {
      const known = new Set(entry.promotions ?? []);
      known.add(move.promotion as Promotion);
      entry.promotions = PROMOTION_ORDER.filter((piece) => known.has(piece));
    }
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

function material(chess: Chess): { white: number; black: number } {
  const total = { white: 0, black: 0 };
  for (const row of chess.board()) {
    for (const square of row) {
      if (!square) continue;
      total[square.color === "w" ? "white" : "black"] += PIECE_VALUE[square.type];
    }
  }
  return total;
}

const colorName = (color: Color): PlayerColor => (color === "w" ? "white" : "black");

export function buildSnapshot(game: GameRecord, moves: MoveRecord[], chess: Chess): GameSnapshot {
  const last = moves.at(-1);
  return {
    gameId: game.id,
    fen: chess.fen(),
    turn: colorName(chess.turn()),
    playerColor: game.playerColor,
    phase: game.phase,
    legalMoves: game.phase === "player_turn" ? legalMoves(chess) : [],
    moves: moves.map((move) => ({
      ply: move.ply,
      san: move.san,
      uci: move.uci,
      isPlayer: move.isPlayer,
      evalBeforeCp: move.evalBeforeCp,
      evalAfterCp: move.evalAfterCp,
      cpLoss: move.cpLoss,
      classification: move.classification,
      bestMoveSan: move.bestMoveSan,
    })),
    lastMove: last
      ? { from: last.uci.slice(0, 2), to: last.uci.slice(2, 4), san: last.san, ply: last.ply }
      : null,
    material: material(chess),
    result: game.result,
    termination: game.termination,
  };
}
