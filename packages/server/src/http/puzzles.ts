import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db/open.js";
import { listPuzzles } from "../db/puzzles.js";

const querySchema = z.object({
  motif: z.string().min(1).optional(),
  difficulty: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

export function registerPuzzleRoutes(app: FastifyInstance, db: Database): void {
  app.get("/api/puzzles", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_query", message: parsed.error.message });
    }
    return listPuzzles(db, parsed.data);
  });
}
