import type {
  FoundPositionCounts,
  FoundPositionsResponse,
  FoundPositionView,
  PlayedMove,
  ProgressResponse,
  RepertoireDrill,
  RepertoireSummary,
  TrainingActivity,
} from "@chess-coach/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { Chess } from "chess.js";
import { legalMovesOf, START_FEN } from "./fixtures.js";

// Chooses an entry of the Practice hub's navigation by its name, which on Openings may go on with a
// count of the moves due.
export function openPracticePage(name: string): void {
  const nav = screen.getByRole("navigation", { name: "Practice sections" });
  fireEvent.click(within(nav).getByRole("button", { name: new RegExp(`^${name}(,|$)`) }));
}

type Cards = ProgressResponse["cards"];

export function progressOf(cards: Partial<Cards> = {}, puzzleRating = 1200): ProgressResponse {
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
      due_next_7d: [4, 1, 0, 2, 0, 0, 0],
      correct_rate_prev_30d: 0.75,
      ...cards,
    },
    streak_days: 2,
    streak_best: 11,
    activity_7d: [false, false, false, false, false, true, true],
    difficulty: { current_elo: 1200, last_change: null },
    puzzle_rating: puzzleRating,
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
      flagged_sound: false,
      moves_left: 4,
      moves_right: 0,
      moves_wrong: 0,
      result: null,
      ...options.drill,
    },
    ...options.training,
  };
}

// A position from the student's games as the From my games list holds it: a repeated opening
// position, new, with the moves that led to it and the game it was shown from.
export function foundPosition(overrides: Partial<FoundPositionView> = {}): FoundPositionView {
  return {
    id: "own:aaaaaaaaaaaaaaaa",
    fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2",
    color: "white",
    phase: "opening",
    section: "reached",
    from_mistake: false,
    from_departure: false,
    opening_name: "King's Pawn Game",
    line: { first_ply: 1, san: ["e4", "e5"] },
    reached_games: 6,
    best_games: 3,
    last_reached_at: "2026-02-20T12:00:00.000Z",
    game: { id: 4, ply: 3, opponent: "Whambalee", played_at: "2026-02-20T12:00:00.000Z" },
    state: "new",
    next_review_at: null,
    ...overrides,
  };
}

// An answer whose counts follow from its positions, as the server's do, unless a test sets one.
export function foundResponse(
  positions: FoundPositionView[],
  counts: Partial<FoundPositionCounts> = {},
): FoundPositionsResponse {
  const inState = (state: FoundPositionView["state"]): number =>
    positions.filter((position) => position.state === state).length;
  const inPhase = (phase: FoundPositionView["phase"]): number =>
    positions.filter((position) => position.phase === phase).length;
  const reached = positions.filter((position) => position.section === "reached").length;
  return {
    positions,
    counts: {
      total: positions.length,
      due: inState("due"),
      new: inState("new"),
      recommended: Math.min(inState("due") + inState("new"), 10),
      all: positions.length,
      by_phase: {
        opening: inPhase("opening"),
        middlegame: inPhase("middlegame"),
        endgame: inPhase("endgame"),
      },
      by_section: { reached, mistakes: positions.length - reached },
      left_out: 0,
      ...counts,
    },
  };
}

export const noFoundPositions: FoundPositionsResponse = foundResponse([]);
