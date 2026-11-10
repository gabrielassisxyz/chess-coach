import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { openDatabase } from "../db/open.js";
import { RecordingLog } from "../log.js";
import { ExplorerError } from "../openings/explorer-client.js";
import { IdeaSessionError } from "../openings/repertoire-ideas.js";

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
    const repertoire = {
      variation: "Classical Variation (4.c3)",
      ownMoves: 40,
      replies: 60,
      mainlineReplies: 12,
      engineReplies: 3,
      deepestPly: 28,
      created: 100,
      removedReplies: 0,
      requests: 80,
      cacheHits: 0,
      truncated: false,
      positionsCutByTime: 2,
      shallowestDepth: 11,
    };
    const ideas = { considered: 40, generated: 38, rejected: 5, empty: 2 };
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
        generateRepertoireOpenings: async () => {
          calls.push("repertoire");
          return repertoire;
        },
        generateRepertoireIdeas: async () => {
          calls.push("repertoire-ideas");
          return ideas;
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

    it("runs only the repertoire source when asked for it, and logs its counts", async () => {
      const calls: string[] = [];
      const log = new RecordingLog();
      const app = buildApp({
        db: db(),
        log,
        generateOpenings: async () => own,
        generateRepertoireOpenings: async () => {
          calls.push("repertoire");
          return repertoire;
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["repertoire"] },
      });
      await app.close();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ repertoire });
      expect(calls).toEqual(["repertoire"]);
      expect(log.named("openings.generate")[0]?.fields).toMatchObject({
        sources: ["repertoire"],
        result: { repertoire: { ownMoves: 40, replies: 60, deepestPly: 28 } },
      });
    });

    it("never builds the repertoire without being asked", async () => {
      const calls: string[] = [];
      await post(calls);
      await post(calls, { sources: ["own", "explorer", "italian"] });
      expect(calls).not.toContain("repertoire");
    });

    it("answers 404 when the repertoire source is not wired", async () => {
      const app = buildApp({ db: db(), generateOpenings: async () => own });
      const response = await app.inject({
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["repertoire"] },
      });
      await app.close();
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "repertoire_unavailable" });
    });

    it("refuses a repertoire run while an explorer run is going", async () => {
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
        generateRepertoireOpenings: async () => repertoire,
      });
      const first = app.inject({
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["explorer"] },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await app.inject({
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["repertoire"] },
      });
      release();
      expect((await first).statusCode).toBe(200);
      await app.close();
      expect(second.statusCode).toBe(409);
    });

    it("accepts all four sources in one body and runs them in order", async () => {
      const calls: string[] = [];
      const response = await post(calls, { sources: ["own", "explorer", "italian", "repertoire"] });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ own, explorer, italian, repertoire });
      expect(calls).toEqual(["own", "explorer", "italian", "repertoire"]);
    });

    it("runs only the repertoire-ideas source when asked for it, and logs its counts", async () => {
      const calls: string[] = [];
      const log = new RecordingLog();
      const app = buildApp({
        db: db(),
        log,
        generateOpenings: async () => own,
        generateRepertoireIdeas: async () => {
          calls.push("repertoire-ideas");
          return ideas;
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["repertoire-ideas"] },
      });
      await app.close();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ repertoireIdeas: ideas });
      expect(calls).toEqual(["repertoire-ideas"]);
      expect(log.named("openings.generate")[0]?.fields).toMatchObject({
        sources: ["repertoire-ideas"],
        result: { repertoireIdeas: { generated: 38, rejected: 5, empty: 2 } },
      });
    });

    it("never writes the ideas without being asked", async () => {
      const calls: string[] = [];
      await post(calls);
      await post(calls, { sources: ["own", "explorer", "italian", "repertoire"] });
      expect(calls).not.toContain("repertoire-ideas");
    });

    it("answers 404 when the ideas batch is not injected", async () => {
      const app = buildApp({ db: db(), generateOpenings: async () => own });
      const response = await app.inject({
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["repertoire-ideas"] },
      });
      await app.close();
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: "repertoire_ideas_unavailable" });
    });

    it("refuses a second ideas run while one is going", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = buildApp({
        db: db(),
        generateOpenings: async () => own,
        generateRepertoireIdeas: async () => {
          await gate;
          return ideas;
        },
      });
      const request = {
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["repertoire-ideas"] },
      } as const;
      const first = app.inject(request);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await app.inject(request);
      release();
      expect((await first).statusCode).toBe(200);
      const third = await app.inject(request);
      await app.close();
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: "already_running" });
      expect(third.statusCode).toBe(200);
    });

    it("refuses an ideas run while a combined run is still on its earlier steps", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = buildApp({
        db: db(),
        generateOpenings: async () => own,
        generateRepertoireOpenings: async () => {
          await gate;
          return repertoire;
        },
        generateRepertoireIdeas: async () => ideas,
      });
      const run = (sources: string[]) =>
        app.inject({ method: "POST", url: "/api/openings/generate", payload: { sources } });
      const first = run(["repertoire", "repertoire-ideas"]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await run(["repertoire-ideas"]);
      release();
      expect((await first).statusCode).toBe(200);
      await app.close();
      expect(second.statusCode).toBe(409);
    });

    it("frees the ideas guard when the run fails", async () => {
      let fail = true;
      const app = buildApp({
        db: db(),
        generateOpenings: async () => own,
        generateRepertoireIdeas: async () => {
          if (fail) throw new IdeaSessionError("5-hour limit reached");
          return ideas;
        },
      });
      const run = () =>
        app.inject({
          method: "POST",
          url: "/api/openings/generate",
          payload: { sources: ["repertoire-ideas"] },
        });
      expect((await run()).statusCode).toBe(502);
      fail = false;
      expect((await run()).statusCode).toBe(200);
      await app.close();
    });

    it("reports a session that stopped answering as a 502 naming the ideas", async () => {
      const app = buildApp({
        db: db(),
        generateOpenings: async () => own,
        generateRepertoireIdeas: async () => {
          throw new IdeaSessionError("5-hour limit reached");
        },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["repertoire-ideas"] },
      });
      await app.close();
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        error: "ideas_unavailable",
        message: "5-hour limit reached",
      });
    });

    it("accepts all five sources in one body and runs the ideas last", async () => {
      const calls: string[] = [];
      const response = await post(calls, {
        sources: ["repertoire-ideas", "repertoire", "italian", "explorer", "own"],
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        own,
        explorer,
        italian,
        repertoire,
        repertoireIdeas: ideas,
      });
      expect(calls).toEqual(["own", "explorer", "italian", "repertoire", "repertoire-ideas"]);
    });

    it.each(["explorer", "italian", "repertoire"])(
      "refuses the %s source while a repertoire run is going",
      async (source) => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const app = buildApp({
          db: db(),
          generateOpenings: async () => own,
          generateExplorerOpenings: async () => explorer,
          generateItalianOpenings: async () => italian,
          generateRepertoireOpenings: async () => {
            await gate;
            return repertoire;
          },
        });
        const run = (sources: string[]) =>
          app.inject({ method: "POST", url: "/api/openings/generate", payload: { sources } });
        const first = run(["repertoire"]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const second = run([source]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        release();
        expect((await first).statusCode).toBe(200);
        expect((await second).statusCode).toBe(409);
        await app.close();
      },
    );
  });
});
