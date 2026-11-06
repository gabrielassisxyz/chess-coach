import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { openDatabase } from "../db/open.js";
import { RecordingLog } from "../log.js";
import { ExplorerError } from "../openings/explorer-client.js";

const db = () => openDatabase(mkdtempSync(join(tmpdir(), "opening-route-")));

describe("the openings log", () => {
  it("logs a run with its counts, and a failure with its stack", async () => {
    const log = new RecordingLog();
    let fail = false;
    const app = buildApp({
      db: db(),
      log,
      generateOpenings: async () => {
        if (fail) throw new Error("engine fault");
        return { positions: 12, created: 9, updated: 3 };
      },
    });
    await app.inject({ method: "POST", url: "/api/openings/generate" });
    fail = true;
    await app.inject({ method: "POST", url: "/api/openings/generate" });
    await app.close();
    expect(log.named("openings.generate")[0]?.fields).toMatchObject({
      sources: ["own"],
      result: { positions: 12, created: 9, updated: 3 },
    });
    expect(log.named("openings.generate_failed")[0]).toMatchObject({
      level: "error",
      fields: { error_message: "engine fault" },
    });
  });
});

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

  describe("sources", () => {
    const own = { positions: 1, created: 1, updated: 0 };
    const explorer = {
      positions: 4,
      created: 2,
      skippedOwn: 0,
      requests: 3,
      cacheHits: 0,
      truncated: false,
    };
    const italian = {
      positions: 3,
      created: 3,
      skippedOwn: 0,
      requests: 5,
      cacheHits: 0,
      truncated: false,
    };
    const build = (calls: string[]) =>
      buildApp({
        db: db(),
        generateOpenings: async () => {
          calls.push("own");
          return own;
        },
        generateExplorerOpenings: async () => {
          calls.push("explorer");
          return explorer;
        },
        generateItalianOpenings: async () => {
          calls.push("italian");
          return italian;
        },
      });
    const post = async (calls: string[], payload?: unknown) => {
      const app = build(calls);
      const response = await app.inject({
        method: "POST",
        url: "/api/openings/generate",
        payload: payload as object,
      });
      await app.close();
      return response;
    };

    it("runs only the explorer when asked for it, and returns its counts", async () => {
      const calls: string[] = [];
      const response = await post(calls, { sources: ["explorer"] });
      expect(response.json()).toEqual({ explorer });
      expect(calls).toEqual(["explorer"]);
    });

    it("runs both, own first", async () => {
      const calls: string[] = [];
      const response = await post(calls, { sources: ["own", "explorer"] });
      expect(response.json()).toEqual({ own, explorer });
      expect(calls).toEqual(["own", "explorer"]);
    });

    it("never runs the explorer without being asked", async () => {
      const calls: string[] = [];
      await post(calls);
      await post(calls, { sources: ["own"] });
      expect(calls).toEqual(["own", "own"]);
    });

    it("rejects an unknown source", async () => {
      const calls: string[] = [];
      expect((await post(calls, { sources: ["masters"] })).statusCode).toBe(400);
      expect(calls).toEqual([]);
    });

    it("answers 404 when the explorer is not wired", async () => {
      const app = buildApp({ db: db(), generateOpenings: async () => own });
      const response = await app.inject({
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["explorer"] },
      });
      await app.close();
      expect(response.statusCode).toBe(404);
    });

    it("refuses a second explorer run while one is going", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = buildApp({
        db: db(),
        generateOpenings: async () => own,
        generateExplorerOpenings: async () => {
          await gate;
          return explorer;
        },
      });
      const request = {
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["explorer"] },
      } as const;
      const first = app.inject(request);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await app.inject(request);
      release();
      expect((await first).statusCode).toBe(200);
      await app.close();
      expect(second.statusCode).toBe(409);
    });

    it("reports a missing token as a 502 naming the explorer", async () => {
      const app = buildApp({
        db: db(),
        generateOpenings: async () => own,
        generateExplorerOpenings: async () => {
          throw new ExplorerError("unauthorized", "set LICHESS_API_TOKEN");
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["explorer"] },
      });
      await app.close();
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ error: "explorer_unavailable" });
    });

    it("runs only the italian source when asked for it, and returns its counts", async () => {
      const calls: string[] = [];
      const response = await post(calls, { sources: ["italian"] });
      expect(response.json()).toEqual({ italian });
      expect(calls).toEqual(["italian"]);
    });

    it("answers 404 when the italian source is not wired", async () => {
      const app = buildApp({ db: db(), generateOpenings: async () => own });
      const response = await app.inject({
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["italian"] },
      });
      await app.close();
      expect(response.statusCode).toBe(404);
    });

    it("reports a missing token for the italian source as a 502 with the 401 message", async () => {
      const app = buildApp({
        db: db(),
        generateOpenings: async () => own,
        generateItalianOpenings: async () => {
          throw new ExplorerError("unauthorized", "the explorer wants a Lichess API token");
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["italian"] },
      });
      await app.close();
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        error: "explorer_unavailable",
        message: "the explorer wants a Lichess API token",
      });
    });
  });
});
