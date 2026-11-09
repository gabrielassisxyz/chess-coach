import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Log, silentLog } from "../log.js";
import { ExplorerError } from "../openings/explorer-client.js";
import type { ExplorerResult } from "../openings/from-explorer.js";
import type { GenerationResult } from "../openings/from-games.js";
import type { RepertoireResult } from "../openings/from-repertoire.js";

const generateBody = z
  .object({
    sources: z
      .array(z.enum(["own", "explorer", "italian", "repertoire"]))
      .min(1)
      .max(4),
  })
  .partial()
  .nullish();

export function registerOpeningRoutes(
  app: FastifyInstance,
  generate: () => Promise<GenerationResult>,
  generateFromExplorer?: () => Promise<ExplorerResult>,
  generateItalian?: () => Promise<ExplorerResult>,
  generateRepertoire?: () => Promise<RepertoireResult>,
  log: Log = silentLog,
): void {
  // The explorer halves run for minutes at one request a second; a second run would only queue behind it.
  let explorerRunning = false;

  app.post("/api/openings/generate", async (request, reply) => {
    const body = generateBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "invalid_sources",
        message: "sources is own, explorer, italian, repertoire",
      });
    }
    const sources = body.data?.sources;
    if (sources?.includes("explorer") && !generateFromExplorer) {
      return reply.code(404).send({ error: "explorer_unavailable", message: "not configured" });
    }
    if (sources?.includes("italian") && !generateItalian) {
      return reply.code(404).send({ error: "italian_unavailable", message: "not configured" });
    }
    if (sources?.includes("repertoire") && !generateRepertoire) {
      return reply.code(404).send({ error: "repertoire_unavailable", message: "not configured" });
    }
    if (
      sources?.some(
        (source) => source === "explorer" || source === "italian" || source === "repertoire",
      ) &&
      explorerRunning
    ) {
      return reply
        .code(409)
        .send({ error: "already_running", message: "explorer run in progress" });
    }
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    try {
      // Without `sources` the answer keeps the original flat shape.
      if (!sources) {
        const result = await generate();
        log.info("openings.generate", { sources: ["own"], result, duration_ms: elapsed() });
        return result;
      }
      const out: {
        own?: GenerationResult;
        explorer?: ExplorerResult;
        italian?: ExplorerResult;
        repertoire?: RepertoireResult;
      } = {};
      if (sources.includes("own")) out.own = await generate();
      if (sources.includes("explorer") && generateFromExplorer) {
        explorerRunning = true;
        out.explorer = await generateFromExplorer().finally(() => {
          explorerRunning = false;
        });
      }
      if (sources.includes("italian") && generateItalian) {
        explorerRunning = true;
        out.italian = await generateItalian().finally(() => {
          explorerRunning = false;
        });
      }
      if (sources.includes("repertoire") && generateRepertoire) {
        explorerRunning = true;
        out.repertoire = await generateRepertoire().finally(() => {
          explorerRunning = false;
        });
      }
      log.info("openings.generate", { sources, result: out, duration_ms: elapsed() });
      return out;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const explorer = error instanceof ExplorerError;
      log.error(explorer ? "explorer.failed" : "openings.generate_failed", error, {
        sources: sources ?? ["own"],
        duration_ms: elapsed(),
      });
      if (error instanceof ExplorerError) {
        return reply.code(502).send({ error: "explorer_unavailable", message });
      }
      return reply.code(502).send({ error: "engine_unavailable", message });
    }
  });
}
