// Counted games by opening and variation, per colour, as GET /api/openings/played answers it.
// An opening groups the games whose last named position shares a family; a variation groups those
// that share the full name. Figures are from the student's side. `line` is the moves of the most
// recent game of the entry, as numbered SAN, up to the position that first names the family for an
// opening and up to the last named position for a variation.

import { z } from "zod";

// Valid window lengths for GET /api/openings/played: last N days or every game.
export const PLAYED_WINDOWS = ["7", "30", "90", "all"] as const;
export const PlayedWindowSchema = z.enum(PLAYED_WINDOWS);
export type PlayedWindow = z.infer<typeof PlayedWindowSchema>;

// The opening played when no position of the game is named. It is always the student's choice,
// since no opponent move named anything, and it is listed last whatever its game count.
export const UNNAMED_PLAYED_OPENING = "Unnamed opening";

// The variation shown when the full name has no colon: the name itself is the family.
export const MAIN_LINE_VARIATION = "Main line";

export const PlayedVariationSchema = z.object({
  name: z.string().min(1),
  full_name: z.string().min(1),
  line: z.string(),
  games: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
});
export type PlayedVariation = z.infer<typeof PlayedVariationSchema>;

export const PlayedOpeningSchema = z.object({
  opening: z.string().min(1),
  line: z.string(),
  games: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  variations: z.array(PlayedVariationSchema),
});
export type PlayedOpening = z.infer<typeof PlayedOpeningSchema>;

export const PlayedColourSchema = z.object({
  games: z.number().int().nonnegative(),
  mine: z.array(PlayedOpeningSchema),
  against: z.array(PlayedOpeningSchema),
});
export type PlayedColour = z.infer<typeof PlayedColourSchema>;

export const PlayedOpeningsResponseSchema = z.object({
  white: PlayedColourSchema,
  black: PlayedColourSchema,
});
export type PlayedOpeningsResponse = z.infer<typeof PlayedOpeningsResponseSchema>;
