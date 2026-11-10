import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpeningDrillsResponseSchema, UNNAMED_OPENING } from "@chess-coach/shared";
import { Chess } from "chess.js";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { Clock } from "../clock.js";
import { setGrading } from "../db/games.js";
import { type Database, openDatabase } from "../db/open.js";
import { recordPuzzleAttempt } from "../db/puzzles.js";
import { createRepertoireVariation } from "../db/repertoires.js";
import type { Searcher, SearchRequest, SearchResult } from "../engine/uci.js";
import { importFinishedGame } from "../import/pgn.js";
import { RecordingLog } from "../log.js";
import { ExplorerError } from "../openings/explorer-client.js";
import { generateOpeningPuzzles } from "../openings/from-games.js";
import { RepertoireBranchError, type RepertoirePoints } from "../openings/from-repertoire.js";
import { parseOpeningTable } from "../openings/names.js";
import { IdeaSessionError } from "../openings/repertoire-ideas.js";
import { registerOpeningDrillRoutes } from "./openings.js";

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
      planChoices: 7,
      points: { effectiveness: 2, soundness: 2, learnability: 2 },
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

    describe("with a root", () => {
      const buildRooted = (roots: Array<readonly string[] | undefined>, log?: RecordingLog) =>
        buildApp({
          db: db(),
          ...(log ? { log } : {}),
          generateOpenings: async () => own,
          generateRepertoireOpenings: async (root) => {
            roots.push(root);
            return repertoire;
          },
        });
      const postRooted = async (app: ReturnType<typeof buildApp>, payload: object) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/openings/generate",
          payload,
        });
        await app.close();
        return response;
      };

      it("hands the generator the root, and nothing when the body has none", async () => {
        const roots: Array<readonly string[] | undefined> = [];
        const withRoot = await postRooted(buildRooted(roots), {
          sources: ["repertoire"],
          root: ["e4", "d5"],
        });
        const without = await postRooted(buildRooted(roots), { sources: ["repertoire"] });
        expect(withRoot.statusCode).toBe(200);
        expect(withRoot.json()).toEqual({ repertoire });
        expect(without.statusCode).toBe(200);
        expect(roots).toEqual([["e4", "d5"], undefined]);
      });

      it("hands the generator the line as the board writes it", async () => {
        const roots: Array<readonly string[] | undefined> = [];
        await postRooted(buildRooted(roots), { sources: ["repertoire"], root: ["e2e4", "d7d5"] });
        expect(roots).toEqual([["e4", "d5"]]);
      });

      it("logs the root with the run", async () => {
        const log = new RecordingLog();
        await postRooted(buildRooted([], log), { sources: ["repertoire"], root: ["e4", "c6"] });
        expect(log.named("openings.generate")[0]?.fields).toMatchObject({
          sources: ["repertoire"],
          root: ["e4", "c6"],
        });
      });

      it.each([
        ["an illegal move", ["e4", "d4"]],
        ["a root that does not start with e4", ["d4", "d5"]],
        ["a root that ends on a White move", ["e4", "d5", "exd5"]],
        ["more than 8 plies", ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6", "d4", "exd4"]],
        ["a White move other than the setup move", ["e4", "e5", "Bc4", "Nf6"]],
        ["an empty root", []],
        ["moves that are not text", [4, 5]],
        ["a root that is not a list", "e4 d5"],
      ])("refuses %s with invalid_root and starts no run", async (_label, root) => {
        const roots: Array<readonly string[] | undefined> = [];
        const response = await postRooted(buildRooted(roots), { sources: ["repertoire"], root });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: "invalid_root" });
        expect(roots).toEqual([]);
      });

      // Every other rule accepts this root, so it is the end-on-Black rule alone that refuses it.
      it("refuses a root that ends on White's move and says Black must end it", async () => {
        const roots: Array<readonly string[] | undefined> = [];
        const response = await postRooted(buildRooted(roots), {
          sources: ["repertoire"],
          root: ["e4"],
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error: "invalid_root",
          message: "the root must end on Black's move",
        });
        expect(roots).toEqual([]);
      });

      it("refuses a bad root before it runs the sources that come first", async () => {
        const calls: string[] = [];
        const response = await postRooted(build(calls), {
          sources: ["own", "repertoire"],
          root: ["d4", "d5"],
        });
        expect(response.statusCode).toBe(400);
        expect(calls).toEqual([]);
      });

      it("reads the root for the repertoire source only", async () => {
        const roots: Array<readonly string[] | undefined> = [];
        const response = await postRooted(buildRooted(roots), {
          sources: ["own"],
          root: ["d4", "d5"],
        });
        expect(response.statusCode).toBe(200);
        expect(roots).toEqual([]);
      });
    });

    describe("with a branch", () => {
      const ITALIAN = ["e4", "e5", "Nf3", "Nc6", "Bc4"];
      const D3_BRANCH = [...ITALIAN, "Bc5", "d3"];
      type Handed = { root: readonly string[] | undefined; branch: readonly string[] | undefined };
      const buildBranched = (
        handed: Handed[],
        options: { log?: RecordingLog; refuse?: string } = {},
      ) =>
        buildApp({
          db: db(),
          ...(options.log ? { log: options.log } : {}),
          generateOpenings: async () => own,
          generateRepertoireOpenings: async (root, branch) => {
            handed.push({ root, branch });
            if (options.refuse) throw new RepertoireBranchError(options.refuse);
            return repertoire;
          },
        });
      const postBranched = async (app: ReturnType<typeof buildApp>, payload: object) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/openings/generate",
          payload,
        });
        await app.close();
        return response;
      };

      it("hands the generator the branch as the board writes it, with no root", async () => {
        const handed: Handed[] = [];
        const response = await postBranched(buildBranched(handed), {
          sources: ["repertoire"],
          branch: ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "d2d3"],
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ repertoire });
        expect(handed).toEqual([{ root: undefined, branch: D3_BRANCH }]);
      });

      it("logs the branch with the run", async () => {
        const log = new RecordingLog();
        await postBranched(buildBranched([], { log }), {
          sources: ["repertoire"],
          branch: D3_BRANCH,
        });
        expect(log.named("openings.generate")[0]?.fields).toMatchObject({
          sources: ["repertoire"],
          branch: D3_BRANCH,
        });
      });

      it.each([
        ["a branch that is not a list", { branch: "e4 e5" }],
        ["an illegal move", { branch: [...ITALIAN, "Bc5", "Ke3"] }],
        ["a branch that ends on Black's move", { branch: [...D3_BRANCH, "Nf6"] }],
        ["a branch that leaves the Italian", { branch: ["e4", "d5", "exd5"] }],
        ["a branch with a root", { branch: D3_BRANCH, root: ["e4", "d5"] }],
      ])("refuses %s with invalid_branch and starts no run", async (_label, body) => {
        const handed: Handed[] = [];
        const response = await postBranched(buildBranched(handed), {
          sources: ["repertoire"],
          ...body,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: "invalid_branch" });
        expect(handed).toEqual([]);
      });

      it("reads the branch for the repertoire source only", async () => {
        const handed: Handed[] = [];
        const response = await postBranched(buildBranched(handed), {
          sources: ["own"],
          branch: "not a line",
        });
        expect(response.statusCode).toBe(200);
        expect(handed).toEqual([]);
      });

      it("answers 409 with the generator's words when the data refuses the branch", async () => {
        const refuse = "4.d3 is already the move of Classical Variation (4.c3)";
        const log = new RecordingLog();
        const response = await postBranched(buildBranched([], { log, refuse }), {
          sources: ["repertoire"],
          branch: D3_BRANCH,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ error: "branch_refused", message: refuse });
        expect(log.named("openings.generate_failed")[0]?.fields).toMatchObject({
          branch: D3_BRANCH,
        });
      });
    });

    describe("with rebuild", () => {
      type Handed = { root: readonly string[] | undefined; rebuild: boolean | undefined };
      const buildRebuilding = (handed: Handed[], log?: RecordingLog) =>
        buildApp({
          db: db(),
          ...(log ? { log } : {}),
          generateOpenings: async () => own,
          generateRepertoireOpenings: async (root, _branch, rebuild) => {
            handed.push({ root, rebuild });
            return repertoire;
          },
        });
      const postRebuilding = async (app: ReturnType<typeof buildApp>, payload: object) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/openings/generate",
          payload,
        });
        await app.close();
        return response;
      };

      it("hands the generator rebuild true when asked, with or without a root, and false otherwise", async () => {
        const handed: Handed[] = [];
        const asked = await postRebuilding(buildRebuilding(handed), {
          sources: ["repertoire"],
          rebuild: true,
        });
        await postRebuilding(buildRebuilding(handed), {
          sources: ["repertoire"],
          root: ["e4", "d5"],
          rebuild: true,
        });
        await postRebuilding(buildRebuilding(handed), { sources: ["repertoire"], rebuild: false });
        await postRebuilding(buildRebuilding(handed), { sources: ["repertoire"] });
        expect(asked.statusCode).toBe(200);
        expect(asked.json()).toEqual({ repertoire });
        expect(handed).toEqual([
          { root: undefined, rebuild: true },
          { root: ["e4", "d5"], rebuild: true },
          { root: undefined, rebuild: false },
          { root: undefined, rebuild: false },
        ]);
      });

      it("logs a rebuild with the run, and no rebuild field on a run without one", async () => {
        const log = new RecordingLog();
        await postRebuilding(buildRebuilding([], log), { sources: ["repertoire"], rebuild: true });
        await postRebuilding(buildRebuilding([], log), { sources: ["repertoire"] });
        const [rebuilt, plain] = log.named("openings.generate");
        expect(rebuilt?.fields).toMatchObject({ sources: ["repertoire"], rebuild: true });
        expect(plain?.fields).not.toHaveProperty("rebuild");
      });

      it.each([
        ["a string", "true"],
        ["a number", 1],
        ["a list", [true]],
      ])("refuses a rebuild flag that is %s, and runs nothing", async (_label, rebuild) => {
        const handed: Handed[] = [];
        const response = await postRebuilding(buildRebuilding(handed), {
          sources: ["repertoire"],
          rebuild,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          error: "invalid_rebuild",
          message: "rebuild is true or false",
        });
        expect(handed).toEqual([]);
      });

      it("reads the rebuild flag for the repertoire source only", async () => {
        const handed: Handed[] = [];
        const response = await postRebuilding(buildRebuilding(handed), {
          sources: ["own"],
          rebuild: "not a flag",
        });
        expect(response.statusCode).toBe(200);
        expect(handed).toEqual([]);
      });
    });

    describe("with points", () => {
      const EVEN = { effectiveness: 2, soundness: 2, learnability: 2 };
      const ON_SOUNDNESS = { effectiveness: 0, soundness: 6, learnability: 0 };
      type Handed = { points: RepertoirePoints | undefined };
      const buildWeighing = (handed: Handed[], log?: RecordingLog) =>
        buildApp({
          db: db(),
          ...(log ? { log } : {}),
          generateOpenings: async () => own,
          generateRepertoireOpenings: async (_root, _branch, _rebuild, points) => {
            handed.push({ points });
            return repertoire;
          },
        });
      const postWeighing = async (app: ReturnType<typeof buildApp>, payload: object) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/openings/generate",
          payload,
        });
        await app.close();
        return response;
      };

      it("hands the generator the points as given, and none where the body names none", async () => {
        const handed: Handed[] = [];
        const given = await postWeighing(buildWeighing(handed), {
          sources: ["repertoire"],
          points: ON_SOUNDNESS,
        });
        await postWeighing(buildWeighing(handed), { sources: ["repertoire"] });
        await postWeighing(buildWeighing(handed), { sources: ["repertoire"], points: null });
        expect(given.statusCode).toBe(200);
        expect(given.json()).toEqual({ repertoire });
        expect(handed).toEqual([
          { points: ON_SOUNDNESS },
          { points: undefined },
          { points: undefined },
        ]);
      });

      it("logs the points with the run, and no points field on a run without them", async () => {
        const log = new RecordingLog();
        await postWeighing(buildWeighing([], log), { sources: ["repertoire"], points: EVEN });
        await postWeighing(buildWeighing([], log), { sources: ["repertoire"] });
        const [weighed, plain] = log.named("openings.generate");
        expect(weighed?.fields).toMatchObject({ sources: ["repertoire"], points: EVEN });
        expect(plain?.fields).not.toHaveProperty("points");
      });

      it.each([
        ["text", "2,2,2", "points is an object with effectiveness, soundness and learnability"],
        ["a list", [2, 2, 2], "points is an object with effectiveness, soundness and learnability"],
        [
          "a measure left out",
          { effectiveness: 3, soundness: 3 },
          "points hold effectiveness, soundness and learnability, and nothing else",
        ],
        [
          "a measure added",
          { ...EVEN, intuition: 0 },
          "points hold effectiveness, soundness and learnability, and nothing else",
        ],
        [
          "a number written as text",
          { ...EVEN, effectiveness: "2" },
          "each measure is a whole number of points, 0 or more",
        ],
        [
          "a fraction",
          { effectiveness: 2.5, soundness: 1.5, learnability: 2 },
          "each measure is a whole number of points, 0 or more",
        ],
        [
          "a negative number",
          { effectiveness: 7, soundness: -1, learnability: 0 },
          "each measure is a whole number of points, 0 or more",
        ],
        [
          "5 points",
          { effectiveness: 2, soundness: 2, learnability: 1 },
          "the points add up to 6, not 5",
        ],
        [
          "7 points",
          { effectiveness: 3, soundness: 2, learnability: 2 },
          "the points add up to 6, not 7",
        ],
        [
          "no points",
          { effectiveness: 0, soundness: 0, learnability: 0 },
          "the points add up to 6, not 0",
        ],
      ])("refuses %s with invalid_points and starts no run", async (_label, points, message) => {
        const handed: Handed[] = [];
        const response = await postWeighing(buildWeighing(handed), {
          sources: ["repertoire"],
          points,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: "invalid_points", message });
        expect(handed).toEqual([]);
      });

      it("refuses bad points before it runs the sources that come first", async () => {
        const calls: string[] = [];
        const response = await postWeighing(build(calls), {
          sources: ["own", "repertoire"],
          points: { ...EVEN, learnability: 3 },
        });
        expect(response.statusCode).toBe(400);
        expect(calls).toEqual([]);
      });

      it("reads the points for the repertoire source only", async () => {
        const handed: Handed[] = [];
        const response = await postWeighing(buildWeighing(handed), {
          sources: ["own"],
          points: "not points",
        });
        expect(response.statusCode).toBe(200);
        expect(handed).toEqual([]);
      });
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

describe("GET /api/openings/drills", () => {
  const NOW = new Date("2026-11-10T12:00:00.000Z");
  const DAY_MS = 24 * 60 * 60 * 1000;
  const clock: Clock = { now: () => NOW };
  const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();
  const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  let stored = 0;
  function addDrill(
    store: Database,
    color: "white" | "black",
    openingName: string | null,
    motif = `opening-${color}`,
  ): string {
    stored += 1;
    const id = `own:fixture-${stored}`;
    store
      .prepare(
        `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation, opening_name)
         VALUES (?, 'own-games', ?, 'beginner', ?, '["e2e4"]', '["e4"]', 'why', ?)`,
      )
      .run(id, motif, START, openingName);
    return id;
  }

  function attempt(store: Database, puzzleId: string, attemptedAt: string, firstTry: boolean) {
    recordPuzzleAttempt(store, {
      puzzleId,
      attemptedAt,
      solved: firstTry,
      answered: ["e2e4"],
      failedPly: firstTry ? null : 0,
      firstTry,
      tries: firstTry ? 0 : 1,
      gaveUp: false,
    });
  }

  async function drills(store: Database) {
    const app = Fastify();
    registerOpeningDrillRoutes(app, store, clock);
    const response = await app.inject({ method: "GET", url: "/api/openings/drills" });
    await app.close();
    expect(response.statusCode).toBe(200);
    return OpeningDrillsResponseSchema.parse(response.json());
  }

  // Ten White positions per game, the first three shared, and the names the table gives them.
  const ITALIAN_GAME =
    '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3 d6 6. O-O O-O 7. Bb3 a6 8. Nbd2 Ba7 9. h3 h6 10. Re1 Re8 1-0';
  const RUY_LOPEZ =
    '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 1-0';

  const keyAfter = (...sans: string[]): string => {
    const board = new Chess();
    for (const san of sans) board.move(san);
    return board.fen().split(" ").slice(0, 4).join(" ");
  };
  const MAIN = ["e4", "e5", "Nf3", "Nc6"];
  const names = parseOpeningTable(
    [
      "eco\tname\tpgn\tuci\tepd",
      `C50\tItalian Game\t1. e4 e5 2. Nf3 Nc6 3. Bc4\te2e4\t${keyAfter(...MAIN, "Bc4")}`,
      `C50\tItalian Game: Giuoco Piano\t1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5\te2e4\t${keyAfter(...MAIN, "Bc4", "Bc5")}`,
      `C60\tRuy Lopez\t1. e4 e5 2. Nf3 Nc6 3. Bb5\te2e4\t${keyAfter(...MAIN, "Bb5")}`,
      `C60\tRuy Lopez: Morphy Defense\t1. e4 e5 2. Nf3 Nc6 3. Bb5 a6\te2e4\t${keyAfter(...MAIN, "Bb5", "a6")}`,
      "",
    ].join("\n"),
  );

  /** Answers every position with its first two legal moves, far enough apart to count as clear. */
  class FirstTwoMovesSearcher implements Searcher {
    async search(request: SearchRequest): Promise<SearchResult> {
      const [first, second] = new Chess(request.fen).moves({ verbose: true });
      if (!first || !second) throw new Error("fixture position has fewer than two moves");
      const uci = (move: { from: string; to: string }): string => `${move.from}${move.to}`;
      return {
        fen: request.fen,
        bestmove: uci(first),
        lines: [
          { moves: [uci(first)], score: 100 },
          { moves: [uci(second)], score: 20 },
        ],
      };
    }
  }

  it("answers an empty drill with no families", async () => {
    expect(await drills(db())).toEqual({ white: [], black: [] });
  });

  it("gets two families from positions stored from two games in different openings", async () => {
    const store = db();
    for (const [pgn, id] of [
      [ITALIAN_GAME, "italian"],
      [RUY_LOPEZ, "ruy"],
    ] as const) {
      const gameId = importFinishedGame(store, {
        pgn,
        playerColor: "white",
        source: "pgn",
        sourceId: id,
      });
      if (gameId === null) throw new Error("fixture game was not imported");
      setGrading(store, gameId, "done");
    }
    await generateOpeningPuzzles(store, new FirstTwoMovesSearcher(), names);
    const italian = store
      .prepare("SELECT id FROM puzzles WHERE opening_name LIKE 'Italian Game%' ORDER BY id")
      .all() as { id: string }[];
    const [first, second] = italian.map((row) => row.id) as [string, string];
    attempt(store, first, daysAgo(5), true);
    attempt(store, first, daysAgo(2), false);
    attempt(store, second, daysAgo(29), true);
    // Older than the window, so it counts for nothing.
    attempt(store, second, daysAgo(31), true);

    expect(await drills(store)).toEqual({
      white: [
        {
          opening: "Italian Game",
          positions: 7,
          attempts_30d: 3,
          first_try_30d: 2,
          repertoire_id: null,
        },
        {
          opening: "Ruy Lopez",
          positions: 7,
          attempts_30d: 0,
          first_try_30d: 0,
          repertoire_id: null,
        },
        // The start and the two moves shared by both games are named by neither opening.
        {
          opening: UNNAMED_OPENING,
          positions: 3,
          attempts_30d: 0,
          first_try_30d: 0,
          repertoire_id: null,
        },
      ],
      black: [],
    });
  });

  it("folds every name that shares a family into one entry", async () => {
    const store = db();
    addDrill(store, "white", "Italian Game");
    addDrill(store, "white", "Italian Game: Two Knights Defense");
    addDrill(store, "white", "Italian Game: Giuoco Piano");
    addDrill(store, "white", "Italian Game: Giuoco Piano");
    addDrill(store, "white", "Sicilian Defense: Najdorf Variation, English Attack");
    const { white } = await drills(store);
    expect(white.map(({ opening, positions }) => [opening, positions])).toEqual([
      ["Italian Game", 4],
      ["Sicilian Defense", 1],
    ]);
  });

  it("lists the positions with no name as one entry per colour, last whatever their number", async () => {
    const store = db();
    for (const name of [null, null, "", "   ", ": Variation"]) addDrill(store, "white", name);
    addDrill(store, "white", "Scandinavian Defense");
    addDrill(store, "black", null);
    const { white, black } = await drills(store);
    expect(white.map(({ opening, positions }) => [opening, positions])).toEqual([
      ["Scandinavian Defense", 1],
      [UNNAMED_OPENING, 5],
    ]);
    expect(black.map(({ opening, positions }) => [opening, positions])).toEqual([
      [UNNAMED_OPENING, 1],
    ]);
  });

  it("keeps the colours apart and reads only the drill of the student's games", async () => {
    const store = db();
    addDrill(store, "white", "Sicilian Defense");
    addDrill(store, "black", "Sicilian Defense");
    addDrill(store, "black", "Sicilian Defense");
    addDrill(store, "white", "Italian Game", "opening-italian");
    addDrill(store, "white", "Fork Opening", "fork");
    const { white, black } = await drills(store);
    expect(white.map(({ opening, positions }) => [opening, positions])).toEqual([
      ["Sicilian Defense", 1],
    ]);
    expect(black.map(({ opening, positions }) => [opening, positions])).toEqual([
      ["Sicilian Defense", 2],
    ]);
  });

  it("orders families by their positions, then by name", async () => {
    const store = db();
    for (const name of ["Vienna Game", "Scotch Game", "Scotch Game", "Alekhine Defense"]) {
      addDrill(store, "white", name);
    }
    const { white } = await drills(store);
    expect(white.map(({ opening }) => opening)).toEqual([
      "Scotch Game",
      "Alekhine Defense",
      "Vienna Game",
    ]);
  });

  it("counts the attempts of the last 30 days, both ends of the window included", async () => {
    const store = db();
    const id = addDrill(store, "white", "Italian Game");
    attempt(store, id, daysAgo(30), true);
    attempt(store, id, new Date(NOW.getTime() - 30 * DAY_MS - 1).toISOString(), true);
    attempt(store, id, NOW.toISOString(), false);
    attempt(store, id, new Date(NOW.getTime() + 1).toISOString(), true);
    const { white } = await drills(store);
    expect(white).toEqual([
      {
        opening: "Italian Game",
        positions: 1,
        attempts_30d: 2,
        first_try_30d: 1,
        repertoire_id: null,
      },
    ]);
  });

  it("counts the attempts of every position of a family together, and each position once", async () => {
    const store = db();
    const one = addDrill(store, "white", "Italian Game");
    const two = addDrill(store, "white", "Italian Game: Giuoco Piano");
    attempt(store, one, daysAgo(1), true);
    attempt(store, one, daysAgo(2), true);
    attempt(store, two, daysAgo(3), false);
    const { white } = await drills(store);
    expect(white).toEqual([
      {
        opening: "Italian Game",
        positions: 2,
        attempts_30d: 3,
        first_try_30d: 2,
        repertoire_id: null,
      },
    ]);
  });

  it("shows a family with no attempt in the window with its positions and no attempts", async () => {
    const store = db();
    const id = addDrill(store, "white", "Scandinavian Defense");
    addDrill(store, "white", "Scandinavian Defense");
    attempt(store, id, daysAgo(60), true);
    const { white } = await drills(store);
    expect(white).toEqual([
      {
        opening: "Scandinavian Defense",
        positions: 2,
        attempts_30d: 0,
        first_try_30d: 0,
        repertoire_id: null,
      },
    ]);
  });

  it("names the first variation stored under the family on the same side", async () => {
    const store = db();
    const stores = (side: "white" | "black", groupName: string, variationName: string): number =>
      createRepertoireVariation(store, { side, groupName, variationName }).id;
    const italian = stores("white", "Italian Game", "Classical Variation (4.c3)");
    stores("white", "Italian Game", "Giuoco Pianissimo (4.d3)");
    const scandinavian = stores(
      "white",
      "Scandinavian Defense",
      "Mieses-Kotroc Variation (2.exd5)",
    );
    const blackSicilian = stores("black", "Sicilian Defense", "Open Sicilian");
    // A group named by the full name is another opening, so it does not claim the family.
    stores("white", "Caro-Kann Defense: Advance Variation", "Short Variation");
    for (const name of [
      "Italian Game",
      "Scandinavian Defense",
      "Sicilian Defense",
      "Caro-Kann Defense",
    ]) {
      addDrill(store, "white", name);
    }
    addDrill(store, "black", "Sicilian Defense");
    addDrill(store, "black", "Italian Game");
    const { white, black } = await drills(store);
    const ids = (entries: typeof white) =>
      Object.fromEntries(entries.map((entry) => [entry.opening, entry.repertoire_id]));
    expect(ids(white)).toEqual({
      "Italian Game": italian,
      "Scandinavian Defense": scandinavian,
      "Sicilian Defense": null,
      "Caro-Kann Defense": null,
    });
    expect(ids(black)).toEqual({ "Sicilian Defense": blackSicilian, "Italian Game": null });
  });

  it("is mounted with the database, whether or not a generator is configured", async () => {
    const app = buildApp({ db: db() });
    const response = await app.inject({ method: "GET", url: "/api/openings/drills" });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ white: [], black: [] });
  });
});
