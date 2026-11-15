import {
  MAX_OPENING_PUZZLE_NAMES,
  MAX_OPENING_TAG_LENGTH,
  type OpeningPuzzlesResponse,
  openingTagOf,
  PuzzleRatingWindowSchema,
} from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Clock, systemClock } from "../clock.js";
import type { Database } from "../db/open.js";
import { listMotifs, listPuzzles, tallyOpeningTag } from "../db/puzzles.js";
import { puzzleRatingHistory } from "../puzzles/rating.js";

const querySchema = z.object({
  motif: z.string().min(1).optional(),
  difficulty: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

const historyQuerySchema = z.object({
  days: PuzzleRatingWindowSchema.default("30"),
});

const OPENING_PUZZLES_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// A comma inside an opening name is always followed by a space ("Sicilian Defense: Najdorf
// Variation, English Attack"), so only a comma with none after it separates two names. A name is
// never shorter than its tag, so one within the tag's bound has a tag a start can name.
const openingPuzzlesQuerySchema = z.object({
  names: z
    .string()
    .transform((names) => names.split(/,(?! )/))
    .pipe(
      z.array(z.string().min(1).max(MAX_OPENING_TAG_LENGTH)).min(1).max(MAX_OPENING_PUZZLE_NAMES),
    ),
});

export function registerPuzzleRoutes(
  app: FastifyInstance,
  db: Database,
  clock: Clock = systemClock,
): void {
  app.get("/api/puzzles/motifs", async () => ({ motifs: listMotifs(db) }));
  app.get("/api/puzzles/rating/history", async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_query", message: parsed.error.message });
    }
    return puzzleRatingHistory(db, parsed.data.days, clock);
  });
  app.get("/api/puzzles", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_query", message: parsed.error.message });
    }
    return listPuzzles(db, parsed.data);
  });
  // The Lichess puzzles of each opening asked about, one entry per name in the order asked, with
  // the student's attempts on them in the last 30 days.
  app.get("/api/puzzles/openings", async (request, reply) => {
    const parsed = openingPuzzlesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_query", message: parsed.error.message });
    }
    const now = clock.now();
    const window = {
      from: new Date(now.getTime() - OPENING_PUZZLES_WINDOW_MS).toISOString(),
      to: now.toISOString(),
    };
    const entries = parsed.data.names.map((name) => {
      const tag = openingTagOf(name);
      const tally = tallyOpeningTag(db, tag, window);
      return {
        name,
        tag,
        puzzles: tally.puzzles,
        played_30d: tally.played,
        first_try_30d: tally.firstTry,
      };
    });
    return { entries } satisfies OpeningPuzzlesResponse;
  });
}
