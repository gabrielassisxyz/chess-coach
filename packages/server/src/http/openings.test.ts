import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { openDatabase } from "../db/open.js";

const db = () => openDatabase(mkdtempSync(join(tmpdir(), "opening-route-")));

describe("POST /api/openings/generate", () => {
  it("runs the generator and returns its counts", async () => {
    let calls = 0;
    const app = buildApp({
      db: db(),
      generateOpenings: async () => {
        calls += 1;
        return { positions: 12, created: 9, updated: 3 };
      },
    });
    const response = await app.inject({ method: "POST", url: "/api/openings/generate" });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ positions: 12, created: 9, updated: 3 });
    expect(calls).toBe(1);
  });

  it("reports an engine failure as a 502 instead of crashing", async () => {
    const app = buildApp({
      db: db(),
      generateOpenings: async () => {
        throw new Error("engine fault");
      },
    });
    const response = await app.inject({ method: "POST", url: "/api/openings/generate" });
    await app.close();
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: "engine_unavailable", message: "engine fault" });
  });

  it("is not mounted without a generator", async () => {
    const app = buildApp({ db: db() });
    const response = await app.inject({ method: "POST", url: "/api/openings/generate" });
    await app.close();
    expect(response.statusCode).toBe(404);
  });
});
