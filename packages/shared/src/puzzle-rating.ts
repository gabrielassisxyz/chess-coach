import { z } from "zod";

// Valid window lengths for `GET /api/puzzles/rating/history`: last N days or since the first rated attempt.
export const PUZZLE_RATING_WINDOWS = ["7", "30", "90", "all"] as const;
export const PuzzleRatingWindowSchema = z.enum(PUZZLE_RATING_WINDOWS);
export type PuzzleRatingWindow = z.infer<typeof PuzzleRatingWindowSchema>;

// One local calendar day (`YYYY-MM-DD`) and the student's Elo puzzle rating at the end of that day.
export const PuzzleRatingPointSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rating: z.number().int(),
});
export type PuzzleRatingPoint = z.infer<typeof PuzzleRatingPointSchema>;

// Daily puzzle rating history over the requested window, paired with the stored current rating.
export const PuzzleRatingHistoryResponseSchema = z.object({
  current: z.number().int(),
  points: z.array(PuzzleRatingPointSchema).min(1),
  low: z.number().int(),
  high: z.number().int(),
  change: z.number().int(),
});
export type PuzzleRatingHistoryResponse = z.infer<typeof PuzzleRatingHistoryResponseSchema>;
