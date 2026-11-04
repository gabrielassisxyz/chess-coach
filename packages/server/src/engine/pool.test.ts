import { describe, expect, it } from "vitest";
import { FakeEngineProcess, type GoRequest } from "../../test/support/fake-engine-process.js";
import { AnalyzeSuperseded, EnginePool, type EngineRole } from "./pool.js";

const FEN_A = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FEN_B = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const FEN_C = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

const LEGAL_MOVE: Record<string, string> = { [FEN_A]: "e2e4", [FEN_B]: "e7e5", [FEN_C]: "g1f3" };

/** The evaluation engine holds every search until the test releases it, in arrival order. */
function gatedPool() {
  const started: string[] = [];
  const gates: Array<() => void> = [];
  const processes = new Map<EngineRole, FakeEngineProcess>();
  const pool = new EnginePool((role) => {
    const fake = new FakeEngineProcess(({ fen, command, emit }: GoRequest) => {
      if (role === "play") return emit("bestmove e2e4");
      started.push(`${fen}|${command}`);
      gates.push(() => emit("bestmove " + LEGAL_MOVE[fen]));
    });
    processes.set(role, fake);
    return fake;
  });
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
