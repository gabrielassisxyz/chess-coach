import { z } from "zod";
import { RepertoireScopeSchema } from "./repertoires.js";

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

// Hours until the card is due again, for each quality the student could give it.
export const RatingPreviewSchema = z.object({
  "0": z.number(),
  "1": z.number(),
  "2": z.number(),
  "3": z.number(),
  "4": z.number(),
  "5": z.number(),
});
export type RatingPreview = z.infer<typeof RatingPreviewSchema>;

export const CardItemSchema = z.object({
  kind: z.literal("card"),
  card_id: z.number().int(),
  exposure_id: z.string(),
  prompt_fen: z.string(),
  student_color: ColorSchema,
  rating_preview: RatingPreviewSchema,
  ...queuePosition,
});

// `reply_uci` is the opponent move the server just played after a right answer in a multi-move puzzle.
// `rating` is the puzzle's difficulty rating; null when the library has none (opening drills).
export const PuzzleItemSchema = z.object({
  kind: z.literal("puzzle"),
  puzzle_id: z.string(),
  motif: z.string(),
  difficulty: z.string(),
  fen: z.string(),
  cursor: z.number().int().nonnegative(),
  reply_uci: z.string().nullable(),
  rating: z.number().int().nullable().optional(),
  opening_name: z.string().nullable().optional(),
  ...queuePosition,
});

// One pass over a repertoire line: `fen` is the position it starts from, move 1. The queue
// position counts passes, and `queue_length` grows when a missed move brings its line back.
export const RepertoireItemSchema = z.object({
  kind: z.literal("repertoire"),
  repertoire_id: z.number().int().positive(),
  fen: z.string(),
  ...queuePosition,
});

export const TrainingItemSchema = z.discriminatedUnion("kind", [
  CardItemSchema,
  PuzzleItemSchema,
  RepertoireItemSchema,
]);
export type TrainingItem = z.infer<typeof TrainingItemSchema>;

export const TrainingStatusSchema = z.enum(["prompt", "in_progress", "solved", "failed", "rated"]);
export type TrainingStatus = z.infer<typeof TrainingStatusSchema>;

export const TrainingModeSchema = z.enum(["srs", "puzzles", "openings", "repertoire"]);
export type TrainingMode = z.infer<typeof TrainingModeSchema>;

// The move the student should have played, shown once an item is answered wrong or finished.
export const ExpectedMoveSchema = z.object({ uci: z.string(), san: z.string().nullable() });
export type ExpectedMove = z.infer<typeof ExpectedMoveSchema>;

export const TrainingSummarySchema = z.object({
  solved: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type TrainingSummary = z.infer<typeof TrainingSummarySchema>;

// The student's scratch line on top of the served position. While the item is open, the board
// fields of a training item (turn, last_move, legal_moves) describe this position.
// `line_san` is the explored line after the event, empty after a reset; `at_ms` is measured from
// the moment the item was served.
export const ExploredEventSchema = z.object({
  seq: z.number().int().positive(),
  at_ms: z.number().int().nonnegative(),
  kind: z.enum(["move", "undo", "reset"]),
  line_san: z.array(z.string()),
});
export type ExploredEvent = z.infer<typeof ExploredEventSchema>;

export const ExploringSchema = z.object({
  fen: z.string(),
  line_san: z.array(z.string()),
  trail: z.array(ExploredEventSchema),
});
export type Exploring = z.infer<typeof ExploringSchema>;

// The latest graded try on the open item; a wrong one is what the board shows as "try again".
export const LastTrySchema = z.object({
  uci: z.string(),
  san: z.string().nullable(),
  correct: z.boolean(),
});
export type LastTry = z.infer<typeof LastTrySchema>;

// A move on the item's line from its start position: the student's right moves and the replies
// the puzzle played back, in order. `ply` is the solution index the move sits at.
export const PlayedMoveSchema = z.object({
  ply: z.number().int().nonnegative(),
  uci: z.string(),
  san: z.string(),
  by: z.enum(["student", "reply"]),
});
export type PlayedMove = z.infer<typeof PlayedMoveSchema>;

// A wrong try, kept beside the ply it was graded against.
export const WrongTrySchema = z.object({
  ply: z.number().int().nonnegative(),
  uci: z.string(),
  san: z.string().nullable(),
});
export type WrongTry = z.infer<typeof WrongTrySchema>;

export const QueueOutcomeSchema = z.enum(["solved", "failed", "current", "pending"]);
export type QueueOutcome = z.infer<typeof QueueOutcomeSchema>;

// What the hints have shown on the current move: the first gives the idea stored on its position,
// or a fixed sentence saying none is stored, and the second gives the move.
export const RepertoireHintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("idea"), text: z.string() }),
  z.object({ kind: z.literal("move"), uci: z.string(), san: z.string() }),
]);
export type RepertoireHint = z.infer<typeof RepertoireHintSchema>;

// Set when the drill has ended: every move it served, and how many were right at the first attempt.
export const RepertoireDrillResultSchema = z.object({
  practised: z.number().int().nonnegative(),
  first_try_right: z.number().int().nonnegative(),
});
export type RepertoireDrillResult = z.infer<typeof RepertoireDrillResultSchema>;

// What a repertoire drill adds to a training activity. `opening_name` names the current position.
// `first_pass` is set while the current move is shown for the first time, and `answer` is its move
// then; later passes hide it. `flagged_opening` names the other opening a good but unexpected try
// reached, cleared on the next try. A move is left until it is played right at the first attempt
// of a pass; right and wrong count how that first rated attempt went.
export const RepertoireDrillSchema = z.object({
  repertoire_id: z.number().int().positive(),
  scope: RepertoireScopeSchema,
  opening_name: z.string().nullable(),
  first_pass: z.boolean(),
  answer: ExpectedMoveSchema.nullable(),
  hint: RepertoireHintSchema,
  flagged_opening: z.string().nullable(),
  moves_left: z.number().int().nonnegative(),
  moves_right: z.number().int().nonnegative(),
  moves_wrong: z.number().int().nonnegative(),
  result: RepertoireDrillResultSchema.nullable(),
});
export type RepertoireDrill = z.infer<typeof RepertoireDrillSchema>;

// `summary` is set once the queue has ended; the last item then stays on the board, locked.
// `fen` is the position the current step is graded against. `tries` counts the wrong tries on the
// item. `solution_line` is set once the student gave up: the UCI moves from `fen` to the end.
// `suggested_quality` is the rating a finished card pre-selects, from how its first try went.
// `hint_square` is the origin square of the expected move after a hint, cleared on the next try.
export const TrainingActivitySchema = z.object({
  kind: z.literal("training"),
  ...boardFields,
  mode: TrainingModeSchema,
  item: TrainingItemSchema,
  status: TrainingStatusSchema,
  served_at: z.string(),
  exposure_id: z.string().optional(),
  // The motif filter the queue was started with; null for an Any-motif run, so the heading
  // can hide the pattern the student is meant to find. Absent from rows written before it existed.
  run_motif: z.string().nullable().optional(),
  expected: ExpectedMoveSchema.nullable(),
  exploring: ExploringSchema,
  tries: z.number().int().nonnegative(),
  last_try: LastTrySchema.nullable(),
  gave_up: z.boolean(),
  solution_line: z.array(z.string()).nullable(),
  suggested_quality: z.number().int().min(0).max(5).nullable(),
  hint_square: SquareSchema.nullable(),
  summary: TrainingSummarySchema.nullable(),
  // The line played so far and the wrong tries beside it, so the move list needs no replay of
  // the solution on the client; `queue_outcomes` has one entry per queue position.
  // `student_rating` is the student's puzzle rating and `rating_change` how this item moved it,
  // set once a rated puzzle ended. The server always sends these; a fixture need not carry them.
  moves: z.array(PlayedMoveSchema).optional(),
  wrong_tries: z.array(WrongTrySchema).optional(),
  queue_outcomes: z.array(QueueOutcomeSchema).optional(),
  student_rating: z.number().int().nullable().optional(),
  rating_change: z.number().int().nullable().optional(),
  // Present on a repertoire drill only.
  repertoire: RepertoireDrillSchema.optional(),
});

// A practice queue that is open but not on the board. `position` is the 0-based index of the item
// it stopped on and `size` the length of its queue, so the hub reads "position + 1 of size". A
// repertoire drill counts moves instead: `size` moves served, `position` of them finished, and it
// names its repertoire and scope.
export const PausedTrainingSchema = z.object({
  run_id: z.number().int().positive(),
  mode: TrainingModeSchema,
  motif: z.string().nullable(),
  color: ColorSchema.nullable(),
  position: z.number().int().nonnegative(),
  size: z.number().int().positive(),
  solved: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  repertoire_id: z.number().int().positive().optional(),
  scope: RepertoireScopeSchema.optional(),
});
export type PausedTraining = z.infer<typeof PausedTrainingSchema>;

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
