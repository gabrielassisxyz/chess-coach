import type { HealthResponse } from "@chess-coach/shared";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "./db/open.js";
import { registerCardRoutes } from "./http/cards.js";
import { registerGameRoutes } from "./http/games.js";
import { registerPuzzleRoutes } from "./http/puzzles.js";
import { type HubOptions, MAX_FRAME_BYTES, registerHub } from "./ws/hub.js";

export interface Readiness {
  ready: boolean;
  reason?: string;
}

export interface AppOptions {
  readiness?: () => Readiness;
  hub?: HubOptions;
  db?: Database;
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
    registerPuzzleRoutes(app, options.db);
  }

  if (options.hub) {
    void app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
    void app.register(registerHub, options.hub);
  }

  return app;
}
