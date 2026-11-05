import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Log } from "../log.js";

export const MAX_CLIENT_REPORT_BYTES = 16 * 1024;

const reportBody = z.object({
  level: z.enum(["info", "warn", "error"]),
  event: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
  message: z.string(),
  stack: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

// The browser's own failures (a thrown render, a dropped socket, an error frame it received) land
// in the server's log beside the events that caused them. The event name is constrained so a
// report cannot pose as a server event, and the size cap keeps one bad page from filling the disk.
export function registerClientLogRoute(app: FastifyInstance, log: Log): void {
  app.post("/api/client-log", { bodyLimit: MAX_CLIENT_REPORT_BYTES }, async (request, reply) => {
    const body = reportBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_report", message: body.error.message });
    }
    const { level, event, message, stack, context } = body.data;
    const name = `client.${event}`;
    const extra = context ? { context } : {};
    if (level === "error") {
      const error = Object.assign(new Error(message), { name: "ClientError", stack });
      log.error(name, error, extra);
    } else {
      log[level](name, { message, ...(stack ? { stack } : {}), ...extra });
    }
    return reply.code(204).send();
  });
}
