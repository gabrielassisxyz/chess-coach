import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeEngineProcess,
  type GoRequest,
  loadFixture,
  replayFixture,
} from "../../test/support/fake-engine-process.js";
import { type SearchRequest, UciEngine } from "./uci.js";

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

  it("reports the depth the engine reached and that no cap cut the search", async () => {
    const { spawner } = scriptedSpawner(opening);
    const engine = new UciEngine(spawner, FAST);
    await engine.start();
    const result = await engine.search({ fen: START, depth: 16 });
    expect(result).toMatchObject({ bestmove: "e2e4", depth: 16, cutByTime: false });
  });

  it("reports the shallowest depth among the lines of a MultiPV search", async () => {
    const { spawner } = scriptedSpawner(({ emit }) => {
      emit("info depth 12 multipv 1 score cp 30 pv e2e4");
      emit("info depth 11 multipv 2 score cp 20 pv d2d4");
      emit("bestmove e2e4");
    });
    const engine = new UciEngine(spawner, FAST);
    await engine.start();
    const result = await engine.search({ fen: START, depth: 12, multipv: 2 });
    expect(result.lines).toHaveLength(2);
    expect(result.depth).toBe(11);
  });

  it("reports no depth when a line carries none", async () => {
    const { spawner } = scriptedSpawner(({ emit }) => {
      emit("info score cp 30 pv e2e4");
      emit("bestmove e2e4");
    });
    const engine = new UciEngine(spawner, FAST);
    await engine.start();
    const result = await engine.search({ fen: START, depth: 12 });
    expect(result.lines).toHaveLength(1);
    expect(result.depth).toBeUndefined();
  });
});

describe("UciEngine search deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function expectTimeoutAfter(
    request: Partial<SearchRequest>,
    allowedMs: number,
  ): Promise<void> {
    vi.useFakeTimers();
    const { spawner } = scriptedSpawner(silent);
    const engine = new UciEngine(spawner);
    await engine.start();
    let failure: unknown = null;
    const search = engine.search({ fen: START, depth: 16, ...request }).catch((error: unknown) => {
      failure = error;
    });
    // The first tick lets the search reach the process, which is when its deadline starts.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(allowedMs - 1);
    expect(failure).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await search;
    expect(failure).toMatchObject({
      name: "EngineFault",
      reason: "timeout",
      message: `no answer within ${allowedMs} ms`,
    });
  }

  it("keeps 5 s when the request gives no cap", () => expectTimeoutAfter({}, 5000));

  it("adds the slack to a movetime when the request gives no cap", () =>
    expectTimeoutAfter({ movetime: 1000 }, 6000));

  it("gives a capped search the slack after its cap to answer the stop", () =>
    expectTimeoutAfter({ capMs: 30_000 }, 35_000));
});

/** The base fake ignores `stop`; this one answers it the way the test says. */
function stoppableEngine(
  onGo: (request: GoRequest) => void,
  onStop: (emit: (line: string) => void) => void,
): FakeEngineProcess {
  const fake = new FakeEngineProcess(onGo);
  const send = fake.send.bind(fake);
  fake.send = (line) => {
    send(line);
    if (line === "stop") queueMicrotask(() => onStop((out) => fake.emit(out)));
  };
  return fake;
}

const layerMove = (layer: number): string => (layer % 2 === 1 ? "e2e4" : "d2d4");

/**
 * An engine that completes one more layer every `layerMs`. Layer N says `score cp 10N` and a move
 * that alternates with N, so the line an answer carries names the layer it came from. A stop is
 * answered with the last layer completed, as Stockfish does.
 */
function layeredEngine(layerMs: number): FakeEngineProcess {
  const pending: Array<ReturnType<typeof setTimeout>> = [];
  let completed = 0;
  return stoppableEngine(
    ({ command, emit }) => {
      const depth = Number(/depth (\d+)/.exec(command)?.[1]);
      for (let layer = 1; layer <= depth; layer++) {
        const line = `info depth ${layer} seldepth ${layer + 1} multipv 1 score cp ${layer * 10} pv ${layerMove(layer)}`;
        pending.push(
          setTimeout(() => {
            completed = layer;
            emit(line);
          }, layer * layerMs),
        );
      }
      pending.push(setTimeout(() => emit(`bestmove ${layerMove(depth)}`), depth * layerMs));
    },
    (emit) => {
      for (const timer of pending) clearTimeout(timer);
      emit(`bestmove ${layerMove(completed)}`);
    },
  );
}

describe("UciEngine search cap", () => {
  const CAP_MS = 30_000;
  const stopsSentTo = (fake: FakeEngineProcess): number =>
    fake.sent.filter((line) => line === "stop").length;

  async function startFaked(fake: FakeEngineProcess): Promise<UciEngine> {
    vi.useFakeTimers();
    const engine = new UciEngine(() => fake);
    await engine.start();
    return engine;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers at the cap with the best line of the deepest layer completed, and that depth", async () => {
    // Four seconds a layer: layer 7 is done at 28 s and layer 8 would be done at 32 s.
    const fake = layeredEngine(4000);
    const engine = await startFaked(fake);
    const search = engine.search({ fen: START, depth: 16, capMs: CAP_MS });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CAP_MS - 1);
    expect(stopsSentTo(fake)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const result = await search;
    expect(stopsSentTo(fake)).toBe(1);
    expect(result).toMatchObject({ fen: START, bestmove: "e2e4", depth: 7, cutByTime: true });
    expect(result.lines).toEqual([{ moves: ["e2e4"], score: 70 }]);
  });

  it("leaves the engine usable after a stop", async () => {
    const fake = layeredEngine(4000);
    const engine = await startFaked(fake);
    const first = engine.search({ fen: START, depth: 16, capMs: CAP_MS });
    await vi.advanceTimersByTimeAsync(CAP_MS);
    expect((await first).cutByTime).toBe(true);
    const second = engine.search({ fen: START, depth: 2, capMs: CAP_MS });
    await vi.advanceTimersByTimeAsync(8000);
    expect(await second).toMatchObject({ bestmove: "d2d4", depth: 2, cutByTime: false });
    expect(stopsSentTo(fake)).toBe(1);
  });

  it("reports the shallowest depth when the stop leaves the lines a layer apart", async () => {
    const fake = stoppableEngine(
      () => {},
      (emit) => {
        emit("info depth 8 seldepth 9 multipv 1 score cp 80 pv d2d4");
        emit("info depth 7 seldepth 9 multipv 2 score cp 70 pv e2e4");
        emit("bestmove d2d4");
      },
    );
    const engine = await startFaked(fake);
    const search = engine.search({ fen: START, depth: 16, multipv: 2, capMs: CAP_MS });
    await vi.advanceTimersByTimeAsync(CAP_MS);
    const result = await search;
    expect(result.lines).toEqual([
      { moves: ["d2d4"], score: 80 },
      { moves: ["e2e4"], score: 70 },
    ]);
    expect(result).toMatchObject({ bestmove: "d2d4", depth: 7, cutByTime: true });
  });

  it("sends no stop to an engine that finishes before the cap, and none later", async () => {
    const fake = layeredEngine(1000);
    const engine = await startFaked(fake);
    const search = engine.search({ fen: START, depth: 16, capMs: CAP_MS });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await search).toMatchObject({ bestmove: "d2d4", depth: 16, cutByTime: false });
    // A cap timer left running would send its stop to the idle engine now.
    await vi.advanceTimersByTimeAsync(2 * CAP_MS);
    expect(stopsSentTo(fake)).toBe(0);
  });

  it("never stops a search that has no cap: it fails at the slack instead", async () => {
    const fake = layeredEngine(4000);
    const engine = await startFaked(fake);
    const search = engine.search({ fen: START, depth: 16 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await search).toMatchObject({
      name: "EngineFault",
      reason: "timeout",
      message: "no answer within 5000 ms",
    });
    expect(stopsSentTo(fake)).toBe(0);
    expect(fake.killed).toBe(true);
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
