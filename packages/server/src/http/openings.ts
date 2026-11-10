import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Log, silentLog } from "../log.js";
import { ExplorerError } from "../openings/explorer-client.js";
import type { ExplorerResult } from "../openings/from-explorer.js";
import type { GenerationResult } from "../openings/from-games.js";
import {
  checkRepertoireBranch,
  type RepertoireBranchCheck,
  RepertoireBranchError,
  type RepertoireResult,
} from "../openings/from-repertoire.js";
import { IdeaSessionError, type RepertoireIdeasResult } from "../openings/repertoire-ideas.js";
import {
  checkRepertoireRoot,
  type RepertoireRootCheck,
  RepertoireRootConflictError,
} from "../openings/repertoire-root.js";

const generateBody = z
  .object({
    sources: z
      .array(z.enum(["own", "explorer", "italian", "repertoire", "repertoire-ideas"]))
      .min(1)
      .max(5),
    // Left to the root rules rather than zod, so that a malformed one answers invalid_root.
    root: z.unknown(),
    // The same for a branch, which answers invalid_branch.
    branch: z.unknown(),
  })
  .partial()
  .nullish();

// A root means something to the repertoire source only, so no other source reads it.
function checkedRoot(sources: string[] | undefined, root: unknown): RepertoireRootCheck | null {
  const given = root !== undefined && root !== null;
  return given && sources?.includes("repertoire") ? checkRepertoireRoot(root) : null;
}

const isGiven = (value: unknown): boolean => value !== undefined && value !== null;

// A branch is a line of the Italian, so it takes no root, and like a root only the repertoire
// source reads it.
function checkedBranch(
  sources: string[] | undefined,
  body: { root?: unknown; branch?: unknown } | null | undefined,
): RepertoireBranchCheck | null {
  if (!isGiven(body?.branch) || !sources?.includes("repertoire")) return null;
  if (isGiven(body?.root)) {
    return { ok: false, reason: "a branch is a line of the Italian Game and takes no root" };
  }
  return checkRepertoireBranch(body?.branch);
}

export function registerOpeningRoutes(
  app: FastifyInstance,
  generate: () => Promise<GenerationResult>,
  generateFromExplorer?: () => Promise<ExplorerResult>,
  generateItalian?: () => Promise<ExplorerResult>,
  generateRepertoire?: (
    root?: readonly string[],
    branch?: readonly string[],
  ) => Promise<RepertoireResult>,
  generateRepertoireIdeas?: () => Promise<RepertoireIdeasResult>,
  log: Log = silentLog,
): void {
  // The explorer halves run for minutes at one request a second; a second run would only queue behind it.
  let explorerRunning = false;
  // Writing the ideas takes minutes of model time, and a second run would ask for the same moves again.
  let ideasRunning = false;

  app.post("/api/openings/generate", async (request, reply) => {
    const body = generateBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "invalid_sources",
        message: "sources is own, explorer, italian, repertoire, repertoire-ideas",
      });
    }
    const sources = body.data?.sources;
    const branch = checkedBranch(sources, body.data);
    if (branch && !branch.ok) {
      return reply.code(400).send({ error: "invalid_branch", message: branch.reason });
    }
    const root = checkedRoot(sources, body.data?.root);
    if (root && !root.ok) {
      return reply.code(400).send({ error: "invalid_root", message: root.reason });
    }
    // Only a root or a branch that passed is logged, and the generator is handed the line as the
    // board wrote it.
    const lineFields = {
      ...(root?.ok ? { root: root.root } : {}),
      ...(branch?.ok ? { branch: branch.branch } : {}),
    };
    if (sources?.includes("explorer") && !generateFromExplorer) {
      return reply.code(404).send({ error: "explorer_unavailable", message: "not configured" });
    }
    if (sources?.includes("italian") && !generateItalian) {
      return reply.code(404).send({ error: "italian_unavailable", message: "not configured" });
    }
    if (sources?.includes("repertoire") && !generateRepertoire) {
      return reply.code(404).send({ error: "repertoire_unavailable", message: "not configured" });
    }
    if (sources?.includes("repertoire-ideas") && !generateRepertoireIdeas) {
      return reply
        .code(404)
        .send({ error: "repertoire_ideas_unavailable", message: "not configured" });
    }
    if (sources?.includes("repertoire-ideas") && ideasRunning) {
      return reply.code(409).send({ error: "already_running", message: "ideas run in progress" });
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
    // Taken with the request, not when the ideas step starts: the steps before it can take minutes,
    // and a second request arriving meanwhile would otherwise find the guard free.
    const writesIdeas = sources?.includes("repertoire-ideas") ?? false;
    if (writesIdeas) ideasRunning = true;
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
        repertoireIdeas?: RepertoireIdeasResult;
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
        const rootLine = root?.ok ? root.root : undefined;
        const branchLine = branch?.ok ? branch.branch : undefined;
        out.repertoire = await generateRepertoire(rootLine, branchLine).finally(() => {
          explorerRunning = false;
        });
      }
      if (writesIdeas && generateRepertoireIdeas)
        out.repertoireIdeas = await generateRepertoireIdeas();
      log.info("openings.generate", {
        sources,
        ...lineFields,
        result: out,
        duration_ms: elapsed(),
      });
      return out;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const explorer = error instanceof ExplorerError;
      log.error(explorer ? "explorer.failed" : "openings.generate_failed", error, {
        sources: sources ?? ["own"],
        ...lineFields,
        duration_ms: elapsed(),
      });
      if (error instanceof RepertoireRootConflictError) {
        return reply.code(409).send({ error: "root_conflict", message });
      }
      if (error instanceof RepertoireBranchError) {
        return reply.code(409).send({ error: "branch_refused", message });
      }
      if (error instanceof ExplorerError) {
        return reply.code(502).send({ error: "explorer_unavailable", message });
      }
      if (error instanceof IdeaSessionError) {
        return reply.code(502).send({ error: "ideas_unavailable", message });
      }
      return reply.code(502).send({ error: "engine_unavailable", message });
    } finally {
      if (writesIdeas) ideasRunning = false;
    }
  });
}
