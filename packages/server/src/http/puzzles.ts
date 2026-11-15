import { PuzzleRatingWindowSchema } from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Clock, systemClock } from "../clock.js";
import type { Database } from "../db/open.js";
import { listMotifs, listPuzzles } from "../db/puzzles.js";
import { puzzleRatingHistory } from "../puzzles/rating.js";

const querySchema = z.object({
  motif: z.string().min(1).optional(),
  difficulty: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

const historyQuerySchema = z.object({
  days: PuzzleRatingWindowSchema.default("30"),
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
}
