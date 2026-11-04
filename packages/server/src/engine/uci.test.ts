import { describe, expect, it } from "vitest";
import {
  FakeEngineProcess,
  type GoRequest,
  loadFixture,
  replayFixture,
} from "../../test/support/fake-engine-process.js";
import { UciEngine } from "./uci.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FAST = { startupMs: 40, readyMs: 40, searchSlackMs: 40, quitGraceMs: 40 };

function scriptedSpawner(...behaviors: Array<(request: GoRequest) => void>) {
  const processes: FakeEngineProcess[] = [];
  const spawner = () => {
    const behavior = behaviors[processes.length] ?? behaviors.at(-1);
    if (!behavior) throw new Error("no behavior scripted");
    const fake = new FakeEngineProcess(behavior);
    processes.push(fake);
    return fake;
  };
  return { spawner, processes };
}

const silent = (): void => {};
const opening = replayFixture(loadFixture("opening"));

describe("UciEngine search", () => {
  it("returns the recorded lines tagged with the searched FEN", async () => {
    const { spawner } = scriptedSpawner(replayFixture(loadFixture("multipv")));
    const engine = new UciEngine(spawner, FAST);
    await engine.start();
    const result = await engine.search({ fen: START, depth: 12, multipv: 3 });
    expect(result.fen).toBe(START);
    expect(result.bestmove).toBe("e2e4");
    expect(result.lines).toHaveLength(3);
    expect(result.lines.map((line) => line.moves[0])).toEqual(["e2e4", "g1f3", "d2d4"]);
    await engine.stop();
  });

  it("runs concurrent searches one at a time, in call order", async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const { spawner, processes } = scriptedSpawner(({ fen, command, emit }) => {
      order.push(command);
      const finish = (): void => emit(`bestmove ${fen === START ? "e2e4" : "e7e5"}`);
      if (fen === START) releases.push(finish);
      else finish();
    });
    const engine = new UciEngine(spawner, FAST);
    await engine.start();
    const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const first = engine.search({ fen: START, depth: 1 });
    const second = engine.search({ fen: afterE4, depth: 2 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(order).toEqual(["go depth 1"]);
    releases[0]?.();
    expect((await first).bestmove).toBe("e2e4");
    expect((await second).bestmove).toBe("e7e5");
    expect(order).toEqual(["go depth 1", "go depth 2"]);
    expect(processes).toHaveLength(1);
  });

  it("sends movetime as the limit when one is given", async () => {
    const { spawner, processes } = scriptedSpawner(opening);
    const engine = new UciEngine(spawner, FAST);
    await engine.start();
    await engine.search({ fen: START, movetime: 30 });
    expect(processes[0]?.sent).toContain("go movetime 30");
  });
});

describe("UciEngine faults", () => {
  it("rejects a silent search with EngineFault and works again after one restart", async () => {
    const { spawner, processes } = scriptedSpawner(silent, opening);
    const engine = new UciEngine(spawner, FAST);
    await engine.setOption("Hash", "16");
    await engine.start();
    await expect(engine.search({ fen: START, depth: 1 })).rejects.toMatchObject({
      name: "EngineFault",
      reason: "timeout",
    });
    expect(processes[0]?.killed).toBe(true);
    const result = await engine.search({ fen: START, depth: 1 });
    expect(result.bestmove).toBe("e2e4");
    expect(processes).toHaveLength(2);
    expect(processes[1]?.sent).toContain("setoption name Hash value 16");
  });

  it("propagates a failed restart and stops spawning until start() is called", async () => {
    const processes: FakeEngineProcess[] = [];
    const engine = new UciEngine(() => {
      const fake = new FakeEngineProcess(silent);
      // Only the first process completes the handshake; the restarted one is mute.
      if (processes.length > 0) fake.send = () => {};
      processes.push(fake);
      return fake;
    }, FAST);
    await engine.start();
    await expect(engine.search({ fen: START, depth: 1 })).rejects.toMatchObject({
      reason: "timeout",
    });
    await expect(engine.search({ fen: START, depth: 1 })).rejects.toMatchObject({
      reason: "timeout",
    });
    await expect(engine.search({ fen: START, depth: 1 })).rejects.toMatchObject({
      reason: "exited",
    });
    expect(processes).toHaveLength(2);
  });

  it("rejects the pending search when the process exits", async () => {
    const { spawner } = scriptedSpawner(({ emit }) => {
      emit("info depth 1 score cp 10 pv e2e4");
    });
    const engine = new UciEngine(spawner, FAST);
    await engine.start();
    const pending = engine.search({ fen: START, depth: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The second spawn does not exist yet; exit the only process.
    (engine as unknown as { process: FakeEngineProcess }).process.exit();
    await expect(pending).rejects.toMatchObject({ reason: "exited" });
  });
});

describe("UciEngine bestmove validation", () => {
  it("rejects a move that is illegal in the searched position", async () => {
    const { spawner } = scriptedSpawner(({ emit }) => emit("bestmove e2e5"));
    const engine = new UciEngine(spawner, FAST);
    await engine.start();
    await expect(engine.search({ fen: START, depth: 1 })).rejects.toMatchObject({
      reason: "bad-bestmove",
    });
  });

  it("rejects (none) in a position that still has legal moves", async () => {
    const { spawner } = scriptedSpawner(({ emit }) => emit("bestmove (none)"));
    const engine = new UciEngine(spawner, FAST);
    await engine.start();
    await expect(engine.search({ fen: START, depth: 1 })).rejects.toMatchObject({
      reason: "bad-bestmove",
    });
  });

  it("accepts (none) when the position is checkmate", async () => {
    const { spawner } = scriptedSpawner(replayFixture(loadFixture("mate-in-one")));
    const engine = new UciEngine(spawner, FAST);
    await engine.start();
    const mated = "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4";
    const result = await engine.search({ fen: mated, depth: 16 });
    expect(result.bestmove).toBeNull();
    expect(result.lines[0]?.score).toBe(-10000);
  });
});

describe("UciEngine stop", () => {
  it("sends quit and does not kill a process that exits within the grace", async () => {
    const { spawner, processes } = scriptedSpawner(opening);
    const engine = new UciEngine(spawner, FAST);
    await engine.start();
    await engine.stop();
    expect(processes[0]?.sent).toContain("quit");
    expect(processes[0]?.killed).toBe(false);
  });

  it("kills a process that ignores quit once the grace has passed", async () => {
    const fake = new FakeEngineProcess(opening, false);
    const engine = new UciEngine(() => fake, FAST);
    await engine.start();
    await engine.stop();
    expect(fake.killed).toBe(true);
  });
});
