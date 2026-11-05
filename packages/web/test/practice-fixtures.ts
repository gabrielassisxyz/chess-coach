import type { ProgressResponse } from "@chess-coach/shared";

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
