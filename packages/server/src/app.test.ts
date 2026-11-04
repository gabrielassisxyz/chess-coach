import { describe, expect, it } from "vitest";
import { buildApp, type Readiness } from "./app.js";
import { bootEngines } from "./engine/boot.js";
import { EnginePool } from "./engine/pool.js";
import { spawnStockfish } from "./engine/process.js";

describe("GET /api/health", () => {
  it("answers ok with a version", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version: "0.0.0", ready: true });
    await app.close();
  });

  it("explains why the coach is not ready", async () => {
    const app = buildApp({ readiness: () => ({ ready: false, reason: "coach is starting" }) });
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.json()).toEqual({
      status: "ok",
      version: "0.0.0",
      ready: false,
      reason: "coach is starting",
    });
    await app.close();
  });
});

describe("health with a missing Stockfish", () => {
  it("starts and reports stockfish_missing when the binary cannot be spawned", async () => {
    const pool = new EnginePool(() => spawnStockfish("/nonexistent/stockfish"), { startupMs: 500 });
    const boot = await bootEngines(pool);
    const readiness: Readiness = boot.ok ? { ready: true } : { ready: false, reason: boot.reason };
    const app = buildApp({ readiness: () => readiness });
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.json()).toEqual({
      status: "ok",
      version: "0.0.0",
      ready: false,
      reason: "stockfish_missing",
    });
    await pool.stop();
    await app.close();
  });
});
