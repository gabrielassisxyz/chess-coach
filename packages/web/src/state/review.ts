import type { GameDetail, GameMove, GameSummary, ReviewActivity } from "@chess-coach/shared";

export const SELECT_DEBOUNCE_MS = 150;

export function plyCount(game: GameDetail): number {
  return game.moves.length;
}

export function moveAt(game: GameDetail, ply: number): GameMove | null {
  return ply === 0 ? null : (game.moves[ply - 1] ?? null);
}

// Ply 0 is the starting position, so stepping never leaves 0..count.
export function stepTarget(key: string, ply: number, count: number): number | null {
  if (key === "ArrowLeft") return Math.max(0, ply - 1);
  if (key === "ArrowRight") return Math.min(count, ply + 1);
  if (key === "Home") return 0;
  if (key === "End") return count;
  return null;
}

// Typing in the chat must never move the board.
export function takesTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.matches("input, textarea, select")) return true;
  const editable = target.getAttribute("contenteditable");
  return target.isContentEditable || (editable !== null && editable !== "false");
}

/**
 * The board for the selected ply, built here from the fetched game. The server's `review` state
 * is not read for its position: it follows this one by a debounced command, and waiting for it
 * would make every arrow key a round trip. Only the activity id comes from the server.
 */
export function localReviewState(
  game: GameDetail,
  ply: number,
  activityId: number,
): ReviewActivity {
  const move = moveAt(game, ply);
  const fen = move ? move.fen_after : game.initial_fen;
  return {
    kind: "review",
    activity_id: activityId,
    orientation: game.player_color,
    fen,
    turn: fen.split(" ")[1] === "b" ? "black" : "white",
    last_move: move ? { from: move.uci.slice(0, 2), to: move.uci.slice(2, 4) } : null,
    legal_moves: [],
    input_enabled: false,
    pending: "none",
    game: { id: game.id, moves: game.moves, result: game.result },
    selected_ply: ply,
  };
}

export function accuracyLabel(accuracy: number | null): string {
  return accuracy === null ? "not graded" : `${Math.round(accuracy * 100)}% accuracy`;
}

export function summaryLabel(game: GameSummary): string {
  const result = game.result ?? "no result";
  const ending = game.termination ?? "unfinished";
  return `${game.started_at.slice(0, 10)}, ${game.player_color}, Elo ${game.target_elo}, ${result} by ${ending}, ${game.move_count} moves, ${accuracyLabel(game.accuracy)}`;
}
