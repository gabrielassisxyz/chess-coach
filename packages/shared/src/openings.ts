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

// One opening Black can leave the student's 1.e4 path with, as GET /api/openings/addable
// answers it. `root` is the line from move 1 through the Black move that leaves the path, in SAN,
// and passes the repertoire root check. `opening_name` is the book name of the position the root
// reaches, `family` its family. `games` counts the student's games that met this root, 0 when
// none did. `share_0_1199` is the share of Lichess explorer games at 0-1199 that choose the
// root's last move from its parent position, null when the explorer was not asked or failed.
// `repertoire_id` names the White unit already built from this root, if any.
export const AddableOpeningSchema = z.object({
  root: z.array(z.string().min(1)).min(1),
  opening_name: z.string().min(1),
  family: z.string().min(1),
  games: z.number().int().nonnegative(),
  share_0_1199: z.number().min(0).max(1).nullable(),
  repertoire_id: z.number().int().positive().nullable(),
});
export type AddableOpening = z.infer<typeof AddableOpeningSchema>;

// The body of GET /api/openings/addable: every addable opening, most played first.
export const AddableOpeningsResponseSchema = z.object({
  entries: z.array(AddableOpeningSchema),
});
export type AddableOpeningsResponse = z.infer<typeof AddableOpeningsResponseSchema>;
