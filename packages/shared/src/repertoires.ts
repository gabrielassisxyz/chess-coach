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

// The body of GET /api/repertoires.
export const RepertoiresResponseSchema = z.object({
  repertoires: z.array(RepertoireSummarySchema),
});
export type RepertoiresResponse = z.infer<typeof RepertoiresResponseSchema>;
