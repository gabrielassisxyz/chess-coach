import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db/open.js";
import { listRoutines, newestRoutine } from "../db/routines.js";

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export function registerRoutineRoutes(app: FastifyInstance, db: Database): void {
  app.get("/api/routine", async (_request, reply) => {
    const routine = newestRoutine(db);
    if (!routine) return reply.code(404).send({ error: "not_found", message: "no routine yet" });
    return routine;
  });
  app.get("/api/routine/history", async (request, reply) => {
    const parsed = historyQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_query", message: parsed.error.message });
    }
    return { routines: listRoutines(db, parsed.data.limit) };
  });
}
