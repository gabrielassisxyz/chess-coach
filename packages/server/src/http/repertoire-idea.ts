import {
  SaveRepertoireIdeaRequestSchema,
  type SaveRepertoireIdeaResponse,
} from "@chess-coach/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "../db/open.js";
import { type SavedRepertoireIdea, saveRepertoireIdea } from "../db/repertoires.js";
import { type Log, silentLog } from "../log.js";
import { isUpgradeAllowed } from "../ws/origin.js";

export interface RepertoireIdeaRouteOptions {
  db: Database;
  allowedOrigins: readonly string[];
  onSaved?: (saved: SavedRepertoireIdea) => void | Promise<void>;
  log?: Log;
}

// A row id has no sign, no fraction and no exponent, and stays a safe integer.
const positionIdParams = z.object({ id: z.string().regex(/^[1-9][0-9]{0,14}$/) });

const MAX_PROBLEM_CHARS = 300;

function requestProblem(error: z.ZodError): string {
  const [first] = error.issues;
  const where = first?.path.join(".") ?? "";
  const text = `${where === "" ? "the body" : where}: ${first?.message ?? "is not valid"}`;
  return text.slice(0, MAX_PROBLEM_CHARS);
}

export function registerRepertoireIdeaRoute(
  app: FastifyInstance,
  options: RepertoireIdeaRouteOptions,
): void {
  const { db, allowedOrigins } = options;
  const log = options.log ?? silentLog;

  // Same Origin and Host guard as the other repertoire write routes, checked before the body is read.
  const writeGuard = {
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      const { origin, host } = request.headers;
      if (isUpgradeAllowed({ origin, host }, allowedOrigins)) return;
      await reply.code(403).send({
        error: "origin_not_allowed",
        message: "This page may not change the repertoire.",
      });
    },
  };

  app.put(
    "/api/repertoires/positions/:id/idea",
    writeGuard,
    async (request, reply): Promise<SaveRepertoireIdeaResponse | undefined> => {
      const params = positionIdParams.safeParse(request.params);
      if (!params.success) {
        await reply
          .code(400)
          .send({ error: "invalid_request", message: "the id is a positive whole number" });
        return undefined;
      }
      const body = SaveRepertoireIdeaRequestSchema.safeParse(request.body);
      if (!body.success) {
        await reply
          .code(400)
          .send({ error: "invalid_request", message: requestProblem(body.error) });
        return undefined;
      }
      const positionId = Number(params.data.id);
      const saved = saveRepertoireIdea(db, positionId, body.data.idea);
      if (!saved) {
        await reply
          .code(404)
          .send({ error: "not_found", message: `no repertoire move has the id ${positionId}` });
        return undefined;
      }
      await options.onSaved?.(saved);
      log.info("repertoire.idea_saved", {
        position_id: positionId,
        rows_updated: saved.rowsUpdated,
        length: saved.idea.length,
      });
      return { rows_updated: saved.rowsUpdated, idea: saved.idea };
    },
  );
}
