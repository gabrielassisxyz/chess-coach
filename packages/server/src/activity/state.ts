import type {
  ActivityMove,
  DemoActivity,
  LiveGameActivity,
  Pending,
  ReviewActivity,
} from "@chess-coach/shared";
import type { Chess } from "chess.js";
import type { GameRecord, MoveRecord, PlayerColor } from "../db/games.js";
import type { GameSnapshot, SnapshotMove } from "../game/snapshot.js";

type Orientation = PlayerColor;

function pendingOf(phase: GameSnapshot["phase"]): Pending {
  if (phase === "evaluating") return "evaluating";
  if (phase === "engine_turn") return "engine_thinking";
  return "none";
}

function activityMove(move: SnapshotMove | MoveRecord): ActivityMove {
  return {
    ply: move.ply,
    san: move.san,
    uci: move.uci,
    is_player: move.isPlayer,
    eval_before_cp: move.evalBeforeCp,
    eval_after_cp: move.evalAfterCp,
    cp_loss: move.cpLoss,
    classification: move.classification,
    best_move_san: move.bestMoveSan,
  };
}

const turnOfFen = (fen: string): PlayerColor => (fen.split(" ")[1] === "b" ? "black" : "white");

export function liveGameState(activityId: number, snapshot: GameSnapshot): LiveGameActivity {
  const pending = pendingOf(snapshot.phase);
  const inputEnabled = pending === "none" && snapshot.phase === "player_turn";
  return {
    kind: "live_game",
    activity_id: activityId,
    orientation: snapshot.playerColor,
    fen: snapshot.fen,
    turn: snapshot.turn,
    last_move: snapshot.lastMove
      ? { from: snapshot.lastMove.from, to: snapshot.lastMove.to }
      : null,
    legal_moves: inputEnabled ? snapshot.legalMoves : [],
    input_enabled: inputEnabled,
    pending,
    game_id: snapshot.gameId,
    phase: snapshot.phase,
    moves: snapshot.moves.map(activityMove),
    material: snapshot.material,
    result: snapshot.result,
    termination: snapshot.termination,
  };
}

export function reviewState(
  activityId: number,
  game: GameRecord,
  moves: MoveRecord[],
  selectedPly: number,
): ReviewActivity {
  const selected = selectedPly === 0 ? undefined : moves[selectedPly - 1];
  const fen = selected ? selected.fenAfter : game.initialFen;
  return {
    kind: "review",
    activity_id: activityId,
    orientation: game.playerColor,
    fen,
    turn: turnOfFen(fen),
    last_move: selected ? { from: selected.uci.slice(0, 2), to: selected.uci.slice(2, 4) } : null,
    legal_moves: [],
    input_enabled: false,
    pending: "none",
    game: { id: game.id, moves: moves.map(activityMove), result: game.result },
    selected_ply: selectedPly,
  };
}

// Only the coach steps a demo, so the board never takes input and offers no legal moves.
export function demoState(
  activityId: number,
  chess: Chess,
  movesPlayed: string[],
  returnsTo: DemoActivity["returns_to"],
  orientation: Orientation,
): DemoActivity {
  const last = chess.history({ verbose: true }).at(-1);
  return {
    kind: "demo",
    activity_id: activityId,
    orientation,
    fen: chess.fen(),
    turn: chess.turn() === "w" ? "white" : "black",
    last_move: last ? { from: last.from, to: last.to } : null,
    legal_moves: [],
    input_enabled: false,
    pending: "none",
    returns_to: returnsTo,
    moves_played: movesPlayed,
  };
}
