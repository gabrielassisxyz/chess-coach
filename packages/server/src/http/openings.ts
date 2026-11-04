import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ExplorerError } from "../openings/explorer-client.js";
import type { ExplorerResult } from "../openings/from-explorer.js";
import type { GenerationResult } from "../openings/from-games.js";

const generateBody = z
  .object({
    sources: z
      .array(z.enum(["own", "explorer"]))
      .min(1)
      .max(2),
  })
  .partial()
  .nullish();

export function registerOpeningRoutes(
  app: FastifyInstance,
  generate: () => Promise<GenerationResult>,
  generateFromExplorer?: () => Promise<ExplorerResult>,
): void {
  // The explorer half runs for minutes at one request a second; a second run would only queue behind it.
  let explorerRunning = false;

  app.post("/api/openings/generate", async (request, reply) => {
    const body = generateBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: "invalid_sources", message: "sources is own, explorer" });
    }
    const sources = body.data?.sources;
    if (sources?.includes("explorer") && !generateFromExplorer) {
      return reply.code(404).send({ error: "explorer_unavailable", message: "not configured" });
    }
    if (sources?.includes("explorer") && explorerRunning) {
      return reply
        .code(409)
        .send({ error: "already_running", message: "explorer run in progress" });
    }
    try {
      // Without `sources` the answer keeps the original flat shape.
      if (!sources) return await generate();
      const out: { own?: GenerationResult; explorer?: ExplorerResult } = {};
      if (sources.includes("own")) out.own = await generate();
      if (sources.includes("explorer") && generateFromExplorer) {
        explorerRunning = true;
        out.explorer = await generateFromExplorer().finally(() => {
          explorerRunning = false;
        });
      }
      return out;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ExplorerError) {
        return reply.code(502).send({ error: "explorer_unavailable", message });
      }
      return reply.code(502).send({ error: "engine_unavailable", message });
    }
  });
}
