import type { FastifyInstance } from "fastify";
import type { GenerationResult } from "../openings/from-games.js";

export function registerOpeningRoutes(
  app: FastifyInstance,
  generate: () => Promise<GenerationResult>,
): void {
  app.post("/api/openings/generate", async (_request, reply) => {
    try {
      return await generate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({ error: "engine_unavailable", message });
    }
  });
}
