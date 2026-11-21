import { z } from "zod";

// Which moves of a repertoire a line drill serves: `recommended` the due moves most likely to
// arise, at most ten; `due` every due move; `all` every move, due or not. A new move is due.
export const REPERTOIRE_SCOPES = ["recommended", "due", "all"] as const;
export const RepertoireScopeSchema = z.enum(REPERTOIRE_SCOPES);
export type RepertoireScope = z.infer<typeof RepertoireScopeSchema>;

// Where a line drill draws its moves from: one variation, every variation of that variation's
// group, every unit of its side, which the hub calls White openings, or every unit built from an
// opening the student's games met, which the hub calls Found in your games. A move two variations
// share is served once.
export const REPERTOIRE_LEVELS = ["variation", "group", "side", "found"] as const;
export const RepertoireLevelSchema = z.enum(REPERTOIRE_LEVELS);
export type RepertoireLevel = z.infer<typeof RepertoireLevelSchema>;

// How many moves a drill of each scope would serve right now.
export const RepertoireScopeCountsSchema = z.object({
  recommended: z.number().int().nonnegative(),
  due: z.number().int().nonnegative(),
  all: z.number().int().nonnegative(),
});
export type RepertoireScopeCounts = z.infer<typeof RepertoireScopeCountsSchema>;

// The style points a unit was built with: whole numbers the generator makes add up to 6, which is
// its rule to check and not the list's, since a stored split must stay readable if the rule moves.
export const RepertoireUnitPointsSchema = z.object({
  effectiveness: z.number().int().nonnegative(),
  soundness: z.number().int().nonnegative(),
  learnability: z.number().int().nonnegative(),
});
export type RepertoireUnitPoints = z.infer<typeof RepertoireUnitPointsSchema>;

// How much of a line the student remembered when the drill first asked about it: `of` first attempts
// in the last 30 days, `right` of them right. Nothing asked is 0 of 0.
export const RepertoireRememberedSchema = z.object({
  right: z.number().int().nonnegative(),
  of: z.number().int().nonnegative(),
});
export type RepertoireRemembered = z.infer<typeof RepertoireRememberedSchema>;

// How many of the student's reviewed games stayed in a line: `of` the games that reached it, `stayed`
// the ones that played every move it expected. A game that never reached the line, or was played as
// the other colour, is in neither count.
export const RepertoireInLineSchema = z.object({
  stayed: z.number().int().nonnegative(),
  of: z.number().int().nonnegative(),
});
export type RepertoireInLine = z.infer<typeof RepertoireInLineSchema>;

// The four numbers the Openings page shows besides the due counts, for a variation and for an
// opening, which is the group of its variations. For an opening they are taken over all its
// variations at once, a move two of them share counted once. `covered_percent` is null while nothing
// is stored.
export const RepertoireFiguresSchema = z.object({
  moves_total: z.number().int().nonnegative(),
  remembered_30d: RepertoireRememberedSchema,
  in_line: RepertoireInLineSchema,
  covered_percent: z.number().min(0).max(100).nullable(),
});
export type RepertoireFigures = z.infer<typeof RepertoireFiguresSchema>;

// Where a unit came from: `generated` for a unit the app's builder walked, which is every unit
// stored before the column existed, and `pgn` for a unit read from a PGN file. A unit read from a
// file stores no engine figure for its moves, so a reader of those figures has to tell the two apart.
export const RepertoireOriginSchema = z.enum(["generated", "pgn"]);
export type RepertoireOrigin = z.infer<typeof RepertoireOriginSchema>;

// `points`, `root` and `branch` say what the unit was built with and from, and a rebuild posts them
// again: `points` is null for a unit built before they were stored, `root` is the SAN list a unit of
// another opening starts from and null for a variation of the Italian, `branch` is the line a
// variation of the Italian was built at and null for any other unit. Posting a unit's `root` or
// `branch` with `rebuild` rebuilds that unit; posting neither rebuilds the first Italian variation.
// `line` is the moves that tell the variation from the others of its group, after the moves they all
// start with: "3...Bc5 4.d3" for the first Italian variation, the rest of the branch for one built at
// a branch point, "2.exd5" for a unit of another opening. It is null for a variation that is neither
// the first of its group nor built at a branch point, and for a first variation whose White move
// after the naming line is not stored yet. The server always sends the figures, `line`, `points`,
// `root`, `branch` and `origin`; a fixture need not carry them.
export const RepertoireSummarySchema = z.object({
  id: z.number().int().positive(),
  side: z.enum(["white", "black"]),
  group_name: z.string(),
  variation_name: z.string(),
  origin: RepertoireOriginSchema.optional(),
  moves: RepertoireScopeCountsSchema,
  ...RepertoireFiguresSchema.partial().shape,
  line: z.string().nullable().optional(),
  points: RepertoireUnitPointsSchema.nullable().optional(),
  root: z.array(z.string().min(1)).min(1).nullable().optional(),
  branch: z.array(z.string().min(1)).min(1).nullable().optional(),
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

// What a drill of a group, or of a whole side, would serve: a move shared by two variations counts once.
// `line` is the moves every variation of the group starts with, numbered from move 1: "1.e4 e5 2.Nf3
// Nc6 3.Bc4" for the Italian Game, "1.e4 d5" for a unit of another opening; null while no setup move
// is stored. The figures are those of `RepertoireFiguresSchema` over all the group's variations.
export const RepertoireGroupSummarySchema = z.object({
  side: z.enum(["white", "black"]),
  group_name: z.string(),
  moves: RepertoireScopeCountsSchema,
  ...RepertoireFiguresSchema.partial().shape,
  line: z.string().nullable().optional(),
});
export type RepertoireGroupSummary = z.infer<typeof RepertoireGroupSummarySchema>;

export const RepertoireSideSummarySchema = z.object({
  side: z.enum(["white", "black"]),
  moves: RepertoireScopeCountsSchema,
});
export type RepertoireSideSummary = z.infer<typeof RepertoireSideSummarySchema>;

// What a drill of the units found in games would serve: every unit whose id a met opening names,
// a move two of them share counted once, and a move the drill would hold back left out.
export const RepertoireFoundSummarySchema = z.object({
  moves: RepertoireScopeCountsSchema,
});
export type RepertoireFoundSummary = z.infer<typeof RepertoireFoundSummarySchema>;

// One of White's moves the book plays at a branch point. `variation_name` is the name a variation
// built with this move gets, and `repertoire_id` the variation that already plays it there, if any.
export const RepertoireBranchChoiceSchema = z.object({
  san: z.string().min(1),
  variation_name: z.string().min(1),
  repertoire_id: z.number().int().positive().nullable(),
});
export type RepertoireBranchChoice = z.infer<typeof RepertoireBranchChoiceSchema>;

// A position the group's first variation reaches where the book plays more than one White move.
// `line` is the moves from move 1 to that position, which ends on Black's move.
export const RepertoireBranchSchema = z.object({
  group_name: z.string(),
  line: z.array(z.string().min(1)).min(1),
  choices: z.array(RepertoireBranchChoiceSchema).min(2),
});
export type RepertoireBranch = z.infer<typeof RepertoireBranchSchema>;

// The body of GET /api/repertoires. `rebuilding_id` is the unit a rebuild is walking again, whose old
// rows serve until the walk ends, and null while none runs. The server always sends the group, side
// and found counts, the branch points and `rebuilding_id`; a fixture need not carry them.
export const RepertoiresResponseSchema = z.object({
  repertoires: z.array(RepertoireSummarySchema),
  groups: z.array(RepertoireGroupSummarySchema).optional(),
  sides: z.array(RepertoireSideSummarySchema).optional(),
  found: RepertoireFoundSummarySchema.optional(),
  met: z.array(MetOpeningSchema),
  branches: z.array(RepertoireBranchSchema).optional(),
  rebuilding_id: z.number().int().positive().nullable().optional(),
});
export type RepertoiresResponse = z.infer<typeof RepertoiresResponseSchema>;

// What the repertoire holds for one of Black's replies: an answer (covered), no answer where the
// reply is common enough to need one (gap), or no answer where it is too rare to matter.
export const COVERAGE_STATUSES = ["covered", "gap", "not_required"] as const;
export const CoverageStatusSchema = z.enum(COVERAGE_STATUSES);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

// How a stored reply entered the variation: fixed by the opening, popular in the explorer, past the
// goal as the most played or as the engine's, added by a game the student played, or read from a
// PGN file.
export const CoverageSourceSchema = z.enum([
  "setup",
  "explorer",
  "mainline",
  "engine",
  "game",
  "pgn",
]);
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
// from move 1 through that White move, `parent` the position before it on that line.
export const CoveragePositionSchema = z.object({
  line: z.array(z.string().min(1)).min(1),
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

// "3...Bc5 4.d3": moves written the way the book writes them, counted from the ply the first one is
// played at (0 for White's first move). White's moves carry their number; a Black move carries its
// number and three dots only where it opens the text, since White's number before it says the rest.
export function repertoireMovesText(moves: readonly string[], firstPly: number): string {
  return moves
    .map((san, index) => {
      const ply = firstPly + index;
      if (ply % 2 === 0) return `${ply / 2 + 1}.${san}`;
      return index === 0 ? `${(ply + 1) / 2}...${san}` : san;
    })
    .join(" ");
}

// "1.e4 e5 2.Nf3 Bc5": a line written the way the book writes it, which is also the name of a unit
// whose root the opening table does not name.
export function repertoireRootText(root: readonly string[]): string {
  return repertoireMovesText(root, 0);
}
