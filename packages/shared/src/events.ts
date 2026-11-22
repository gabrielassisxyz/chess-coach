import { z } from "zod";
import {
  ActivityStateSchema,
  ExpectedMoveSchema,
  PromotionSchema,
  TrainingItemSchema,
  TrainingModeSchema,
  TrainingStatusSchema,
  TrainingSummarySchema,
} from "./activity.js";
import { FoundPositionPhaseSchema, MAX_FOUND_POSITION_ID_LENGTH } from "./found-positions.js";
import { MAX_OPENING_FAMILY_LENGTH, OpeningTagSchema } from "./openings.js";
import {
  FOUND_DRILL_SCOPES,
  FoundDrillScopeSchema,
  RepertoireLevelSchema,
  RepertoireScopeSchema,
} from "./repertoires.js";

// The wire contract between server and browser. Every frame is validated on arrival by the side
// that receives it; a schema sits beside each type so the two cannot drift apart.

export const MAX_SAY_LENGTH = 4000;

const commandId = z.string().min(1).max(64);

// Each screen keeps its own conversation with the coach, so a puzzle reply never carries a whole
// day of unrelated games in its context.
export const COACH_TABS = ["play", "games", "practice"] as const;
export const CoachTabSchema = z.enum(COACH_TABS);
export type CoachTab = z.infer<typeof CoachTabSchema>;

export const ChatPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text_delta"), text: z.string() }),
  z.object({
    kind: z.literal("tool_use"),
    tool_use_id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    kind: z.literal("tool_result"),
    tool_use_id: z.string(),
    output: z.unknown(),
    is_error: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("turn_end"),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
  }),
  z.object({ kind: z.literal("turn_error"), message: z.string() }),
]);
export type ChatPayload = z.infer<typeof ChatPayloadSchema>;

// One persisted row of a tab's open conversation. `content` is the row's JSON, parsed by the
// server. A divider is a system text row whose content is `{ label, at }`.
export const TranscriptEntrySchema = z.object({
  id: z.number(),
  seq: z.number(),
  role: z.enum(["user", "assistant", "system"]),
  kind: z.enum(["text", "tool_use", "tool_result", "notification", "incomplete"]),
  content: z.unknown(),
  created_at: z.string(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

const TabTranscriptSchema = z.array(TranscriptEntrySchema);

export const BootstrapEventSchema = z.object({
  type: z.literal("bootstrap"),
  conversations: z.object({
    play: TabTranscriptSchema,
    games: TabTranscriptSchema,
    practice: TabTranscriptSchema,
  }),
  activity: ActivityStateSchema.nullable(),
  current_elo: z.number().int().optional(),
});
export type BootstrapEvent = z.infer<typeof BootstrapEventSchema>;

// message_id groups the deltas of one assistant message; seq orders every chat event of a server run.
export const ChatEventSchema = z.object({
  type: z.literal("chat"),
  tab: CoachTabSchema,
  message_id: z.number().int(),
  seq: z.number().int(),
  event: ChatPayloadSchema,
});
export type ChatEvent = z.infer<typeof ChatEventSchema>;

// A row written outside a coach turn (a divider) that every open page appends to that tab.
export const ChatRowEventSchema = z.object({
  type: z.literal("chat_row"),
  tab: CoachTabSchema,
  entry: TranscriptEntrySchema,
});
export type ChatRowEvent = z.infer<typeof ChatRowEventSchema>;

// The tab's conversation was closed and an empty one begins; every open page clears that tab.
export const ConversationStartedEventSchema = z.object({
  type: z.literal("conversation_started"),
  tab: CoachTabSchema,
});
export type ConversationStartedEvent = z.infer<typeof ConversationStartedEventSchema>;

export const PermissionRequestEventSchema = z.object({
  type: z.literal("permission_request"),
  request_id: z.string(),
  tool_name: z.string(),
  input: z.unknown(),
});
export type PermissionRequestEvent = z.infer<typeof PermissionRequestEventSchema>;

export const ErrorCodeSchema = z.enum([
  "invalid_json",
  "invalid_command",
  "unknown_request",
  "coach_error",
  "stale_activity",
  "not_in_demo",
  "not_in_review",
  "not_in_live_game",
  "demo_active",
  "live_game_active",
  "training_item_open",
  "game_not_found",
  "invalid_ply",
  "game_in_progress",
  "no_game",
  "not_player_turn",
  "illegal_move",
  "game_finished",
  "nothing_to_undo",
  "invalid_elo",
  "invalid_position",
  "invalid_line",
  "not_in_training",
  "empty_queue",
  "item_unfinished",
  "item_finished",
  "invalid_state",
  "card_not_found",
  "exposure_unknown",
  "exposure_used",
  "exposure_stale",
  "exposure_answered",
  "exposure_unanswered",
  "invalid_grade",
  "game_not_finished",
  "use_try_move",
  "not_exploring",
  "illegal_exploration",
  "unknown_opening",
  "engine_unavailable",
  "already_requested",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  code: ErrorCodeSchema,
  message: z.string(),
  command_id: commandId.optional(),
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

// `state` is null when nothing is on the board.
export const ActivityEventSchema = z.object({
  type: z.literal("activity"),
  state: ActivityStateSchema.nullable(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

// Sent beside the activity event whenever the training item or its status changes.
export const TrainingEventSchema = z.object({
  type: z.literal("training"),
  activity_id: z.number().int().positive(),
  mode: TrainingModeSchema,
  item: TrainingItemSchema,
  status: TrainingStatusSchema,
  expected: ExpectedMoveSchema.nullable(),
  summary: TrainingSummarySchema.nullable(),
});
export type TrainingEvent = z.infer<typeof TrainingEventSchema>;
export const CardsCreatedEventSchema = z.object({
  type: z.literal("cards_created"),
  game_id: z.number().int().positive(),
  count: z.number().int().nonnegative(),
});
export type CardsCreatedEvent = z.infer<typeof CardsCreatedEventSchema>;

// One engine line for a position: the moves, their SAN, and the score from White's side in
// centipawns (a mate reads as the mate score, 10000, with its sign).
export const AnalysisLineSchema = z.object({
  moves: z.array(z.string()),
  san: z.array(z.string()),
  score_cp: z.number(),
});
export type AnalysisLine = z.infer<typeof AnalysisLineSchema>;

// Where an analysis came from: a stored evaluation of the position, or a search run for it.
export const AnalysisSourceSchema = z.enum(["cache", "engine"]);
export type AnalysisSource = z.infer<typeof AnalysisSourceSchema>;

// The answer to an `analyse` command, sent to the connection that asked. `depth` is the depth the
// lines reached: below the one asked for only when `cutByTime` says the cap stopped the search,
// and above it when `source` is `cache`, which serves the deepest stored set that is deep enough.
export const AnalysisEventSchema = z.object({
  type: z.literal("analysis"),
  command_id: commandId.optional(),
  fen: z.string(),
  depth: z.number().int(),
  source: AnalysisSourceSchema,
  requested_lines: z.number().int(),
  cutByTime: z.boolean().optional(),
  lines: z.array(AnalysisLineSchema),
});
export type AnalysisEvent = z.infer<typeof AnalysisEventSchema>;

export const ServerEventSchema = z.discriminatedUnion("type", [
  AnalysisEventSchema,
  BootstrapEventSchema,
  ChatEventSchema,
  ChatRowEventSchema,
  ConversationStartedEventSchema,
  PermissionRequestEventSchema,
  ErrorEventSchema,
  ActivityEventSchema,
  TrainingEventSchema,
  CardsCreatedEventSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

export const SayCommandSchema = z.object({
  type: z.literal("say"),
  command_id: commandId,
  tab: CoachTabSchema,
  text: z.string().min(1).max(MAX_SAY_LENGTH),
});
export type SayCommand = z.infer<typeof SayCommandSchema>;

export const NewConversationCommandSchema = z.object({
  type: z.literal("new_conversation"),
  command_id: commandId,
  tab: CoachTabSchema,
});
export type NewConversationCommand = z.infer<typeof NewConversationCommandSchema>;

export const ApproveToolCommandSchema = z.object({
  type: z.literal("approve_tool"),
  command_id: commandId,
  request_id: z.string(),
  allow: z.boolean(),
});
export type ApproveToolCommand = z.infer<typeof ApproveToolCommandSchema>;

// A command that acts on the board may name the activity it was issued against; the server
// refuses it as stale when the board has since moved on, instead of applying it to the wrong one.
const activityId = z.number().int().positive().optional();
const square = z.string().regex(/^[a-h][1-8]$/);

export const OpenGameCommandSchema = z.object({
  type: z.literal("open_game"),
  command_id: commandId,
  game_id: z.number().int().positive(),
});

export const SelectReviewPlyCommandSchema = z.object({
  type: z.literal("select_review_ply"),
  command_id: commandId,
  game_id: z.number().int().positive(),
  ply: z.number().int().nonnegative(),
  activity_id: activityId,
});

export const LeaveDemoCommandSchema = z.object({
  type: z.literal("leave_demo"),
  command_id: commandId,
  activity_id: activityId,
});

// A click on a coach's line card in Practice; the server replays the line before showing it.
export const ShowLineCommandSchema = z.object({
  type: z.literal("show_line"),
  command_id: commandId,
  fen: z.string().min(1).max(120),
  moves: z.array(z.string().min(2).max(10)).max(100),
});

export const NewGameCommandSchema = z.object({
  type: z.literal("new_game"),
  command_id: commandId,
  color: z.enum(["white", "black"]),
  elo: z.number().int().optional(),
});

export const ResignCommandSchema = z.object({
  type: z.literal("resign"),
  command_id: commandId,
  activity_id: activityId,
});

export const AbortCommandSchema = z.object({
  type: z.literal("abort"),
  command_id: commandId,
  activity_id: activityId,
});

export const MoveCommandSchema = z.object({
  type: z.literal("move"),
  command_id: commandId,
  from: square,
  to: square,
  promotion: PromotionSchema.optional(),
  activity_id: activityId,
});

export const UndoCommandSchema = z.object({
  type: z.literal("undo"),
  command_id: commandId,
  activity_id: activityId,
});

// A repertoire drill names its repertoire and scope, and a level that widens it to that repertoire's
// group or side; without one it drills that variation alone. The other modes ignore all three. An
// opening drill may name one opening family of its colour, or UNNAMED_OPENING for the positions with
// no name; without one it drills every position of the colour. A drill of the positions from the
// student's games (`found`) may name one opening, a full name matching it exactly and a family
// matching every variation of it. A puzzle queue may name one Lichess opening tag instead of a
// motif. The other modes ignore `opening`.
// A drill of the positions from the student's games (`found`) cannot start without a scope, which
// is one of the three it has (`recommended`, `due`, `all`: `missed` belongs to the line drill), and
// `color`, `phase`, `position` (the id the From my games list gives) and `opening` narrow it;
// the other modes ignore `phase` and `position`, and all but the opening drill and a puzzle queue
// ignore `opening`.
// A queue has no size to choose: the object is strict so that a
// client still sending the retired `size` is refused instead of being served a queue it did not ask
// for.
const StartTrainingFieldsSchema = z.strictObject({
  type: z.literal("start_training"),
  command_id: commandId,
  mode: TrainingModeSchema,
  motif: z.string().min(1).max(64).optional(),
  color: z.enum(["white", "black"]).optional(),
  opening: z.string().min(1).max(120).optional(),
  repertoire_id: z.number().int().positive().optional(),
  scope: RepertoireScopeSchema.optional(),
  level: RepertoireLevelSchema.optional(),
  phase: FoundPositionPhaseSchema.optional(),
  position: z.string().min(1).max(MAX_FOUND_POSITION_ID_LENGTH).optional(),
});

// In mode puzzles `opening` is a Lichess opening tag, and the queue is drawn from that tag's puzzles
// alone, so a motif cannot narrow it as well.
function checkPuzzleQueueOpening(
  { mode, motif, opening }: z.infer<typeof StartTrainingFieldsSchema>,
  context: z.RefinementCtx,
): void {
  if (mode !== "puzzles" || opening === undefined) return;
  if (!OpeningTagSchema.safeParse(opening).success) {
    context.addIssue({
      code: "custom",
      path: ["opening"],
      message: "an opening tag holds only letters, digits, underscores and hyphens",
    });
  }
  if (motif !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["motif"],
      message: "a puzzle queue of one opening takes no motif",
    });
  }
}

export const StartTrainingCommandSchema = StartTrainingFieldsSchema.superRefine(
  (command, context) => {
    if (command.mode === "found" && command.scope === undefined) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "a drill of the positions from your games needs a scope",
      });
    }
    if (
      command.mode === "found" &&
      command.scope !== undefined &&
      !FoundDrillScopeSchema.safeParse(command.scope).success
    ) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: `a drill of the positions from your games takes one of ${FOUND_DRILL_SCOPES.join(", ")}`,
      });
    }
    if (
      command.mode === "openings" &&
      command.opening !== undefined &&
      command.opening.length > MAX_OPENING_FAMILY_LENGTH
    ) {
      context.addIssue({
        code: "custom",
        path: ["opening"],
        message: `opening must be at most ${MAX_OPENING_FAMILY_LENGTH} characters for an opening drill`,
      });
    }
    checkPuzzleQueueOpening(command, context);
  },
);

const uci = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/);

// Exploration is recorded and never graded; `try_move` is the only command that grades in training.
export const ExploreCommandSchema = z.object({
  type: z.literal("explore"),
  command_id: commandId,
  kind: z.enum(["move", "undo", "reset"]),
  uci: uci.optional(),
  activity_id: activityId,
});

// Graded the moment the piece is dropped; a wrong try leaves the item open for another.
export const TryMoveCommandSchema = z.object({
  type: z.literal("try_move"),
  command_id: commandId,
  uci,
  activity_id: activityId,
});

// Gives up on the open item: it ends as given up and the state carries the solution line.
export const ShowSolutionCommandSchema = z.object({
  type: z.literal("show_solution"),
  command_id: commandId,
  activity_id: activityId,
});

// Marks the origin square of the expected move at the current step; a hinted item never counts
// as solved first try.
export const HintCommandSchema = z.object({
  type: z.literal("hint"),
  command_id: commandId,
  activity_id: activityId,
});

// The student's hand drawings on the Practice board, sent when they change. Each shape is an
// arrow (with dest) or a circle (without), in one of the four drawing colours. At most 32 shapes
// travel in one snapshot; anything else is refused by validation.
export const DrawingColorSchema = z.enum(["green", "red", "blue", "yellow"]);
export type DrawingColor = z.infer<typeof DrawingColorSchema>;

export const DrawnShapeSchema = z.object({
  orig: square,
  dest: square.optional(),
  color: DrawingColorSchema,
});
export type DrawnShape = z.infer<typeof DrawnShapeSchema>;

export const MAX_DRAWING_SHAPES = 32;

export const DrawingsCommandSchema = z.object({
  type: z.literal("drawings"),
  command_id: commandId,
  activity_id: activityId,
  shapes: z.array(DrawnShapeSchema).max(MAX_DRAWING_SHAPES),
});
export type DrawingsCommand = z.infer<typeof DrawingsCommandSchema>;

// Asks the coach to comment on the ended item that was solved first try, which stays quiet until
// asked. Sent as its own command because a say would not tell the coach which position was solved.
export const AskCoachAboutItemCommandSchema = z.object({
  type: z.literal("ask_coach_about_item"),
  command_id: commandId,
  activity_id: activityId,
});

// Asks the engine about a position shown on the board, refused while a training item is open.
export const MAX_ANALYSIS_LINES = 5;
export const MIN_ANALYSIS_DEPTH = 8;
export const MAX_ANALYSIS_DEPTH = 24;
export const DEFAULT_ANALYSIS_DEPTH = 18;
// The search runs to the chosen depth and is stopped at this many milliseconds if that comes
// first, answering with the deepest layer it completed. A search with no cap that outlasts the
// engine's five seconds of slack is written off as hung and its process killed.
export const ANALYSIS_BUDGET_MS = 4000;
export const AnalyseCommandSchema = z.object({
  type: z.literal("analyse"),
  command_id: commandId,
  activity_id: activityId,
  fen: z.string().min(10).max(100),
  lines: z.number().int().min(1).max(MAX_ANALYSIS_LINES).optional(),
  depth: z.number().int().min(MIN_ANALYSIS_DEPTH).max(MAX_ANALYSIS_DEPTH).optional(),
});
export type AnalyseCommand = z.infer<typeof AnalyseCommandSchema>;

// A card is rated on FSRS's four grades: 1 Again, 2 Hard, 3 Good, 4 Easy. The schema is strict so
// that a client still sending the old 0 to 5 `quality` is refused, not silently read as ungraded.
export const RateCardCommandSchema = z.strictObject({
  type: z.literal("rate_card"),
  command_id: commandId,
  exposure_id: z.string().min(1).max(64),
  grade: z.number().int().min(1).max(4),
  activity_id: activityId,
});

export const NextTrainingItemCommandSchema = z.object({
  type: z.literal("next_training_item"),
  command_id: commandId,
  activity_id: activityId,
});

// Serves the ended puzzle on the board again from its first move, at the same place in the queue.
// The second play is practice: it is graded on the board and counts for nothing else.
export const RetryItemCommandSchema = z.object({
  type: z.literal("retry_item"),
  command_id: commandId,
  activity_id: activityId,
});

export const EndTrainingCommandSchema = z.object({
  type: z.literal("end_training"),
  command_id: commandId,
  activity_id: activityId,
});

// Marks every never-trained move of the running line drill's level as seen so every move after the
// one on screen is asked directly without its answer. Strict so unexpected fields are refused.
export const SkipFirstShowingsCommandSchema = z.strictObject({
  type: z.literal("skip_first_showings"),
  command_id: commandId,
  activity_id: activityId,
});

export const CreateCardsCommandSchema = z.object({
  type: z.literal("create_cards"),
  command_id: commandId,
  game_id: z.number().int().positive(),
});

export const AskCoachAboutPlyCommandSchema = z.object({
  type: z.literal("ask_coach_about_ply"),
  command_id: commandId,
  game_id: z.number().int().positive(),
  ply: z.number().int().positive(),
});

export const ClientCommandSchema = z.discriminatedUnion("type", [
  SayCommandSchema,
  NewConversationCommandSchema,
  ApproveToolCommandSchema,
  OpenGameCommandSchema,
  SelectReviewPlyCommandSchema,
  LeaveDemoCommandSchema,
  ShowLineCommandSchema,
  NewGameCommandSchema,
  ResignCommandSchema,
  AbortCommandSchema,
  MoveCommandSchema,
  UndoCommandSchema,
  StartTrainingCommandSchema,
  ExploreCommandSchema,
  TryMoveCommandSchema,
  ShowSolutionCommandSchema,
  HintCommandSchema,
  DrawingsCommandSchema,
  AskCoachAboutItemCommandSchema,
  RateCardCommandSchema,
  NextTrainingItemCommandSchema,
  RetryItemCommandSchema,
  EndTrainingCommandSchema,
  SkipFirstShowingsCommandSchema,
  CreateCardsCommandSchema,
  AskCoachAboutPlyCommandSchema,
  AnalyseCommandSchema,
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export type ActivityCommand = Exclude<
  ClientCommand,
  SayCommand | ApproveToolCommand | NewConversationCommand
>;
