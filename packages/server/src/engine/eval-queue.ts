import type { Database, Statement } from "better-sqlite3";
import { type Clock, systemClock } from "../clock.js";
import { type Log, silentLog } from "../log.js";
import type { EngineProcess, EngineSpawner } from "./process.js";
import { type EngineTimeouts, type SearchResult, UciEngine } from "./uci.js";

// The shapes below are the cache's own, written out here: the evaluation cache reader may only be
// imported by the engine pool and the entry point (test/grading-wiring.test.ts), and this module
// needs nothing of it but two small shapes that the cache's types satisfy.

/** A lookup the cache could not answer, as the queue needs it. */
export interface QueuedMiss {
  fen: string;
  key: Buffer;
  /** The depth of the deepest set stored for the position; null when nothing is stored for it. */
  storedDepth: number | null;
}

/** The cache's write side, as the worker uses it. */
export interface QueueResultStore {
  ensureOpen(): void;
  store(fen: string, result: SearchResult): "stored" | "unchanged" | "empty";
}

/** Positions kept; the oldest are dropped past it. */
export const EVAL_QUEUE_LIMIT = 5000;

/** Three lines so a row that holds several never loses them to a single-line result. */
export const QUEUE_SEARCH = { depth: 30, lines: 3, capMs: 60_000 };

/** The engine of the background search runs under `nice` at this level. */
export const QUEUE_NICENESS = 19;

const POLL_MS = 2000;
// An engine that fails every search would otherwise take the whole queue down in a burst.
const FAILURE_PAUSE_MS = 30_000;

export interface QueuedPosition {
  key: Buffer;
  fen: string;
  enqueuedAt: string;
}

type QueueRow = { key: Buffer; fen: string; enqueued_at: string };

/**
 * The positions waiting for a deeper search, in the app's own database so a restart keeps them.
 * Ordered by rowid, which is insertion order: the position looked at last is searched first, and
 * the first to go when the queue is full is the one that has waited longest.
 */
export class EvalQueue {
  private readonly listeners = new Set<() => void>();
  private readonly known: Statement<[Buffer], { present: number }>;
  private readonly insert: Statement<[Buffer, string, string]>;
  private readonly forget: Statement<[Buffer]>;
  private readonly newestRow: Statement<[], QueueRow>;
  private readonly dropOldest: Statement<[number]>;
  private readonly count: Statement<[], { n: number }>;

  constructor(
    private readonly db: Database,
    private readonly log: Log = silentLog,
    private readonly clock: Clock = systemClock,
    private readonly limit: number = EVAL_QUEUE_LIMIT,
  ) {
    this.known = db.prepare("SELECT 1 AS present FROM eval_queue WHERE key = ?");
    this.insert = db.prepare("INSERT INTO eval_queue (key, fen, enqueued_at) VALUES (?, ?, ?)");
    this.forget = db.prepare("DELETE FROM eval_queue WHERE key = ?");
    this.newestRow = db.prepare(
      "SELECT key, fen, enqueued_at FROM eval_queue ORDER BY rowid DESC LIMIT 1",
    );
    this.dropOldest = db.prepare(
      "DELETE FROM eval_queue WHERE rowid IN (SELECT rowid FROM eval_queue ORDER BY rowid LIMIT ?)",
    );
    this.count = db.prepare("SELECT COUNT(*) AS n FROM eval_queue");
  }

  /**
   * Queues a miss, or moves a position already queued to the front, and wakes the worker. It never
   * throws: a lookup that missed must still be answered by the engine. A position whose stored row
   * is as deep as the search goes is left out, since the cache never replaces a deeper row.
   */
  offer(miss: QueuedMiss): void {
    if (miss.storedDepth !== null && miss.storedDepth >= QUEUE_SEARCH.depth) return;
    try {
      const outcome = this.db.transaction(() => this.enqueue(miss))();
      if (outcome.added) {
        this.log.info("eval_queue.added", {
          fen: miss.fen,
          queued: outcome.queued,
          dropped: outcome.dropped,
        });
      }
    } catch (error) {
      this.log.error("eval_queue.failed", error, { fen: miss.fen, stage: "add" });
      return;
    }
    for (const listener of this.listeners) listener();
  }

  /** The position looked at most recently, still queued. */
  newest(): QueuedPosition | undefined {
    const row = this.newestRow.get();
    return row && { key: row.key, fen: row.fen, enqueuedAt: row.enqueued_at };
  }

  remove(key: Buffer): void {
    this.forget.run(key);
  }

  size(): number {
    return (this.count.get() as { n: number }).n;
  }

  /** Called whenever a position is queued or looked at again. */
  onAdded(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Looking at a queued position again deletes its row and inserts it anew, which is what moves it
  // to the front and keeps it one row.
  private enqueue(miss: QueuedMiss): { added: boolean; queued: number; dropped: number } {
    const added = this.known.get(miss.key) === undefined;
    this.forget.run(miss.key);
    this.insert.run(miss.key, miss.fen, this.clock.now().toISOString());
    const queued = this.size();
    const over = Math.max(0, queued - this.limit);
    if (over > 0) this.dropOldest.run(over);
    return { added, queued: queued - over, dropped: over };
  }
}

export interface EvalQueueWorkerOptions {
  queue: EvalQueue;
  store: QueueResultStore;
  /** Spawns the background engine; the caller decides how it is niced. */
  spawn: EngineSpawner;
  /** True while a game move, a grading search or a coach turn is running. */
  busy: () => boolean;
  log?: Log;
  clock?: Clock;
  search?: Partial<typeof QUEUE_SEARCH>;
  pollMs?: number;
  failurePauseMs?: number;
  engineTimeouts?: Partial<EngineTimeouts>;
}

/** What one step of the worker came to, for the loop and for the tests that drive it by hand. */
export type QueueStep = "done" | "failed" | "busy" | "paused" | "idle";

/**
 * Works through the queue one position at a time on an engine of its own, newest first, when
 * nothing else is running. A search that has started is never interrupted by activity, since the
 * engine is niced; it is only never started while the app is busy.
 */
export class EvalQueueWorker {
  private readonly engine: UciEngine;
  private readonly queue: EvalQueue;
  private readonly store: QueueResultStore;
  private readonly busy: () => boolean;
  private readonly log: Log;
  private readonly clock: Clock;
  private readonly search: typeof QUEUE_SEARCH;
  private readonly pollMs: number;
  private readonly failurePauseMs: number;
  private process: EngineProcess | null = null;
  private stopped = false;
  private engineStale = false;
  private searching = false;
  private pausedUntil = 0;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private unsubscribe: (() => void) | undefined;

  constructor(options: EvalQueueWorkerOptions) {
    this.queue = options.queue;
    this.store = options.store;
    this.busy = options.busy;
    this.log = options.log ?? silentLog;
    this.clock = options.clock ?? systemClock;
    this.search = { ...QUEUE_SEARCH, ...options.search };
    this.pollMs = options.pollMs ?? POLL_MS;
    this.failurePauseMs = options.failurePauseMs ?? FAILURE_PAUSE_MS;
    this.engine = new UciEngine(() => {
      const spawned = options.spawn();
      this.process = spawned;
      return spawned;
    }, options.engineTimeouts);
    // One thread: the engine of the background search is never allowed more than one core.
    void this.engine.setOption("Threads", "1");
  }

  /** Starts working through the queue, and again whenever a position is queued. */
  start(): void {
    this.stopped = false;
    this.unsubscribe ??= this.queue.onAdded(() => this.schedule(0));
    this.schedule(0);
  }

  /**
   * Stops for good. A search in flight is killed rather than waited for, which would hold a restart
   * for up to a minute, and its position stays queued for the next boot.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.searching) this.process?.kill();
    await this.running;
    await this.engine.stop();
  }

  /** One step: searches and stores the newest position if the app is idle. Never overlaps itself. */
  async runOnce(): Promise<QueueStep> {
    if (this.stopped) return "idle";
    if (this.busy()) return "busy";
    if (this.clock.now().getTime() < this.pausedUntil) return "paused";
    const next = this.queue.newest();
    if (next === undefined) return "idle";
    return this.work(next);
  }

  private async work(next: QueuedPosition): Promise<QueueStep> {
    const startedAt = performance.now();
    try {
      // A file that cannot be written is found here, before a minute of search is spent on it.
      this.store.ensureOpen();
      if (this.engineStale) {
        await this.engine.start();
        this.engineStale = false;
      }
      // A shutdown that came while the engine was starting must not be answered with a minute of search.
      if (this.stopped) return "idle";
      const result = await this.searchDeeper(next.fen);
      const outcome = this.store.store(next.fen, result);
      this.queue.remove(next.key);
      this.log.info("eval_queue.done", {
        fen: next.fen,
        outcome,
        depth: result.depth ?? null,
        lines: result.lines.length,
        knodes: result.knodes ?? null,
        cut_by_time: result.cutByTime ?? false,
        duration_ms: Math.round(performance.now() - startedAt),
        waited_ms: this.clock.now().getTime() - Date.parse(next.enqueuedAt),
        queued: this.queue.size(),
      });
      return "done";
    } catch (error) {
      return this.fail(next, error, startedAt);
    }
  }

  private async searchDeeper(fen: string): Promise<SearchResult> {
    const { depth, lines, capMs } = this.search;
    this.searching = true;
    try {
      return await this.engine.search({ fen, depth, multipv: lines, capMs });
    } finally {
      this.searching = false;
    }
  }

  // A failure is logged and the position dropped, with no retry. A shutdown that killed the search
  // is not a failure: the row stays for the next boot.
  private fail(next: QueuedPosition, error: unknown, startedAt: number): QueueStep {
    if (this.stopped) return "idle";
    this.engineStale = true;
    this.pausedUntil = this.clock.now().getTime() + this.failurePauseMs;
    this.log.error("eval_queue.failed", error, {
      fen: next.fen,
      stage: "search",
      duration_ms: Math.round(performance.now() - startedAt),
    });
    this.queue.remove(next.key);
    return "failed";
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer !== undefined || this.running !== null) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.runStep();
    }, delayMs);
    // A waiting worker is no reason to keep the process alive at shutdown.
    this.timer.unref();
  }

  private async runStep(): Promise<void> {
    let step: QueueStep;
    try {
      step = await this.runOnce();
    } catch (error) {
      // A queue that cannot even be read must not take the service with it.
      this.log.error("eval_queue.failed", error, { stage: "loop" });
      step = "failed";
    }
    this.running = null;
    if (this.stopped) return;
    if (step === "done") this.schedule(0);
    else if (step === "idle") {
      // A position queued while this step was finishing woke nobody.
      if (this.queue.size() > 0) this.schedule(0);
    } else this.schedule(this.pollMs);
  }
}
