import { z } from "zod";

// One object for the Progress page and the coach's get_progress, so both read the same numbers.

export const RatingPointSchema = z.object({
  played_at: z.string(),
  rating: z.number().int(),
  // Derived from the Chess.com time control; null when the import carried none.
  time_class: z.enum(["bullet", "blitz", "rapid", "daily"]).nullable(),
});

export const ProgressGameSchema = z.object({
  id: z.number().int(),
  played_at: z.string(),
  source: z.enum(["coach", "chesscom", "pgn"]),
  result: z.enum(["1-0", "0-1", "1/2-1/2"]).nullable(),
  // Share of graded student plies with a cp loss of 30 or less; null when none was graded.
  accuracy: z.number().min(0).max(1).nullable(),
  blunders: z.number().int().nonnegative(),
  mistakes: z.number().int().nonnegative(),
});

export const MotifProgressSchema = z.object({
  motif: z.string(),
  attempts: z.number().int().nonnegative(),
  solved: z.number().int().nonnegative(),
  success_rate: z.number().min(0).max(1),
  attempts_30d: z.number().int().nonnegative(),
  // Solved on the first try, so `success_rate_30d` is accuracy rather than completion.
  solved_30d: z.number().int().nonnegative(),
  // Null when the motif has no attempt in the last 30 days.
  success_rate_30d: z.number().min(0).max(1).nullable(),
});

export const CardProgressSchema = z.object({
  total: z.number().int().nonnegative(),
  due_now: z.number().int().nonnegative(),
  reviewed_7d: z.number().int().nonnegative(),
  correct_rate_7d: z.number().min(0).max(1).nullable(),
  // Due cards by classification; cards without one count under "teaching".
  due_by_classification: z.record(z.string(), z.number().int().nonnegative()),
  due_from_games: z.number().int().nonnegative(),
  // Earliest review strictly after now, and how many cards fall due within an hour of it.
  next_due_at: z.string().nullable(),
  next_due_count: z.number().int().nonnegative(),
  correct_rate_30d: z.number().min(0).max(1).nullable(),
});

export const DifficultyProgressSchema = z.object({
  current_elo: z.number().int(),
  last_change: z
    .object({ to_elo: z.number().int(), reason: z.string(), changed_at: z.string() })
    .nullable(),
});

export const ProgressResponseSchema = z.object({
  rating_history: z.array(RatingPointSchema),
  games: z.array(ProgressGameSchema),
  puzzles_by_motif: z.array(MotifProgressSchema),
  cards: CardProgressSchema,
  streak_days: z.number().int().nonnegative(),
  difficulty: DifficultyProgressSchema,
});
export type ProgressResponse = z.infer<typeof ProgressResponseSchema>;
export type ProgressGame = z.infer<typeof ProgressGameSchema>;
export type RatingPoint = z.infer<typeof RatingPointSchema>;

/** What the coach reads: the same object without the game list, plus how many games there are. */
export type CoachProgress = Omit<ProgressResponse, "games"> & { games_played: number };
