import { z } from "zod";

// Which moves of a repertoire a line drill serves: `recommended` the due moves most likely to
// arise, at most ten; `due` every due move; `all` every move, due or not. A new move is due.
export const REPERTOIRE_SCOPES = ["recommended", "due", "all"] as const;
export const RepertoireScopeSchema = z.enum(REPERTOIRE_SCOPES);
export type RepertoireScope = z.infer<typeof RepertoireScopeSchema>;

// How many moves a drill of each scope would serve right now.
export const RepertoireScopeCountsSchema = z.object({
  recommended: z.number().int().nonnegative(),
  due: z.number().int().nonnegative(),
  all: z.number().int().nonnegative(),
});
export type RepertoireScopeCounts = z.infer<typeof RepertoireScopeCountsSchema>;

export const RepertoireSummarySchema = z.object({
  id: z.number().int().positive(),
  side: z.enum(["white", "black"]),
  group_name: z.string(),
  variation_name: z.string(),
  moves: RepertoireScopeCountsSchema,
});
export type RepertoireSummary = z.infer<typeof RepertoireSummarySchema>;

// An opening the student's reviewed games met: Black left the stored Italian line with this move
// and played on. `root` is the line from move 1 through that move, in SAN, and is what a drill for
// it is built from. `repertoire_id` names the unit already built from the same root, if any.
export const MetOpeningSchema = z.object({
  root: z.array(z.string().min(1)).min(1),
  opening_name: z.string().nullable(),
  games: z.number().int().positive(),
  repertoire_id: z.number().int().positive().nullable(),
});
export type MetOpening = z.infer<typeof MetOpeningSchema>;

// The body of GET /api/repertoires.
export const RepertoiresResponseSchema = z.object({
  repertoires: z.array(RepertoireSummarySchema),
  met: z.array(MetOpeningSchema),
});
export type RepertoiresResponse = z.infer<typeof RepertoiresResponseSchema>;

// What the repertoire holds for one of Black's replies: an answer (covered), no answer where the
// reply is common enough to need one (gap), or no answer where it is too rare to matter.
export const COVERAGE_STATUSES = ["covered", "gap", "not_required"] as const;
export const CoverageStatusSchema = z.enum(COVERAGE_STATUSES);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

// How a stored reply entered the variation, as the generator names it.
export const CoverageSourceSchema = z.enum(["setup", "explorer", "mainline", "engine"]);
export type CoverageSource = z.infer<typeof CoverageSourceSchema>;

// One of Black's replies in a position. `incidence` is the chance a game reaches the position the
// reply makes, counted from where the variation starts; 0 where no game is known to have played it.
// `next` is the index in `positions` of the position White answers from, null with no answer.
export const CoverageReplySchema = z.object({
  san: z.string().min(1),
  incidence: z.number().min(0).max(1),
  status: CoverageStatusSchema,
  source: CoverageSourceSchema,
  next: z.number().int().nonnegative().nullable(),
});
export type CoverageReply = z.infer<typeof CoverageReplySchema>;

// A position with Black to move, reached by White's move of the repertoire. `line` is the moves
// from move 1 through that White move, `parent` the position it was first reached from.
export const CoveragePositionSchema = z.object({
  line: z.array(z.string().min(1)).min(1),
  incidence: z.number().min(0).max(1),
  parent: z.number().int().nonnegative().nullable(),
  replies: z.array(CoverageReplySchema),
});
export type CoveragePosition = z.infer<typeof CoveragePositionSchema>;

// A reply with no answer where one is needed. `line` runs through the reply, and `position` is the
// index in `positions` of the position Black replied in.
export const CoverageGapSchema = z.object({
  line: z.array(z.string().min(1)).min(1),
  incidence: z.number().min(0).max(1),
  position: z.number().int().nonnegative(),
});
export type CoverageGap = z.infer<typeof CoverageGapSchema>;

// Both scores read what the generator stored. Each is null when no line reaches a position with
// enough games to say anything.
export const CoverageScoresSchema = z.object({
  line_ends: z.number().int().nonnegative(),
  // Percent with one decimal: the weighted result White scores at the student's rating.
  expected_score: z.number().min(0).max(100).nullable(),
  // 1 to 99: how little the engine says the lines give up beyond a small allowance per move.
  soundness: z.number().min(1).max(99).nullable(),
});
export type CoverageScores = z.infer<typeof CoverageScoresSchema>;

// The body of GET /api/repertoires/:id/coverage.
export const RepertoireCoverageSchema = z.object({
  repertoire_id: z.number().int().positive(),
  // A reply needs an answer when it arises in at least 1 game in this many.
  goal_one_in: z.number().int().positive(),
  // The rating band the results and the incidences come from.
  rating_band: z.string().min(1),
  // Percent with one decimal of the games that stay above the goal and end in a prepared line
  // instead of a gap; null when nothing is stored.
  covered_percent: z.number().min(0).max(100).nullable(),
  // Most likely first.
  gaps: z.array(CoverageGapSchema),
  largest_gap: CoverageGapSchema.nullable(),
  scores: CoverageScoresSchema,
  // The position to open first: where the variation starts choosing among Black's replies.
  start: z.number().int().nonnegative(),
  positions: z.array(CoveragePositionSchema),
});
export type RepertoireCoverage = z.infer<typeof RepertoireCoverageSchema>;

// "1.e4 e5 2.Nf3 Bc5": a line written the way the book writes it, which is also the name of a unit
// whose root the opening table does not name.
export function repertoireRootText(root: readonly string[]): string {
  return root.map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}.${san}` : san)).join(" ");
}
