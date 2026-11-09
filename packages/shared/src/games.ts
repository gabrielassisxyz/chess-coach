import { z } from "zod";
import { ActivityMoveSchema } from "./activity.js";

// The two read-only game routes. A move carries the same fields the review activity does, plus
// the position after it, which is what lets the browser step through a game without the server.

export const WorstMomentSchema = z.object({
  ply: z.number().int().positive(),
  san: z.string(),
  cp_loss: z.number(),
  classification: z.enum(["best", "great", "good", "inaccuracy", "mistake", "blunder"]),
});
export type WorstMoment = z.infer<typeof WorstMomentSchema>;

// An entry of the Lichess openings table: the ECO code and the name of one position.
export const OpeningNameSchema = z.object({ eco: z.string(), name: z.string() });
export type OpeningName = z.infer<typeof OpeningNameSchema>;

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
  // The student ply with the largest loss (earliest on a tie); null while nothing is graded.
  worst_moment: WorstMomentSchema.nullable().default(null),
  // Review cards born from this game, and student plies marked mistake or blunder.
  cards_count: z.number().int().nonnegative().default(0),
  mistakes_count: z.number().int().nonnegative().default(0),
  // The last named position of the game in the openings table; null when no position is named.
  opening: OpeningNameSchema.nullable().default(null),
  source: z.enum(["coach", "chesscom", "pgn"]),
  source_url: z.string().nullable(),
  opponent: z.string().nullable(),
  student_rating: z.number().int().nullable(),
  opponent_rating: z.number().int().nullable(),
  time_control: z.string().nullable(),
  played_at: z.string().nullable(),
  // An imported game shows its moves without badges until the background grading is done.
  grading: z.enum(["pending", "running", "done", "failed"]),
});
// The four game-list fields above default on parse; the input type keeps them optional so a
// hand-built summary that predates them still typechecks.
export type GameSummary = z.input<typeof GameSummarySchema>;

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
export type GameDetail = z.input<typeof GameDetailSchema>;

export const GameDetailResponseSchema = z.object({ game: GameDetailSchema });
export type GameDetailResponse = z.infer<typeof GameDetailResponseSchema>;
