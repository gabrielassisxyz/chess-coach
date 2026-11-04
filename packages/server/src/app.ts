import type { HealthResponse } from "@chess-coach/shared";
import Fastify, { type FastifyInstance } from "fastify";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/api/health", async (): Promise<HealthResponse> => {
    return { status: "ok", version: "0.0.0" };
  });

  return app;
}
