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

// "1.e4 e5 2.Nf3 Bc5": a line written the way the book writes it, which is also the name of a unit
// whose root the opening table does not name.
export function repertoireRootText(root: readonly string[]): string {
  return root.map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}.${san}` : san)).join(" ");
}
