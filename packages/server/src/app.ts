import type { HealthResponse } from "@chess-coach/shared";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "./db/open.js";
import { registerCardRoutes } from "./http/cards.js";
import { registerClientLogRoute } from "./http/client-log.js";
import { type ConnectionRoutesOptions, registerConnectionRoutes } from "./http/connections.js";
import { registerGameRoutes } from "./http/games.js";
import { type ImportRoutesOptions, registerImportRoutes } from "./http/import.js";
import { registerOpeningDrillRoutes, registerOpeningRoutes } from "./http/openings.js";
import { registerProgressRoutes } from "./http/progress.js";
import { registerPuzzleRoutes } from "./http/puzzles.js";
import { registerRepertoireRoutes } from "./http/repertoires.js";
import { registerRoutineRoutes } from "./http/routine.js";
import { type Log, silentLog } from "./log.js";
import type { ExplorerResult } from "./openings/from-explorer.js";
import type { GenerationResult } from "./openings/from-games.js";
import {
  NO_REPERTOIRE_BRANCH_BOOK,
  type RepertoireBranchBook,
  type RepertoirePoints,
  type RepertoireResult,
} from "./openings/from-repertoire.js";
import { NO_OPENING_NAMES, type OpeningNames } from "./openings/names.js";
import type { RepertoireIdeasResult } from "./openings/repertoire-ideas.js";
import { type HubOptions, MAX_FRAME_BYTES, registerHub } from "./ws/hub.js";

export interface Readiness {
  ready: boolean;
  reason?: string;
}

export interface AppOptions {
  readiness?: () => Readiness;
  hub?: HubOptions;
  db?: Database;
  /** Names the opening of each game from its positions; without it no game carries one. */
  openingNames?: OpeningNames;
  /** The book's branch points in the Italian, which the openings menu offers new variations at. */
  repertoireBranches?: RepertoireBranchBook;
  /** Everything the import routes need besides the database; without it they are not mounted. */
  importer?: Omit<ImportRoutesOptions, "db">;
  /** What saving a Lichess token or a Chess.com account checks against; without it the routes are not mounted. */
  connections?: Omit<ConnectionRoutesOptions, "db" | "log">;
  /** Builds the opening drills from graded games; without it the route is not mounted. */
  generateOpenings?: () => Promise<GenerationResult>;
  /** Expands the drills with the Lichess explorer; only asked for by name, never after an import. */
  generateExplorerOpenings?: () => Promise<ExplorerResult>;
  /** Builds the White Italian drill from the explorer; only asked for by name, never after an import. */
  generateItalianOpenings?: () => Promise<ExplorerResult>;
  /**
   * Builds the first stored variation of the Italian, or of the unit rooted at a line, or another
   * variation of the Italian forced at a branch point, and with `rebuild` replaces the stored one
   * under the current rule; `points` weigh White's candidate moves, the default where left out.
   * Only asked for by name, never after an import.
   */
  generateRepertoireOpenings?: (
    root?: readonly string[],
    branch?: readonly string[],
    rebuild?: boolean,
    points?: RepertoirePoints,
  ) => Promise<RepertoireResult>;
  /** Writes the idea of each stored White move through the model; only asked for by name, never at boot. */
  generateRepertoireIdeas?: () => Promise<RepertoireIdeasResult>;
  log?: Log;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  // Fastify's own logger stays off: requests go to the project's log, in the same file as the rest.
  const app = Fastify({ logger: false });
  const log = options.log ?? silentLog;
  const readiness = options.readiness ?? (() => ({ ready: true }));
  app.addHook("onResponse", async (request, reply) => {
    log.info("http.request", {
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime),
    });
  });
  app.addHook("onError", async (request, _reply, error) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const where = { method: request.method, url: request.url, status };
    // A 4xx is the request's fault (a malformed or oversized body); only a 5xx is the server's.
    if (status < 500) log.warn("http.client_error", { ...where, message: error.message });
    else log.error("http.error", error, where);
  });
  registerClientLogRoute(app, log);

  app.get("/api/health", async (): Promise<HealthResponse> => {
    const state = readiness();
    const base = { status: "ok", version: "0.0.0", ready: state.ready } as const;
    return state.ready || state.reason === undefined ? base : { ...base, reason: state.reason };
  });

  if (options.db) {
    registerCardRoutes(app, options.db);
    registerGameRoutes(app, options.db, options.openingNames ?? NO_OPENING_NAMES);
    registerOpeningDrillRoutes(app, options.db);
    registerProgressRoutes(app, options.db);
    registerPuzzleRoutes(app, options.db);
    registerRepertoireRoutes(app, options.db, {
      names: options.openingNames ?? NO_OPENING_NAMES,
      book: options.repertoireBranches ?? NO_REPERTOIRE_BRANCH_BOOK,
    });
    registerRoutineRoutes(app, options.db);
    if (options.importer) {
      registerImportRoutes(app, { db: options.db, log, ...options.importer });
    }
    if (options.connections) {
      registerConnectionRoutes(app, { db: options.db, log, ...options.connections });
    }
    if (options.generateOpenings) {
      registerOpeningRoutes(
        app,
        options.generateOpenings,
        options.generateExplorerOpenings,
        options.generateItalianOpenings,
        options.generateRepertoireOpenings,
        options.generateRepertoireIdeas,
        log,
      );
    }
  }

  if (options.hub) {
    void app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
    void app.register(registerHub, { log, ...options.hub });
  }

  return app;
}
