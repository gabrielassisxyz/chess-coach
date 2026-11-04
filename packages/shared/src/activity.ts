import { z } from "zod";

// What the board is showing right now. The server owns it and broadcasts every change; the
// browser only renders it. Each kind has its own board and mutation rules, so a command is
// always read against the kind that is current (and refused when it names a stale activity_id).

export const ACTIVITY_KINDS = ["live_game", "review", "training", "demo"] as const;
export const ActivityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

const ColorSchema = z.enum(["white", "black"]);
const SquareSchema = z.string().regex(/^[a-h][1-8]$/);
export const PromotionSchema = z.enum(["q", "r", "b", "n"]);
export type PromotionPiece = z.infer<typeof PromotionSchema>;

// Promotions to one square are one entry carrying every piece, never four.
export const LegalMoveSchema = z.object({
  from: SquareSchema,
  to: SquareSchema,
  promotions: z.array(PromotionSchema).optional(),
});
export type LegalMoveEntry = z.infer<typeof LegalMoveSchema>;

export const PendingSchema = z.enum(["none", "evaluating", "engine_thinking", "grading"]);
export type Pending = z.infer<typeof PendingSchema>;

export const ActivityMoveSchema = z.object({
  ply: z.number().int(),
  san: z.string(),
  uci: z.string(),
  is_player: z.boolean(),
  eval_before_cp: z.number().nullable(),
  eval_after_cp: z.number().nullable(),
  cp_loss: z.number().nullable(),
  classification: z.enum(["best", "great", "good", "inaccuracy", "mistake", "blunder"]).nullable(),
  best_move_san: z.string().nullable(),
});
export type ActivityMove = z.infer<typeof ActivityMoveSchema>;

const GameResultSchema = z.enum(["1-0", "0-1", "1/2-1/2"]);
const TerminationSchema = z.enum(["checkmate", "stalemate", "draw", "resign", "abort"]);

const boardFields = {
  activity_id: z.number().int().positive(),
  orientation: ColorSchema,
  fen: z.string(),
  turn: ColorSchema,
  last_move: z.object({ from: SquareSchema, to: SquareSchema }).nullable(),
  legal_moves: z.array(LegalMoveSchema),
  input_enabled: z.boolean(),
  pending: PendingSchema,
};

export const LiveGameActivitySchema = z.object({
  kind: z.literal("live_game"),
  ...boardFields,
  game_id: z.number().int(),
  phase: z.enum(["player_turn", "evaluating", "engine_turn", "finished"]),
  moves: z.array(ActivityMoveSchema),
  material: z.object({ white: z.number(), black: z.number() }),
  result: GameResultSchema.nullable(),
  termination: TerminationSchema.nullable(),
});

export const ReviewActivitySchema = z.object({
  kind: z.literal("review"),
  ...boardFields,
  game: z.object({
    id: z.number().int(),
    moves: z.array(ActivityMoveSchema),
    result: GameResultSchema.nullable(),
  }),
  // 0 is the starting position; N is the position after ply N.
  selected_ply: z.number().int().nonnegative(),
});

const queuePosition = {
  position_in_queue: z.number().int().positive(),
  queue_length: z.number().int().positive(),
};

export const CardItemSchema = z.object({
  kind: z.literal("card"),
  card_id: z.number().int(),
  exposure_id: z.string(),
  prompt_fen: z.string(),
  student_color: ColorSchema,
  ...queuePosition,
});

// `reply_uci` is the opponent move the server just played after a right answer in a multi-move puzzle.
export const PuzzleItemSchema = z.object({
  kind: z.literal("puzzle"),
  puzzle_id: z.string(),
  motif: z.string(),
  difficulty: z.string(),
  fen: z.string(),
  cursor: z.number().int().nonnegative(),
  reply_uci: z.string().nullable(),
  ...queuePosition,
});

export const TrainingItemSchema = z.discriminatedUnion("kind", [CardItemSchema, PuzzleItemSchema]);
export type TrainingItem = z.infer<typeof TrainingItemSchema>;

export const TrainingStatusSchema = z.enum(["prompt", "in_progress", "solved", "failed", "rated"]);
export type TrainingStatus = z.infer<typeof TrainingStatusSchema>;

export const TrainingModeSchema = z.enum(["srs", "puzzles"]);
export type TrainingMode = z.infer<typeof TrainingModeSchema>;

// The move the student should have played, shown once an item is answered wrong or finished.
export const ExpectedMoveSchema = z.object({ uci: z.string(), san: z.string().nullable() });
export type ExpectedMove = z.infer<typeof ExpectedMoveSchema>;

export const TrainingSummarySchema = z.object({
  solved: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type TrainingSummary = z.infer<typeof TrainingSummarySchema>;

// `summary` is set once the queue has ended; the last item then stays on the board, locked.
export const TrainingActivitySchema = z.object({
  kind: z.literal("training"),
  ...boardFields,
  mode: TrainingModeSchema,
  item: TrainingItemSchema,
  status: TrainingStatusSchema,
  exposure_id: z.string().optional(),
  expected: ExpectedMoveSchema.nullable(),
  summary: TrainingSummarySchema.nullable(),
});

export const DemoActivitySchema = z.object({
  kind: z.literal("demo"),
  ...boardFields,
  returns_to: ActivityKindSchema.nullable(),
  moves_played: z.array(z.string()),
});

export const ActivityStateSchema = z.discriminatedUnion("kind", [
  LiveGameActivitySchema,
  ReviewActivitySchema,
  TrainingActivitySchema,
  DemoActivitySchema,
]);
export type ActivityState = z.infer<typeof ActivityStateSchema>;
export type LiveGameActivity = z.infer<typeof LiveGameActivitySchema>;
export type ReviewActivity = z.infer<typeof ReviewActivitySchema>;
export type TrainingActivity = z.infer<typeof TrainingActivitySchema>;
export type DemoActivity = z.infer<typeof DemoActivitySchema>;
