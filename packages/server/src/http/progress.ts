import { PuzzleRatingWindowSchema } from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Clock, systemClock } from "../clock.js";
import type { Database } from "../db/open.js";
import { computeProgress } from "../progress/compute.js";
import { computeThemeStats } from "../progress/theme-stats.js";

const themeStatsQuerySchema = z.object({
  days: PuzzleRatingWindowSchema.default("30"),
});

export function registerProgressRoutes(
  app: FastifyInstance,
  db: Database,
  clock: Clock = systemClock,
): void {
  app.get("/api/progress", async () => computeProgress(db, clock));
  app.get("/api/puzzles/themes/stats", async (request, reply) => {
    const parsed = themeStatsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_query", message: parsed.error.message });
    }
    return computeThemeStats(db, parsed.data.days, clock);
  });
}
