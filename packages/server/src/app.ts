import type { HealthResponse } from "@chess-coach/shared";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "./db/open.js";
import { registerCardRoutes } from "./http/cards.js";
import { registerGameRoutes } from "./http/games.js";
import { type ImportRoutesOptions, registerImportRoutes } from "./http/import.js";
import { registerOpeningRoutes } from "./http/openings.js";
import { registerProgressRoutes } from "./http/progress.js";
import { registerPuzzleRoutes } from "./http/puzzles.js";
import { registerRoutineRoutes } from "./http/routine.js";
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
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const readiness = options.readiness ?? (() => ({ ready: true }));

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
    if (options.importer) registerImportRoutes(app, { db: options.db, ...options.importer });
    if (options.generateOpenings) registerOpeningRoutes(app, options.generateOpenings);
  }

  if (options.hub) {
    void app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
    void app.register(registerHub, options.hub);
  }

  return app;
}
