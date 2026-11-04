import { z } from "zod";
import { ActivityMoveSchema } from "./activity.js";

// The two read-only game routes. A move carries the same fields the review activity does, plus
// the position after it, which is what lets the browser step through a game without the server.

export const GameSummarySchema = z.object({
  id: z.number().int(),
  started_at: z.string(),
  finished_at: z.string(),
  player_color: z.enum(["white", "black"]),
  target_elo: z.number().int(),
  result: z.enum(["1-0", "0-1", "1/2-1/2"]).nullable(),
  termination: z.enum(["checkmate", "stalemate", "draw", "resign", "abort"]).nullable(),
  move_count: z.number().int().nonnegative(),
  // Share of graded student moves with a cp loss of 30 or less; null when none was graded.
  accuracy: z.number().min(0).max(1).nullable(),
});
export type GameSummary = z.infer<typeof GameSummarySchema>;

export const GameListResponseSchema = z.object({ games: z.array(GameSummarySchema) });
export type GameListResponse = z.infer<typeof GameListResponseSchema>;

export const GameMoveSchema = ActivityMoveSchema.extend({ fen_after: z.string() });
export type GameMove = z.infer<typeof GameMoveSchema>;

export const GameDetailSchema = GameSummarySchema.omit({
  move_count: true,
  accuracy: true,
  finished_at: true,
}).extend({
  finished_at: z.string().nullable(),
  initial_fen: z.string(),
  moves: z.array(GameMoveSchema),
});
export type GameDetail = z.infer<typeof GameDetailSchema>;

export const GameDetailResponseSchema = z.object({ game: GameDetailSchema });
export type GameDetailResponse = z.infer<typeof GameDetailResponseSchema>;
