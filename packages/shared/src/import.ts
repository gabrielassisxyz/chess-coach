import { z } from "zod";

// Request and response shapes of the three import routes and the grading status.

export const ChessComListRequestSchema = z.object({
  username: z.string(),
  from: z.string(),
  to: z.string(),
});
export type ChessComListRequest = z.infer<typeof ChessComListRequestSchema>;

export const ChessComListedGameSchema = z.object({
  uuid: z.string(),
  url: z.string(),
  played_at: z.string(),
  opponent: z.string(),
  student_color: z.enum(["white", "black"]),
  result: z.enum(["1-0", "0-1", "1/2-1/2"]).nullable(),
  time_control: z.string().nullable(),
  student_rating: z.number().int().nullable(),
  opponent_rating: z.number().int().nullable(),
  already_imported: z.boolean(),
});
export type ChessComListedGame = z.infer<typeof ChessComListedGameSchema>;

export const ChessComListResponseSchema = z.object({ games: z.array(ChessComListedGameSchema) });
export type ChessComListResponse = z.infer<typeof ChessComListResponseSchema>;

export const ImportResultSchema = z.object({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  // Present only when some game could not be read; the rest of the batch still went in.
  failed: z.array(z.object({ id: z.string(), message: z.string() })).optional(),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

export const ImportStatusSchema = z.object({
  pending: z.number().int().nonnegative(),
  running: z
    .object({
      game_id: z.number().int(),
      graded_plies: z.number().int().nonnegative(),
      total_plies: z.number().int().nonnegative(),
    })
    .nullable(),
  failed: z.number().int().nonnegative(),
});
export type ImportStatus = z.infer<typeof ImportStatusSchema>;
