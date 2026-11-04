import type { HealthResponse } from "@chess-coach/shared";
import Fastify, { type FastifyInstance } from "fastify";

export interface Readiness {
  ready: boolean;
  reason?: string;
}

export interface AppOptions {
  readiness?: () => Readiness;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const readiness = options.readiness ?? (() => ({ ready: true }));

  app.get("/api/health", async (): Promise<HealthResponse> => {
    const state = readiness();
    const base = { status: "ok", version: "0.0.0", ready: state.ready } as const;
    return state.ready || state.reason === undefined ? base : { ...base, reason: state.reason };
  });

  return app;
}
