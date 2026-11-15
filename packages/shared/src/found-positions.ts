import { z } from "zod";

// The positions collected from the student's games, as the From my games page lists them and the
// `found` drill serves them. The accepted moves never travel: the list shows a position, the drill
// grades it on the server.

export const FOUND_POSITION_PHASES = ["opening", "middlegame", "endgame"] as const;
export const FoundPositionPhaseSchema = z.enum(FOUND_POSITION_PHASES);
export type FoundPositionPhase = z.infer<typeof FoundPositionPhaseSchema>;

// A position nothing has rated yet is new; a rated one is due once its review time has come.
export const FoundPositionStateSchema = z.enum(["new", "due", "scheduled"]);
export type FoundPositionState = z.infer<typeof FoundPositionStateSchema>;

// An `own:` id is 20 characters; the cap only keeps a pasted blob out of the queue builder.
export const MAX_FOUND_POSITION_ID_LENGTH = 64;

// `reached` holds the positions two or more games reached, `mistakes` every other listed one.
export const FoundPositionSectionSchema = z.enum(["reached", "mistakes"]);
export type FoundPositionSection = z.infer<typeof FoundPositionSectionSchema>;

const ColorSchema = z.enum(["white", "black"]);

/** The filters the list and the drill share; each narrows both the same way. */
export const FoundPositionsQuerySchema = z.object({
  color: ColorSchema.optional(),
  phase: FoundPositionPhaseSchema.optional(),
  // A full opening name matches it exactly; a value with no colon matches the family instead.
  opening: z.string().min(1).max(120).optional(),
});
export type FoundPositionsQuery = z.infer<typeof FoundPositionsQuerySchema>;

// The moves of the shown game that led to the position: from the first move, or the last four
// plies once the position is past ply 8, with the ply number of the first move held.
export const FoundPositionLineSchema = z.object({
  first_ply: z.number().int().positive(),
  san: z.array(z.string()),
});
export type FoundPositionLine = z.infer<typeof FoundPositionLineSchema>;

// The game shown beside the position and the ply of the student's move in it. `played_at` is when
// the game was played, or when it ended for a game with no date of its own; both are null once the
// game itself is gone.
export const FoundPositionGameSchema = z.object({
  id: z.number().int(),
  ply: z.number().int().positive(),
  opponent: z.string().nullable(),
  played_at: z.string().nullable(),
});
export type FoundPositionGame = z.infer<typeof FoundPositionGameSchema>;

export const FoundPositionViewSchema = z.object({
  id: z.string(),
  fen: z.string(),
  color: ColorSchema,
  phase: FoundPositionPhaseSchema,
  section: FoundPositionSectionSchema,
  from_mistake: z.boolean(),
  from_departure: z.boolean(),
  opening_name: z.string().nullable(),
  line: FoundPositionLineSchema,
  reached_games: z.number().int().nonnegative(),
  best_games: z.number().int().nonnegative(),
  last_reached_at: z.string(),
  game: FoundPositionGameSchema,
  state: FoundPositionStateSchema,
  next_review_at: z.string().nullable(),
});
export type FoundPositionView = z.infer<typeof FoundPositionViewSchema>;

// `total`, `due`, `new`, `recommended`, `all` and `left_out` follow every filter; `recommended`,
// `due` and `all` are the lengths of the queues those drills would serve now. `by_phase` and
// `by_section` follow the colour and the opening, so the phase filter can show what each choice
// holds.
export const FoundPositionCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  due: z.number().int().nonnegative(),
  new: z.number().int().nonnegative(),
  recommended: z.number().int().nonnegative(),
  all: z.number().int().nonnegative(),
  by_phase: z.object({
    opening: z.number().int().nonnegative(),
    middlegame: z.number().int().nonnegative(),
    endgame: z.number().int().nonnegative(),
  }),
  by_section: z.object({
    reached: z.number().int().nonnegative(),
    mistakes: z.number().int().nonnegative(),
  }),
  left_out: z.number().int().nonnegative(),
});
export type FoundPositionCounts = z.infer<typeof FoundPositionCountsSchema>;

// The page's order: section `reached` first, and inside a section the order the `all` drill serves.
export const FoundPositionsResponseSchema = z.object({
  positions: z.array(FoundPositionViewSchema),
  counts: FoundPositionCountsSchema,
});
export type FoundPositionsResponse = z.infer<typeof FoundPositionsResponseSchema>;
