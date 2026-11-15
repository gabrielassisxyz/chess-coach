import { describe, expect, it } from "vitest";
import {
  openFixtureCache,
  storedSet,
  ThrowingEvalCache,
} from "../../test/support/eval-cache-fixture.js";
import { FakeEngineProcess, type GoRequest } from "../../test/support/fake-engine-process.js";
import { type EvalCache, openEvalCache } from "./eval-cache.js";
import { AnalyzeSuperseded, EnginePool, type EngineRole } from "./pool.js";

const FEN_A = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FEN_B = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const FEN_C = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

const LEGAL_MOVE: Record<string, string> = { [FEN_A]: "e2e4", [FEN_B]: "e7e5", [FEN_C]: "g1f3" };

/** The evaluation engine holds every search until the test releases it, in arrival order. */
function gatedPool(evalCache?: EvalCache) {
  const started: string[] = [];
  const gates: Array<() => void> = [];
  const processes = new Map<EngineRole, FakeEngineProcess>();
  const pool = new EnginePool(
    (role) => {
      const fake = new FakeEngineProcess(({ fen, command, emit }: GoRequest) => {
        if (role === "play") return emit("bestmove e2e4");
        started.push(`${fen}|${command}`);
        gates.push(() => emit("bestmove " + LEGAL_MOVE[fen]));
      });
      processes.set(role, fake);
      return fake;
    },
    {},
    evalCache,
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  return { pool, started, gates, settle, processes };
}

describe("EnginePool", () => {
  it("runs a live evaluation before a queued analyze", async () => {
    const { pool, started, gates, settle } = gatedPool();
    await pool.start();
    const running = pool.evaluation.search({ fen: FEN_A, depth: 16 });
    await settle();
    const analysis = pool.analyze(FEN_B);
    const live = pool.evaluation.search({ fen: FEN_C, depth: 16 });
    gates.shift()?.();
    await running;
    await settle();
    expect(started.map((entry) => entry.split("|")[0])).toEqual([FEN_A, FEN_C]);
    gates.shift()?.();
    await live;
    await settle();
    expect(started[2]).toBe(`${FEN_B}|go depth 18`);
    gates.shift()?.();
    expect((await analysis).fen).toBe(FEN_B);
  });

  it("keeps at most one analyze queued and lets a newer one replace it", async () => {
    const { pool, started, gates, settle } = gatedPool();
    await pool.start();
    const running = pool.evaluation.search({ fen: FEN_A, depth: 16 });
    await settle();
    const stale = pool.analyze(FEN_B);
    const staleOutcome = stale.catch((error: unknown) => error);
    const fresh = pool.analyze(FEN_C);
    expect(await staleOutcome).toBeInstanceOf(AnalyzeSuperseded);
    gates.shift()?.();
    await running;
    await settle();
    gates.shift()?.();
    expect((await fresh).fen).toBe(FEN_C);
    expect(started.map((entry) => entry.split("|")[0])).toEqual([FEN_A, FEN_C]);
  });

  it("asks for three lines at depth 18 when analyzing", async () => {
    const { pool, gates, settle, processes } = gatedPool();
    await pool.start();
    const analysis = pool.analyze(FEN_A);
    await settle();
    gates.shift()?.();
    await analysis;
    expect(processes.get("evaluation")?.sent).toContain("setoption name MultiPV value 3");
    expect(processes.get("evaluation")?.sent).toContain("go depth 18");
  });

  it("keeps the play engine independent of the evaluation queue", async () => {
    const { pool, gates, settle } = gatedPool();
    await pool.start();
    const blocked = pool.evaluation.search({ fen: FEN_A, depth: 16 });
    await settle();
    const move = await pool.play.search({ fen: FEN_A, depth: 1 });
    expect(move.bestmove).toBe("e2e4");
    gates.shift()?.();
    await blocked;
  });
});

// The position every cache case asks about, as the file keys it: the first four FEN fields.
const START_EPD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
const goCommandsOf = (process: FakeEngineProcess | undefined): string[] =>
  (process?.sent ?? []).filter((line) => line.startsWith("go "));

describe("EnginePool with an evaluation cache", () => {
  const threeLinesAtThirty = storedSet(30, [
    [19, "e2e4 e7e5"],
    [15, "d2d4 g8f6"],
    [14, "g1f3 d7d5"],
  ]);
  const cacheWithStart = (): EvalCache =>
    openFixtureCache([{ epd: START_EPD, sets: [threeLinesAtThirty] }]).cache;

  it("answers 2 lines at depth 20 from a set of 3 lines at depth 30 without a search", async () => {
    const { pool, processes, settle } = gatedPool(cacheWithStart());
    await pool.start();
    const answer = await pool.analyzeWith({ fen: FEN_A, depth: 20, multipv: 2, capMs: 4000 });
    // A search the cache should have spared would send its go a few ticks after the answer.
    await settle();
    expect(answer).toEqual({
      fen: FEN_A,
      bestmove: "e2e4",
      depth: 30,
      source: "cache",
      lines: [
        { moves: ["e2e4", "e7e5"], score: 19 },
        { moves: ["d2d4", "g8f6"], score: 15 },
      ],
    });
    expect(goCommandsOf(processes.get("evaluation"))).toEqual([]);
  });

  it("sends a request for 5 lines to the engine when the file holds 3", async () => {
    const { pool, gates, settle, processes } = gatedPool(cacheWithStart());
    await pool.start();
    const analysis = pool.analyzeWith({ fen: FEN_A, depth: 20, multipv: 5, capMs: 4000 });
    await settle();
    gates.shift()?.();
    const answer = await analysis;
    expect(answer.source).toBe("engine");
    expect(processes.get("evaluation")?.sent).toContain("setoption name MultiPV value 5");
    expect(goCommandsOf(processes.get("evaluation"))).toEqual(["go depth 20"]);
  });

  it("serves the coach's three lines at depth 18 from the file, and searches when it has two", async () => {
    const hit = gatedPool(cacheWithStart());
    await hit.pool.start();
    expect((await hit.pool.analyze(FEN_A)).source).toBe("cache");
    await hit.settle();
    expect(goCommandsOf(hit.processes.get("evaluation"))).toEqual([]);

    const twoLines = openFixtureCache([
      {
        epd: START_EPD,
        sets: [
          storedSet(30, [
            [19, "e2e4"],
            [15, "d2d4"],
          ]),
        ],
      },
    ]).cache;
    const miss = gatedPool(twoLines);
    await miss.pool.start();
    const analysis = miss.pool.analyze(FEN_A);
    await miss.settle();
    miss.gates.shift()?.();
    expect((await analysis).source).toBe("engine");
    expect(goCommandsOf(miss.processes.get("evaluation"))).toEqual(["go depth 18"]);
  });

  it("is asked nothing for a search by time, which has no depth to compare", async () => {
    const throwing = new ThrowingEvalCache();
    const { pool, gates, settle } = gatedPool(throwing);
    await pool.start();
    const analysis = pool.analyzeWith({ fen: FEN_A, movetime: 100 });
    await settle();
    gates.shift()?.();
    expect((await analysis).source).toBe("engine");
    expect(throwing.calls).toBe(0);
  });

  it("searches exactly as before when the setting is unset or the file is absent", async () => {
    for (const cache of [openEvalCache(null), openEvalCache("/nonexistent/evals.db")]) {
      const { pool, gates, settle, processes } = gatedPool(cache);
      await pool.start();
      const analysis = pool.analyze(FEN_A);
      await settle();
      gates.shift()?.();
      expect((await analysis).source).toBe("engine");
      expect(processes.get("evaluation")?.sent).toContain("setoption name MultiPV value 3");
      expect(goCommandsOf(processes.get("evaluation"))).toEqual(["go depth 18"]);
    }
  });

  it("replaces the analyze waiting for the engine when a newer request is answered from the file", async () => {
    const { pool, gates, settle } = gatedPool(cacheWithStart());
    await pool.start();
    const running = pool.evaluation.search({ fen: FEN_B, depth: 16 });
    await settle();
    const waiting = pool.analyzeWith({ fen: FEN_C, depth: 18, multipv: 1 });
    const waitingOutcome = waiting.catch((error: unknown) => error);
    const answered = await pool.analyzeWith({ fen: FEN_A, depth: 18, multipv: 1 });
    expect(answered.source).toBe("cache");
    expect(await waitingOutcome).toBeInstanceOf(AnalyzeSuperseded);
    gates.shift()?.();
    await running;
  });

  it("never reads the file for a live search or for the play engine", async () => {
    const throwing = new ThrowingEvalCache();
    const { pool, gates, settle } = gatedPool(throwing);
    await pool.start();
    const live = pool.evaluation.search({ fen: FEN_A, depth: 16 });
    await settle();
    gates.shift()?.();
    await live;
    expect((await pool.play.search({ fen: FEN_A, depth: 1 })).bestmove).toBe("e2e4");
    expect(throwing.calls).toBe(0);
  });
});
