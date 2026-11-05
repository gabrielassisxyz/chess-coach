import type { HealthResponse } from "@chess-coach/shared";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "./db/open.js";
import { registerCardRoutes } from "./http/cards.js";
import { registerClientLogRoute } from "./http/client-log.js";
import { registerGameRoutes } from "./http/games.js";
import { type ImportRoutesOptions, registerImportRoutes } from "./http/import.js";
import { registerOpeningRoutes } from "./http/openings.js";
import { registerProgressRoutes } from "./http/progress.js";
import { registerPuzzleRoutes } from "./http/puzzles.js";
import { registerRoutineRoutes } from "./http/routine.js";
import { type Log, silentLog } from "./log.js";
import type { ExplorerResult } from "./openings/from-explorer.js";
import type { GenerationResult } from "./openings/from-games.js";
import { type HubOptions, MAX_FRAME_BYTES, registerHub } from "./ws/hub.js";

export interface Readiness {
  ready: boolean;
  reason?: string;
}

export interface AppOptions {
  readiness?: () => Readiness;
  hub?: HubOptions;
  db?: Database;
  /** Everything the import routes need besides the database; without it they are not mounted. */
  importer?: Omit<ImportRoutesOptions, "db">;
  /** Builds the opening drills from graded games; without it the route is not mounted. */
  generateOpenings?: () => Promise<GenerationResult>;
  /** Expands the drills with the Lichess explorer; only asked for by name, never after an import. */
  generateExplorerOpenings?: () => Promise<ExplorerResult>;
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
    registerGameRoutes(app, options.db);
    registerProgressRoutes(app, options.db);
    registerPuzzleRoutes(app, options.db);
    registerRoutineRoutes(app, options.db);
    if (options.importer) {
      registerImportRoutes(app, { db: options.db, log, ...options.importer });
    }
    if (options.generateOpenings) {
      registerOpeningRoutes(app, options.generateOpenings, options.generateExplorerOpenings, log);
    }
  }

  if (options.hub) {
    void app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
    void app.register(registerHub, { log, ...options.hub });
  }

  return app;
}
