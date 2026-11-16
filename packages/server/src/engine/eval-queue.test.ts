import { chmodSync, copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type FixtureRow,
  storedSet,
  writeEvalCacheFile,
} from "../../test/support/eval-cache-fixture.js";
import { FakeEngineProcess, type GoRequest } from "../../test/support/fake-engine-process.js";
import { type Database, openDatabase } from "../db/open.js";
import { RecordingLog } from "../log.js";
import {
  decodeValue,
  encodeValue,
  mergeSets,
  openEvalCache,
  openEvalCacheWriter,
  packKey,
  type StoredSet,
} from "./eval-cache.js";
import { EvalQueue, EvalQueueWorker, QUEUE_SEARCH } from "./eval-queue.js";
import type { SearchResult } from "./uci.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const START_EPD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const AFTER_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
const CASTLING = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
// The position after 1.f3 e5 2.g4 Qh4#, where White has no move.
const MATED = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";

interface Reply {
  depth: number;
  knodes?: number;
  /** Each line as its score for the side to move and its moves. */
  lines: Array<[score: number, moves: string]>;
}

const REPLIES: Record<string, Reply> = {
  [START]: {
    depth: 30,
    knodes: 2500,
    lines: [
      [25, "e2e4 e7e5 g1f3"],
      [20, "d2d4 d7d5"],
      [18, "g1f3 g8f6"],
    ],
  },
  [AFTER_E4]: {
    depth: 28,
    lines: [
      [30, "e7e5 g1f3"],
      [20, "c7c5 g1f3"],
      [10, "e7e6 d2d4"],
    ],
  },
  [AFTER_E5]: {
    depth: 30,
    lines: [
      [35, "g1f3 b8c6"],
      [30, "f1c4 g8f6"],
      [28, "b1c3 g8f6"],
    ],
  },
  [CASTLING]: {
    depth: 30,
    lines: [
      [100, "e1g1 e8c8"],
      [50, "a1a8 e8d7"],
      [40, "h1h8 e8d7"],
    ],
  },
};

function emitReply(reply: Reply, go: GoRequest): void {
  reply.lines.forEach(([score, moves], index) => {
    const nodes = (reply.knodes ?? 1000) * 1000;
    go.emit(
      `info depth ${reply.depth} seldepth ${reply.depth + 4} multipv ${index + 1} score cp ${score} nodes ${nodes} pv ${moves}`,
    );
  });
  go.emit(`bestmove ${reply.lines[0]?.[1].split(" ")[0] ?? "(none)"}`);
}

function answerFromTable(go: GoRequest): void {
  const reply = REPLIES[go.fen];
  if (!reply) throw new Error(`no reply scripted for ${go.fen}`);
  emitReply(reply, go);
}

interface HarnessOptions {
  rows?: FixtureRow[];
  onGo?: (go: GoRequest, process: FakeEngineProcess) => void;
  failurePauseMs?: number;
  pollMs?: number;
  /** The first spawns exit as soon as they are asked to start, as a binary that crashes at boot does. */
  bootFailures?: number;
}

class DeadOnArrival extends FakeEngineProcess {
  constructor() {
    super(() => {});
  }

  override send(line: string): void {
    this.sent.push(line);
    queueMicrotask(() => this.exit());
  }
}

const harnesses: Array<{ close: () => Promise<void> }> = [];

// The real application database, a real cache file and a real reader and writer over it; only the
// engine process is the named fake, and the clock is the test's.
function makeHarness(options: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "eval-queue-"));
  const db = openDatabase(dir);
  const log = new RecordingLog();
  let now = Date.parse("2026-11-15T12:00:00.000Z");
  const clock = { now: () => new Date(now) };
  const queue = new EvalQueue(db, log, clock);
  const path = writeEvalCacheFile(options.rows ?? []);
  const writer = openEvalCacheWriter(path, log);
  if (!writer) throw new Error("the fixture cache file should be writable");
  const cache = openEvalCache(path, log, (miss) => queue.offer(miss));
  const processes: FakeEngineProcess[] = [];
  const state = { busy: false };
  const onGo = options.onGo ?? ((go: GoRequest) => answerFromTable(go));
  const worker = new EvalQueueWorker({
    queue,
    store: writer,
    spawn: () => {
      const dead = processes.length < (options.bootFailures ?? 0);
      const fake: FakeEngineProcess = dead
        ? new DeadOnArrival()
        : new FakeEngineProcess((go) => onGo(go, fake));
      // A killed process exits, as a real one does.
      const kill = fake.kill.bind(fake);
      fake.kill = () => {
        kill();
        fake.exit();
      };
      processes.push(fake);
      return fake;
    },
    busy: () => state.busy,
    log,
    clock,
    failurePauseMs: options.failurePauseMs ?? 30_000,
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
  });
  const harness = {
    dir,
    db,
    log,
    queue,
    cache,
    writer,
    worker,
    processes,
    state,
    path,
    advance: (ms: number) => {
      now += ms;
    },
    stored: (fen: string) => storedRow(path, fen),
    close: async () => {
      await worker.stop();
      cache.close();
      writer.close();
      db.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) await harness.close();
});

interface StoredRowView {
  source: number;
  depth: number;
  value: Buffer;
  sets: StoredSet[];
}

function storedRow(path: string, fen: string): StoredRowView | undefined {
  const raw = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    const epd = fen.split(" ").slice(0, 4).join(" ");
    const row = raw
      .prepare("SELECT source, depth, value FROM evals WHERE key = ?")
      .get(packKey(epd)) as { source: number; depth: number; value: Buffer } | undefined;
    return row && { ...row, sets: decodeValue(row.value) };
  } finally {
    raw.close();
  }
}

const startRow = (...sets: StoredSet[]): FixtureRow => ({ epd: START_EPD, sets });
const threeLines = (depth: number): StoredSet =>
  storedSet(depth, [
    [20, "e2e4 e7e5"],
    [15, "d2d4 d7d5"],
    [10, "g1f3 g8f6"],
  ]);
const oneLine = (depth: number): StoredSet => storedSet(depth, [[20, "e2e4 e7e5"]]);

function searchResult(
  fen: string,
  depth: number,
  lines: Array<[score: number, moves: string]>,
  knodes?: number,
): SearchResult {
  return {
    fen,
    bestmove: lines[0]?.[1].split(" ")[0] ?? null,
    lines: lines.map(([score, moves]) => ({ score, moves: moves.split(" ") })),
    depth,
    ...(knodes === undefined ? {} : { knodes }),
  };
}

const WANT_THREE = { lines: 3, depth: 18 };

describe("the queue", () => {
  it("queues a position the cache could not answer, under the cache's own key", () => {
    const h = makeHarness();
    expect(h.cache.lookup(START, WANT_THREE)).toBeNull();

    expect(h.queue.size()).toBe(1);
    const queued = h.queue.newest();
    expect(queued?.fen).toBe(START);
    expect(queued?.key.equals(packKey(START_EPD))).toBe(true);
    expect(h.log.named("eval_queue.added")).toHaveLength(1);
    expect(h.log.named("eval_queue.added")[0]?.fields).toMatchObject({
      fen: START,
      queued: 1,
      dropped: 0,
    });
  });

  it("adds nothing for a second miss on the same position", () => {
    const h = makeHarness();
    h.cache.lookup(START, WANT_THREE);
    h.cache.lookup(START, WANT_THREE);
    h.cache.lookup(START.replace(" 0 1", " 4 3"), WANT_THREE);

    expect(h.queue.size()).toBe(1);
    expect(h.log.named("eval_queue.added")).toHaveLength(1);
  });

  it("adds nothing for a hit", () => {
    const h = makeHarness({ rows: [startRow(threeLines(30))] });
    expect(h.cache.lookup(START, WANT_THREE)).not.toBeNull();

    expect(h.queue.size()).toBe(0);
    expect(h.log.named("eval_queue.added")).toHaveLength(0);
  });

  it("moves a position looked at again to the front without adding a row", () => {
    const h = makeHarness();
    h.cache.lookup(START, WANT_THREE);
    h.cache.lookup(AFTER_E4, WANT_THREE);
    expect(h.queue.newest()?.fen).toBe(AFTER_E4);

    h.cache.lookup(START, WANT_THREE);

    expect(h.queue.newest()?.fen).toBe(START);
    expect(h.queue.size()).toBe(2);
  });

  it("drops the oldest position when a 5001st is queued", () => {
    const h = makeHarness();
    const miss = (index: number) => ({
      fen: `position ${index}`,
      key: Buffer.from(`key ${index}`),
      storedDepth: null,
    });
    for (let index = 0; index < 5000; index++) h.queue.offer(miss(index));
    expect(h.queue.size()).toBe(5000);

    h.queue.offer(miss(5000));

    expect(h.queue.size()).toBe(5000);
    const rows = h.db.prepare("SELECT fen FROM eval_queue ORDER BY rowid").all() as Array<{
      fen: string;
    }>;
    expect(rows[0]?.fen).toBe("position 1");
    expect(rows.at(-1)?.fen).toBe("position 5000");
    expect(rows.some((row) => row.fen === "position 0")).toBe(false);
    expect(h.log.named("eval_queue.added").at(-1)?.fields).toMatchObject({
      queued: 5000,
      dropped: 1,
    });
  });

  it("leaves out a position whose stored row is as deep as the search goes", () => {
    const deep = makeHarness({ rows: [startRow(oneLine(QUEUE_SEARCH.depth))] });
    expect(deep.cache.lookup(START, WANT_THREE)).toBeNull();
    expect(deep.queue.size()).toBe(0);

    const shallow = makeHarness({ rows: [startRow(oneLine(QUEUE_SEARCH.depth - 1))] });
    expect(shallow.cache.lookup(START, WANT_THREE)).toBeNull();
    expect(shallow.queue.size()).toBe(1);
  });

  it("queues nothing when there is no cache file to store a result in", () => {
    const h = makeHarness();
    const offered: string[] = [];
    const listener = (miss: { fen: string }) => offered.push(miss.fen);
    const unset = openEvalCache(null, h.log, listener);
    const missing = openEvalCache(join(h.dir, "no-such-evals.db"), h.log, listener);

    expect(unset.lookup(START, WANT_THREE)).toBeNull();
    expect(missing.lookup(START, WANT_THREE)).toBeNull();
    expect(offered).toEqual([]);
    expect(h.queue.size()).toBe(0);
  });

  it("keeps its positions across a restart", () => {
    const h = makeHarness();
    h.cache.lookup(START, WANT_THREE);
    h.cache.lookup(AFTER_E4, WANT_THREE);
    h.db.close();

    const reopened: Database = openDatabase(h.dir);
    try {
      const queue = new EvalQueue(reopened);
      expect(queue.size()).toBe(2);
      expect(queue.newest()?.fen).toBe(AFTER_E4);
    } finally {
      reopened.close();
    }
  });

  it("never lets a failing queue reach the lookup that missed", () => {
    const h = makeHarness();
    h.db.exec("DROP TABLE eval_queue");

    expect(h.cache.lookup(START, WANT_THREE)).toBeNull();

    expect(h.log.named("eval_queue.failed")[0]?.fields).toMatchObject({ fen: START, stage: "add" });
    expect(h.log.named("eval_cache.failed")).toHaveLength(0);
  });
});

describe("the worker", () => {
  it("takes the newest position, stores its search as source 1, removes the row and a later lookup hits", async () => {
    const h = makeHarness();
    h.cache.lookup(START, WANT_THREE);
    h.cache.lookup(AFTER_E4, WANT_THREE);

    expect(await h.worker.runOnce()).toBe("done");

    const searched = h.processes[0]?.sent.filter((line) => line.startsWith("position fen "));
    expect(searched).toEqual([`position fen ${AFTER_E4}`]);
    expect(h.queue.size()).toBe(1);
    expect(h.queue.newest()?.fen).toBe(START);
    const row = h.stored(AFTER_E4);
    expect(row).toMatchObject({ source: 1, depth: 28 });
    expect(row?.sets).toHaveLength(1);
    expect(h.cache.lookup(AFTER_E4, WANT_THREE)).toEqual({
      depth: 28,
      lines: [
        { moves: ["e7e5", "g1f3"], score: 30 },
        { moves: ["c7c5", "g1f3"], score: 20 },
        { moves: ["e7e6", "d2d4"], score: 10 },
      ],
    });
    expect(h.log.named("eval_queue.done")[0]?.fields).toMatchObject({
      fen: AFTER_E4,
      outcome: "stored",
      depth: 28,
      lines: 3,
      queued: 1,
    });
  });

  it("searches three lines to depth 30 on one thread", async () => {
    const h = makeHarness();
    h.cache.lookup(START, WANT_THREE);

    await h.worker.runOnce();

    expect(QUEUE_SEARCH).toEqual({ depth: 30, lines: 3, capMs: 60_000 });
    const sent = h.processes[0]?.sent ?? [];
    expect(sent).toContain("setoption name Threads value 1");
    expect(sent).toContain("setoption name MultiPV value 3");
    expect(sent).toContain("go depth 30");
  });

  it("keeps the node count of the search in the stored set", async () => {
    const h = makeHarness();
    h.cache.lookup(START, WANT_THREE);

    await h.worker.runOnce();

    expect(h.stored(START)?.sets[0]).toMatchObject({ depth: 30, knodes: 2500 });
  });

  it("stops a search after 60 seconds and stores the depth it had reached", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = makeHarness({ onGo: () => {} });
    h.cache.lookup(START, WANT_THREE);
    const step = h.worker.runOnce();

    await vi.advanceTimersByTimeAsync(59_999);
    const engine = h.processes[0];
    expect(engine?.sent).toContain("go depth 30");
    expect(engine?.sent).not.toContain("stop");
    await vi.advanceTimersByTimeAsync(1);
    expect(engine?.sent).toContain("stop");

    engine?.emit("info depth 21 multipv 1 score cp 12 nodes 9000000 pv e2e4 e7e5");
    engine?.emit("info depth 21 multipv 2 score cp 8 nodes 9100000 pv d2d4 d7d5");
    engine?.emit("bestmove e2e4");
    expect(await step).toBe("done");
    expect(h.stored(START)).toMatchObject({ source: 1, depth: 21 });
    expect(h.log.named("eval_queue.done")[0]?.fields).toMatchObject({
      cut_by_time: true,
      depth: 21,
    });
  });

  it("changes nothing for a result shallower than the stored row", async () => {
    const h = makeHarness({ rows: [startRow(threeLines(35))] });
    const before = h.stored(START);
    h.queue.offer({ fen: START, key: packKey(START_EPD), storedDepth: null });

    expect(await h.worker.runOnce()).toBe("done");

    expect(h.stored(START)).toEqual(before);
    expect(h.stored(START)?.source).toBe(0);
    expect(h.queue.size()).toBe(0);
    expect(h.log.named("eval_queue.done")[0]?.fields).toMatchObject({ outcome: "unchanged" });
  });

  it("does not start a search while the app is busy, and does after", async () => {
    const h = makeHarness();
    h.cache.lookup(START, WANT_THREE);
    h.state.busy = true;

    expect(await h.worker.runOnce()).toBe("busy");
    expect(h.processes).toHaveLength(0);
    expect(h.queue.size()).toBe(1);

    h.state.busy = false;
    expect(await h.worker.runOnce()).toBe("done");
    expect(h.queue.size()).toBe(0);
  });

  it("works through the queue by itself, waits out a busy app and wakes for a new position", async () => {
    const h = makeHarness({ pollMs: 5 });
    h.state.busy = true;
    h.worker.start();
    h.cache.lookup(START, WANT_THREE);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(h.processes).toHaveLength(0);
    expect(h.queue.size()).toBe(1);

    h.state.busy = false;
    await vi.waitFor(() => expect(h.queue.size()).toBe(0));
    expect(h.stored(START)?.source).toBe(1);

    h.cache.lookup(AFTER_E4, WANT_THREE);
    await vi.waitFor(() => expect(h.stored(AFTER_E4)?.source).toBe(1));
  });

  it("drops the position, logs eval_queue.failed and keeps serving the queue after an engine fault", async () => {
    const h = makeHarness({
      onGo: (go, process) => (go.fen === START ? process.exit() : answerFromTable(go)),
    });
    h.cache.lookup(AFTER_E4, WANT_THREE);
    h.cache.lookup(START, WANT_THREE);

    expect(await h.worker.runOnce()).toBe("failed");

    expect(h.queue.size()).toBe(1);
    expect(h.queue.newest()?.fen).toBe(AFTER_E4);
    expect(h.stored(START)).toBeUndefined();
    const failed = h.log.named("eval_queue.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ level: "error" });
    expect(failed[0]?.fields).toMatchObject({
      fen: START,
      stage: "search",
      error_name: "EngineFault",
    });

    h.advance(30_000);
    expect(await h.worker.runOnce()).toBe("done");
    expect(h.stored(AFTER_E4)?.source).toBe(1);
    expect(h.processes).toHaveLength(2);
    expect(h.queue.size()).toBe(0);
  });

  it("starts its engine again after one that failed to boot, once the wait is over", async () => {
    const h = makeHarness({ bootFailures: 1 });
    h.cache.lookup(START, WANT_THREE);
    h.cache.lookup(AFTER_E4, WANT_THREE);

    expect(await h.worker.runOnce()).toBe("failed");
    expect(h.log.named("eval_queue.failed")[0]?.fields).toMatchObject({
      fen: AFTER_E4,
      error_name: "EngineFault",
    });

    h.advance(30_000);
    expect(await h.worker.runOnce()).toBe("done");
    expect(h.stored(START)?.source).toBe(1);
    expect(h.processes).toHaveLength(2);
  });

  it("waits before the next position after a failure, so a broken engine cannot take the queue", async () => {
    const h = makeHarness({ onGo: (_go, process) => process.exit() });
    h.cache.lookup(START, WANT_THREE);
    h.cache.lookup(AFTER_E4, WANT_THREE);

    expect(await h.worker.runOnce()).toBe("failed");
    expect(await h.worker.runOnce()).toBe("paused");
    expect(h.queue.size()).toBe(1);

    h.advance(30_000);
    expect(await h.worker.runOnce()).toBe("failed");
    expect(h.queue.size()).toBe(0);
  });

  it("does not search a position when the cache file cannot be opened for writing", async () => {
    const h = makeHarness();
    h.cache.lookup(START, WANT_THREE);
    h.writer.close();
    vi.spyOn(BetterSqlite3.prototype, "pragma").mockImplementation(() => {
      throw new Error("unable to open database file");
    });

    expect(await h.worker.runOnce()).toBe("failed");

    expect(h.processes).toHaveLength(0);
    expect(h.log.named("eval_queue.failed")[0]?.fields).toMatchObject({
      fen: START,
      error_message: "unable to open database file",
    });
    expect(h.queue.size()).toBe(0);
  });

  it("leaves the position queued when the shutdown kills its search", async () => {
    const h = makeHarness({ onGo: () => {} });
    h.cache.lookup(START, WANT_THREE);
    const step = h.worker.runOnce();
    await vi.waitFor(() => expect(h.processes[0]?.sent).toContain("go depth 30"));

    await h.worker.stop();

    expect(await step).toBe("idle");
    expect(h.queue.size()).toBe(1);
    expect(h.log.named("eval_queue.failed")).toHaveLength(0);
    expect(h.stored(START)).toBeUndefined();
  });

  it("does not start a search when the shutdown came while its engine was starting", async () => {
    const h = makeHarness({
      onGo: (go, process) => (go.fen === START ? process.exit() : answerFromTable(go)),
    });
    h.cache.lookup(AFTER_E4, WANT_THREE);
    h.cache.lookup(START, WANT_THREE);
    expect(await h.worker.runOnce()).toBe("failed");
    h.advance(30_000);

    const step = h.worker.runOnce();
    const stopping = h.worker.stop();

    expect(await step).toBe("idle");
    await stopping;
    expect(h.processes[1]?.sent.some((line) => line.startsWith("go "))).toBe(false);
    expect(h.queue.size()).toBe(1);
  });

  it("stores nothing for a position the engine has no move in", async () => {
    const h = makeHarness({
      onGo: (go) => {
        go.emit("info depth 0 score mate 0");
        go.emit("bestmove (none)");
      },
    });
    h.cache.lookup(MATED, WANT_THREE);

    expect(await h.worker.runOnce()).toBe("done");

    expect(h.stored(MATED)).toBeUndefined();
    expect(h.queue.size()).toBe(0);
    expect(h.log.named("eval_queue.done")[0]?.fields).toMatchObject({ outcome: "empty" });
  });
});

describe("the cache writer", () => {
  it("replaces a shallower row with the search and labels it source 1", () => {
    const h = makeHarness({ rows: [startRow(threeLines(20))] });
    expect(h.stored(START)?.source).toBe(0);

    const outcome = h.writer.store(
      START,
      searchResult(START, 30, [
        [25, "e2e4 e7e5"],
        [20, "d2d4 d7d5"],
        [18, "g1f3 g8f6"],
      ]),
    );

    expect(outcome).toBe("stored");
    const row = h.stored(START);
    expect(row).toMatchObject({ source: 1, depth: 30 });
    expect(row?.sets.map((set) => [set.depth, set.lines.length])).toEqual([[30, 3]]);
  });

  it("writes a position the file does not hold yet", () => {
    const h = makeHarness();
    expect(h.stored(START)).toBeUndefined();

    expect(h.writer.store(START, searchResult(START, 24, [[25, "e2e4 e7e5"]]))).toBe("stored");

    expect(h.stored(START)).toMatchObject({ source: 1, depth: 24 });
  });

  it("changes nothing for a result shallower than or as deep as the row", () => {
    const h = makeHarness({ rows: [startRow(threeLines(30))] });
    const before = h.stored(START);

    const shallower = h.writer.store(START, searchResult(START, 29, [[99, "e2e4 e7e5"]]));
    const same = h.writer.store(START, searchResult(START, 30, [[99, "e2e4 e7e5"]]));

    expect([shallower, same]).toEqual(["unchanged", "unchanged"]);
    expect(h.stored(START)).toEqual(before);
  });

  it("keeps the three-line set of a row when a deeper one-line result arrives", () => {
    const h = makeHarness({ rows: [startRow(threeLines(20))] });

    h.writer.store(START, searchResult(START, 30, [[25, "e2e4 e7e5"]]));

    const row = h.stored(START);
    expect(row).toMatchObject({ source: 1, depth: 30 });
    expect(row?.sets.map((set) => [set.depth, set.lines.length])).toEqual([
      [30, 1],
      [20, 3],
    ]);
    // The carried set is the one a request for three lines at depth 18 is answered from.
    expect(h.cache.lookup(START, WANT_THREE)?.depth).toBe(20);
    expect(h.cache.lookup(START, { lines: 1, depth: 25 })?.depth).toBe(30);
  });

  it("does not carry a set that has no more lines than the result", () => {
    const h = makeHarness({ rows: [startRow(oneLine(20))] });

    h.writer.store(START, searchResult(START, 30, [[25, "e2e4 e7e5"]]));

    expect(h.stored(START)?.sets).toHaveLength(1);
  });

  it("carries the set with the most lines, and the deepest of those", () => {
    const fresh = storedSet(40, [[1, "e2e4"]]);
    const twoLines = storedSet(30, [
      [1, "e2e4"],
      [1, "d2d4"],
    ]);
    const deepThree = threeLines(25);
    const shallowThree = threeLines(20);

    expect(mergeSets([twoLines, shallowThree], fresh)).toEqual([fresh, shallowThree]);
    expect(mergeSets([deepThree, shallowThree], fresh)).toEqual([fresh, deepThree]);
    expect(mergeSets([shallowThree, deepThree], fresh)).toEqual([fresh, deepThree]);
    expect(mergeSets([storedSet(30, [[1, "e2e4"]])], fresh)).toEqual([fresh]);
  });

  it("replaces a damaged row with a deeper result", () => {
    const h = makeHarness({
      rows: [{ epd: START_EPD, sets: [oneLine(5)], value: Buffer.from([9, 9, 9]) }],
    });

    expect(h.writer.store(START, searchResult(START, 30, [[25, "e2e4 e7e5"]]))).toBe("stored");

    expect(h.stored(START)?.sets).toHaveLength(1);
  });

  it("writes scores from White's side, which read back as the side to move's", () => {
    const h = makeHarness();

    h.writer.store(AFTER_E4, searchResult(AFTER_E4, 28, [[30, "e7e5 g1f3"]]));

    expect(h.stored(AFTER_E4)?.sets[0]?.lines[0]).toMatchObject({ mate: false, score: -30 });
    expect(h.cache.lookup(AFTER_E4, { lines: 1, depth: 18 })?.lines[0]?.score).toBe(30);
  });

  it("stores a mate as the 10000 centipawns the search maps it to", () => {
    const h = makeHarness();

    h.writer.store(AFTER_E4, searchResult(AFTER_E4, 28, [[10000, "d8h4"]]));

    expect(h.stored(AFTER_E4)?.sets[0]?.lines[0]).toMatchObject({ mate: false, score: -10000 });
    expect(h.cache.lookup(AFTER_E4, { lines: 1, depth: 18 })?.lines[0]?.score).toBe(10000);
  });

  it("writes castling as the king taking its rook and reads it back as castling", () => {
    const h = makeHarness();

    h.writer.store(
      CASTLING,
      searchResult(CASTLING, 30, [
        [100, "e1g1 e8c8"],
        [50, "a1a8 e8d7"],
      ]),
    );

    expect(h.stored(CASTLING)?.sets[0]?.lines.map((line) => line.moves)).toEqual([
      ["e1h1", "e8a8"],
      ["a1a8", "e8d7"],
    ]);
    expect(h.cache.lookup(CASTLING, { lines: 2, depth: 18 })?.lines[0]?.moves).toEqual([
      "e1g1",
      "e8c8",
    ]);
  });

  it("ends a line at the first move the position does not allow", () => {
    const h = makeHarness();

    h.writer.store(START, searchResult(START, 30, [[25, "e2e4 e7e5 e2e4 g1f3"]]));

    expect(h.stored(START)?.sets[0]?.lines[0]?.moves).toEqual(["e2e4", "e7e5"]);
  });

  it("switches the file to WAL with the lighter sync before it writes anything", () => {
    const h = makeHarness();
    const pragmas = vi.spyOn(BetterSqlite3.prototype, "pragma");

    h.writer.ensureOpen();
    h.writer.store(START, searchResult(START, 30, [[25, "e2e4 e7e5"]]));

    expect(pragmas.mock.calls.map(([text]) => text)).toEqual([
      "journal_mode = WAL",
      "synchronous = NORMAL",
    ]);
    const raw = new BetterSqlite3(h.path, { readonly: true });
    try {
      expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      raw.close();
    }
  });

  it("does not touch the file until something is stored", () => {
    const h = makeHarness();
    const raw = new BetterSqlite3(h.path, { readonly: true });
    try {
      expect(raw.pragma("journal_mode", { simple: true })).toBe("delete");
    } finally {
      raw.close();
    }
  });

  it("has no writer for an unset or missing file, and none for a file it cannot write", () => {
    const log = new RecordingLog();
    expect(openEvalCacheWriter(null, log)).toBeNull();
    expect(openEvalCacheWriter(join(tmpdir(), "no-such-dir", "evals.db"), log)).toBeNull();
    expect(log.events).toEqual([]);

    // A file is no use when the directory beside it, where the journal goes, cannot be written.
    if (process.getuid?.() === 0) return;
    const dir = mkdtempSync(join(tmpdir(), "eval-queue-locked-"));
    const path = join(dir, "evals.db");
    copyFileSync(writeEvalCacheFile([startRow(oneLine(10))]), path);
    chmodSync(dir, 0o555);
    try {
      expect(openEvalCacheWriter(path, log)).toBeNull();
      expect(log.named("eval_cache.unavailable")[0]?.fields).toMatchObject({
        reason: "not_writable",
        path,
      });
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

describe("the log events", () => {
  const repository = join(import.meta.dirname, "../../../..");
  const emitted = [
    ...readFileSync(join(import.meta.dirname, "eval-queue.ts"), "utf8").matchAll(
      /"(eval_queue\.[a-z_]+)"/g,
    ),
  ].map((match) => match[1] as string);

  it.each(["eval_queue.added", "eval_queue.done", "eval_queue.failed"])(
    "lists %s in AGENTS.md",
    (event) => {
      expect(emitted).toContain(event);
      expect(readFileSync(join(repository, "AGENTS.md"), "utf8")).toContain(`\`${event}\``);
    },
  );

  it("lists in AGENTS.md every eval_queue event the queue writes", () => {
    const agents = readFileSync(join(repository, "AGENTS.md"), "utf8");
    for (const event of new Set(emitted)) expect(agents).toContain(`\`${event}\``);
  });
});

describe("the value encoder", () => {
  const GOLDEN = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../..", "tools/testdata/eval_cache_golden.json"),
      "utf8",
    ),
  ) as Array<{ name: string; value: string }>;

  it.each(GOLDEN)("writes the bytes the builder wrote: $name", (golden) => {
    const sets = decodeValue(Buffer.from(golden.value, "hex"));
    expect(encodeValue(sets).toString("hex")).toBe(golden.value);
  });
});
