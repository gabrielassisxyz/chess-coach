import { z } from "zod";

export const OPENING_DRILL_COLORS = ["white", "black"] as const;
export const OpeningDrillColorSchema = z.enum(OPENING_DRILL_COLORS);
export type OpeningDrillColor = z.infer<typeof OpeningDrillColorSchema>;

// The family of an opening name is the text before its first colon, so "Italian Game: Two Knights
// Defense" belongs to "Italian Game": the full name is too fine to drill. A name with no colon is its
// own family; a blank one has none.
export function openingFamilyOf(openingName: string | null): string | null {
  if (openingName === null) return null;
  const colon = openingName.indexOf(":");
  const family = (colon === -1 ? openingName : openingName.slice(0, colon)).trim();
  return family === "" ? null : family;
}

// What a start sends for the positions that carry no opening name. A family never holds a colon,
// being the text before the first one, so a value with a colon cannot be taken for a family.
export const UNNAMED_OPENING = "unnamed:";

// The longest family a start may name; the book's longest is far below it.
export const MAX_OPENING_FAMILY_LENGTH = 100;

// One opening family of a colour's drill, or the positions with no name. `opening` is what a start
// sends back, and is the family itself unless it is UNNAMED_OPENING. The attempts and the first-try
// solves are those of the last 30 days; `repertoire_id` is the first variation of the stored opening
// of that name on the same side, null when none is stored.
export const OpeningDrillSchema = z.object({
  opening: z.string().min(1),
  positions: z.number().int().positive(),
  attempts_30d: z.number().int().nonnegative(),
  first_try_30d: z.number().int().nonnegative(),
  repertoire_id: z.number().int().positive().nullable(),
});
export type OpeningDrill = z.infer<typeof OpeningDrillSchema>;

// The body of GET /api/openings/drills: the drills from the student's games, a colour at a time.
export const OpeningDrillsResponseSchema = z.object({
  white: z.array(OpeningDrillSchema),
  black: z.array(OpeningDrillSchema),
});
export type OpeningDrillsResponse = z.infer<typeof OpeningDrillsResponseSchema>;
