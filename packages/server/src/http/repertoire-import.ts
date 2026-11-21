import {
  type DeleteImportedResponse,
  type ImportPgnInvalidResponse,
  ImportPgnRequestSchema,
  type ImportPgnResponse,
} from "@chess-coach/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type Clock, systemClock } from "../clock.js";
import type { Database } from "../db/open.js";
import {
  deleteImportedRepertoireUnit,
  syncImportedRepertoireUnit,
} from "../db/repertoire-import.js";
import { type Log, silentLog } from "../log.js";
import { readPgnRepertoire } from "../openings/pgn-repertoire.js";
import { isUpgradeAllowed } from "../ws/origin.js";

export interface RepertoireImportRouteOptions {
  db: Database;
  allowedOrigins: readonly string[];
  clock?: Clock;
  log?: Log;
}

// Two texts of up to 500,000 bytes each, plus the JSON's escaping of them, with room to spare.
export const REPERTOIRE_IMPORT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

// Every refusal of the sync is a conflict with what is stored, or with what the student asked for,
// that the same file will meet again until something else changes; none is the request's syntax.
const SYNC_REFUSAL_STATUS = 409;

const DELETE_REFUSAL_STATUS = { not_found: 404, not_imported: 409, drill_open: 409 } as const;

// A row id has no sign, no fraction and no exponent, and stays a safe integer.
const deleteParams = z.object({ id: z.string().regex(/^[1-9][0-9]{0,14}$/) });
// Strict, so `?dryrun=true` cannot run as a real delete; a repeated key arrives as an array.
const deleteQuery = z.strictObject({ dry_run: z.enum(["true", "false"]).optional() });

const MAX_PROBLEM_CHARS = 300;

// The first problem alone, in the words of the schema: zod never quotes a value it was given, except
// the name of a key it did not expect, which the cut bounds.
function requestProblem(error: z.ZodError): string {
  const [first] = error.issues;
  const where = first?.path.join(".") ?? "";
  const text = `${where === "" ? "the body" : where}: ${first?.message ?? "is not valid"}`;
  return text.slice(0, MAX_PROBLEM_CHARS);
}

const invalidPgnMessage = (problems: number): string =>
  `the PGN has ${problems} problem${problems === 1 ? "" : "s"}, so nothing was imported`;

export function registerRepertoireImportRoutes(
  app: FastifyInstance,
  options: RepertoireImportRouteOptions,
): void {
  const { db, allowedOrigins } = options;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? silentLog;

  const refuse = async (
    reply: FastifyReply,
    operation: "import" | "delete",
    status: number,
    code: string,
    message: string,
    context: Record<string, unknown> = {},
  ): Promise<undefined> => {
    log.warn("repertoire.import_refused", { operation, code, ...context });
    await reply.code(status).send({ error: code, message });
    return undefined;
  };

  // The socket's rule, as the connections routes apply it: a browser always sends Origin on these
  // methods, and pinning Host as well is what stops a DNS-rebinding page, which is same-origin to
  // itself, from rewriting the repertoire. It runs before the body is read.
  const writeGuard = {
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      const { origin, host } = request.headers;
      if (isUpgradeAllowed({ origin, host }, allowedOrigins)) return;
      const operation = request.method === "DELETE" ? "delete" : "import";
      await refuse(
        reply,
        operation,
        403,
        "origin_not_allowed",
        "This page may not change the repertoire.",
        { origin, host },
      );
    },
  };

  app.post(
    "/api/repertoires/import-pgn",
    { ...writeGuard, bodyLimit: REPERTOIRE_IMPORT_BODY_LIMIT_BYTES },
    async (request, reply): Promise<ImportPgnResponse | undefined> => {
      const body = ImportPgnRequestSchema.safeParse(request.body);
      if (!body.success) {
        return refuse(reply, "import", 400, "invalid_request", requestProblem(body.error));
      }
      const { side, group, variation, pgn, weights, dry_run: dryRun } = body.data;
      const unit = { side, group, variation };
      const startedAt = performance.now();

      const read = readPgnRepertoire(pgn, side, weights);
      if (read.errors) {
        const invalid: ImportPgnInvalidResponse = {
          error: "invalid_pgn",
          message: invalidPgnMessage(read.errors.length),
          errors: read.errors,
        };
        log.warn("repertoire.import_refused", {
          operation: "import",
          code: "invalid_pgn",
          ...unit,
          dry_run: dryRun,
          errors: read.errors.length,
          error_codes: read.errors.map((error) => error.code),
        });
        await reply.code(400).send(invalid);
        return undefined;
      }

      const synced = syncImportedRepertoireUnit(
        db,
        unit,
        read.moves,
        clock.now().toISOString(),
        dryRun,
      );
      if (!synced.ok) {
        return refuse(reply, "import", SYNC_REFUSAL_STATUS, synced.code, synced.message, {
          ...unit,
          dry_run: dryRun,
        });
      }

      // Counts only: the reasons the sync lists are the student's own text from the file.
      const { reasons_removed: reasonsRemoved, ...changes } = synced.summary;
      log.info("repertoire.import", {
        ...unit,
        dry_run: dryRun,
        ...read.counts,
        ...changes,
        reasons_removed: reasonsRemoved.length,
        duration_ms: Math.round(performance.now() - startedAt),
      });
      return { dry_run: dryRun, counts: read.counts, summary: synced.summary };
    },
  );

  app.delete(
    "/api/repertoires/:id",
    writeGuard,
    async (request, reply): Promise<DeleteImportedResponse | undefined> => {
      const params = deleteParams.safeParse(request.params);
      if (!params.success) {
        return refuse(reply, "delete", 400, "invalid_request", "the id is a positive whole number");
      }
      const query = deleteQuery.safeParse(request.query);
      if (!query.success) {
        return refuse(reply, "delete", 400, "invalid_request", "dry_run is true or false");
      }
      const repertoireId = Number(params.data.id);
      const dryRun = query.data.dry_run === "true";

      const deleted = deleteImportedRepertoireUnit(
        db,
        repertoireId,
        clock.now().toISOString(),
        dryRun,
      );
      if (!deleted.ok) {
        return refuse(
          reply,
          "delete",
          DELETE_REFUSAL_STATUS[deleted.code],
          deleted.code,
          deleted.message,
          { repertoire_id: repertoireId, dry_run: dryRun },
        );
      }

      const { reasons_removed: reasonsRemoved, ...changes } = deleted.summary;
      log.info("repertoire.import_deleted", {
        dry_run: dryRun,
        ...changes,
        reasons_removed: reasonsRemoved.length,
      });
      return { dry_run: dryRun, summary: deleted.summary };
    },
  );
}
