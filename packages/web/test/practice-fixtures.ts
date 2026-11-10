import type {
  PlayedMove,
  ProgressResponse,
  RepertoireDrill,
  RepertoireSummary,
  TrainingActivity,
} from "@chess-coach/shared";
import { Chess } from "chess.js";
import { legalMovesOf, START_FEN } from "./fixtures.js";

type Cards = ProgressResponse["cards"];

export function progressOf(cards: Partial<Cards> = {}): ProgressResponse {
  return {
    rating_history: [],
    games: [],
    puzzles_by_motif: [
      {
        motif: "fork",
        attempts: 40,
        solved: 28,
        success_rate: 0.7,
        attempts_30d: 14,
        solved_30d: 10,
        success_rate_30d: 10 / 14,
      },
      {
        motif: "pin",
        attempts: 5,
        solved: 1,
        success_rate: 0.2,
        attempts_30d: 0,
        solved_30d: 0,
        success_rate_30d: null,
      },
    ],
    cards: {
      total: 38,
      due_now: 4,
      reviewed_7d: 9,
      correct_rate_7d: 0.8,
      due_by_classification: { blunder: 2, mistake: 1, teaching: 1, inaccuracy: 0 },
      due_from_games: 3,
      next_due_at: "2026-03-02T07:00:00.000Z",
      next_due_count: 3,
      correct_rate_30d: 0.83,
      ...cards,
    },
    streak_days: 2,
    difficulty: { current_elo: 1200, last_change: null },
  };
}

export const motifCounts = [
  { motif: "fork", count: 28 },
  { motif: "pin", count: 9 },
  { motif: "smothered-mate", count: 0 },
  { motif: "opening-white", count: 12 },
  { motif: "opening-black", count: 0 },
];

export const CLASSICAL_VARIATION = "Classical Variation (4.c3)";

export const italianRepertoire: RepertoireSummary = {
  id: 3,
  side: "white",
  group_name: "Italian Game",
  variation_name: CLASSICAL_VARIATION,
  moves: { recommended: 10, due: 14, all: 38 },
};

export const repertoireList: RepertoireSummary[] = [italianRepertoire];

// The moves the server plays on the student's behalf before the first move it asks for.
export const ITALIAN_APPROACH = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"];

export interface RepertoireActivityOptions {
  // The line on the board, played by the server; the next move is the one asked.
  sans?: string[];
  training?: Partial<TrainingActivity>;
  drill?: Partial<RepertoireDrill>;
}

// A repertoire drill stopped on a move to find: later pass, no hint, nothing wrong yet.
export function repertoireActivity(options: RepertoireActivityOptions = {}): TrainingActivity {
  const board = new Chess();
  const moves: PlayedMove[] = (options.sans ?? ITALIAN_APPROACH).map((san, ply) => {
    const played = board.move(san);
    return { ply, uci: `${played.from}${played.to}${played.promotion ?? ""}`, san, by: "reply" };
  });
  const fen = board.fen();
  const last = moves.at(-1);
  return {
    kind: "training",
    activity_id: 6,
    orientation: "white",
    fen,
    turn: board.turn() === "w" ? "white" : "black",
    last_move: last ? { from: last.uci.slice(0, 2), to: last.uci.slice(2, 4) } : null,
    legal_moves: legalMovesOf(fen),
    input_enabled: true,
    pending: "none",
    mode: "repertoire",
    item: {
      kind: "repertoire",
      repertoire_id: 3,
      fen: START_FEN,
      position_in_queue: 1,
      queue_length: 3,
    },
    status: "prompt",
    served_at: "2026-03-01T00:00:00.000Z",
    run_motif: null,
    expected: null,
    exploring: { fen, line_san: [], trail: [] },
    tries: 0,
    last_try: null,
    gave_up: false,
    solution_line: null,
    suggested_quality: null,
    hint_square: null,
    summary: null,
    moves,
    wrong_tries: [],
    queue_outcomes: ["current", "pending", "pending"],
    student_rating: 1200,
    rating_change: null,
    repertoire: {
      repertoire_id: 3,
      scope: "recommended",
      opening_name: "Italian Game: Giuoco Piano",
      first_pass: false,
      answer: null,
      hint: { kind: "none" },
      flagged_opening: null,
      moves_left: 4,
      moves_right: 0,
      moves_wrong: 0,
      result: null,
      ...options.drill,
    },
    ...options.training,
  };
}
