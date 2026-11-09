import type {
  GameDetail,
  GameMove,
  GameSummary,
  ImportStatus,
  ReviewActivity,
} from "@chess-coach/shared";

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

function importedLabel(game: GameSummary): string {
  const result = game.result ?? "no result";
  const ending = game.termination ?? "unfinished";
  const where = SOURCE_TAG[game.source];
  const versus = game.opponent ? ` vs ${game.opponent}` : "";
  const grade = game.grading === "done" ? accuracyLabel(game.accuracy) : `grading ${game.grading}`;
  return `${(game.played_at ?? game.started_at).slice(0, 10)}, ${where}${versus}, ${game.player_color}, ${result} by ${ending}, ${game.move_count} moves, ${grade}`;
}

export function summaryLabel(game: GameSummary): string {
  if (game.source !== "coach") return importedLabel(game);
  const result = game.result ?? "no result";
  const ending = game.termination ?? "unfinished";
  return `${game.started_at.slice(0, 10)}, ${game.player_color}, Elo ${game.target_elo}, ${result} by ${ending}, ${game.move_count} moves, ${accuracyLabel(game.accuracy)}`;
}

export type SourceFilter = "all" | GameSummary["source"];
export type ResultFilter = "all" | "won" | "lost" | "drawn";
export type Outcome = "won" | "lost" | "drawn";

export const RESULT_GLYPH = { "1-0": "1–0", "0-1": "0–1", "1/2-1/2": "½–½" } as const;

const MARKS: Record<string, string> = { inaccuracy: "?!", mistake: "?", blunder: "??" };

export function outcomeOf(game: Pick<GameSummary, "result" | "player_color">): Outcome | null {
  if (game.result === null) return null;
  if (game.result === "1/2-1/2") return "drawn";
  return (game.result === "1-0") === (game.player_color === "white") ? "won" : "lost";
}

export function filterGames(
  games: GameSummary[],
  source: SourceFilter,
  result: ResultFilter,
): GameSummary[] {
  return games.filter(
    (game) =>
      (source === "all" || game.source === source) &&
      (result === "all" || outcomeOf(game) === result),
  );
}

export function sourceCounts(games: GameSummary[]): Record<SourceFilter, number> {
  const counts: Record<SourceFilter, number> = {
    all: games.length,
    coach: 0,
    chesscom: 0,
    lichess: 0,
    pgn: 0,
  };
  for (const game of games) counts[game.source] += 1;
  return counts;
}

export interface Totals {
  games: number;
  won: number;
  lost: number;
  drawn: number;
  // Whole percent over the games that have an accuracy; null when none has.
  averageAccuracy: number | null;
}

export function totalsOf(games: GameSummary[]): Totals {
  const outcomes = games.map(outcomeOf);
  const accuracies = games.flatMap((game) => (game.accuracy === null ? [] : [game.accuracy]));
  const mean = accuracies.reduce((sum, value) => sum + value, 0) / (accuracies.length || 1);
  return {
    games: games.length,
    won: outcomes.filter((outcome) => outcome === "won").length,
    lost: outcomes.filter((outcome) => outcome === "lost").length,
    drawn: outcomes.filter((outcome) => outcome === "drawn").length,
    averageAccuracy: accuracies.length === 0 ? null : Math.round(mean * 100),
  };
}

export function lossLabel(cpLoss: number): string {
  return `−${(cpLoss / 100).toFixed(1)}`;
}

export function markOf(classification: string | null): string {
  return classification ? (MARKS[classification] ?? "") : "";
}

// "13. Ne5" for White, "13…Bd6" for Black.
export function plyLabel(ply: number, san: string): string {
  return `${Math.ceil(ply / 2)}${ply % 2 === 1 ? ". " : "…"}${san}`;
}

export function playedAt(game: Pick<GameSummary, "played_at" | "started_at">): string {
  return game.played_at ?? game.started_at;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function dateLabel(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const midnight = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(then)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return then.toLocaleDateString("en-US", { weekday: "short" });
  const sameYear = then.getFullYear() === now.getFullYear();
  return then.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export const SOURCE_TAG = {
  coach: "Coached",
  chesscom: "Chess.com",
  lichess: "Lichess",
  pgn: "PGN",
} as const;

export function opponentLabel(
  game: Pick<GameSummary, "source" | "target_elo" | "opponent" | "opponent_rating">,
): string {
  if (game.source === "coach") return `Stockfish ${game.target_elo}`;
  const name = game.opponent ?? "Unknown";
  return game.opponent_rating === null ? name : `${name} ${game.opponent_rating}`;
}

export type TimeClass = "bullet" | "blitz" | "rapid" | "daily";

// The same buckets the server's progress figures use: base + 40 * increment, "1/86400" is daily.
export function timeClassOf(timeControl: string | null): TimeClass | null {
  if (!timeControl) return null;
  if (timeControl.includes("/")) return "daily";
  const [base, increment] = timeControl.split("+").map(Number);
  if (base === undefined || Number.isNaN(base)) return null;
  const estimated = base + 40 * (increment ?? 0);
  if (estimated < 180) return "bullet";
  if (estimated < 600) return "blitz";
  return "rapid";
}

export function gradingCount(status: ImportStatus | null): number {
  return status ? status.pending + (status.running ? 1 : 0) : 0;
}
