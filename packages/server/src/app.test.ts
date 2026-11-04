import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("GET /api/health", () => {
  it("answers ok with a version", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version: "0.0.0" });
    await app.close();
  });
});
