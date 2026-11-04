import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

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
