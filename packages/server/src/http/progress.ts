import type { FastifyInstance } from "fastify";
import { type Clock, systemClock } from "../clock.js";
import type { Database } from "../db/open.js";
import { computeProgress } from "../progress/compute.js";

export function registerProgressRoutes(
  app: FastifyInstance,
  db: Database,
  clock: Clock = systemClock,
): void {
  app.get("/api/progress", async () => computeProgress(db, clock));
}
