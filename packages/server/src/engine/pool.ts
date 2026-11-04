import type { EngineSpawner } from "./process.js";
import type { Searcher, SearchRequest, SearchResult } from "./uci.js";
import { type EngineTimeouts, UciEngine } from "./uci.js";

export const ANALYZE_DEPTH = 18;
export const ANALYZE_LINES = 3;

export type EngineRole = "evaluation" | "play";

/** Rejects an `analyze` request that a newer one replaced before it started. */
export class AnalyzeSuperseded extends Error {
  constructor() {
    super("a newer analyze request replaced this one");
    this.name = "AnalyzeSuperseded";
  }
}

interface Waiting {
  request: SearchRequest;
  resolve: (result: SearchResult) => void;
  reject: (error: unknown) => void;
}

/**
 * Hands the evaluation engine one search at a time, live-turn requests first. A search that
 * is already running is never interrupted; priority only decides who goes next.
 */
class PrioritizedSearcher {
  private readonly live: Waiting[] = [];
  private analyzeSlot: Waiting | null = null;
  private busy = false;

  constructor(private readonly engine: UciEngine) {}

  readonly liveSearcher: Searcher = {
    search: (request) => this.submit(request, "live"),
  };

  analyze(request: SearchRequest): Promise<SearchResult> {
    return this.submit(request, "analyze");
  }

  private submit(request: SearchRequest, lane: "live" | "analyze"): Promise<SearchResult> {
    return new Promise<SearchResult>((resolve, reject) => {
      const waiting: Waiting = { request, resolve, reject };
      if (lane === "live") {
        this.live.push(waiting);
      } else {
        this.analyzeSlot?.reject(new AnalyzeSuperseded());
        this.analyzeSlot = waiting;
      }
      this.pump();
    });
  }

  private pump(): void {
    if (this.busy) return;
    const next = this.live.shift() ?? this.takeAnalyze();
    if (!next) return;
    this.busy = true;
    this.engine
      .search(next.request)
      .then(next.resolve, next.reject)
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }

  private takeAnalyze(): Waiting | null {
    const waiting = this.analyzeSlot;
    this.analyzeSlot = null;
    return waiting;
  }
}

export class EnginePool {
  /** Full strength; grades student moves with priority over `analyze`. */
  readonly evaluation: Searcher;
  /** Strength is set per game through `choosePlayMove`. */
  readonly play: UciEngine;
  private readonly evaluationEngine: UciEngine;
  private readonly scheduler: PrioritizedSearcher;

  constructor(
    spawn: (role: EngineRole) => ReturnType<EngineSpawner>,
    timeouts: Partial<EngineTimeouts> = {},
  ) {
    this.evaluationEngine = new UciEngine(() => spawn("evaluation"), timeouts);
    this.play = new UciEngine(() => spawn("play"), timeouts);
    this.scheduler = new PrioritizedSearcher(this.evaluationEngine);
    this.evaluation = this.scheduler.liveSearcher;
  }

  analyze(fen: string): Promise<SearchResult> {
    return this.scheduler.analyze({ fen, depth: ANALYZE_DEPTH, multipv: ANALYZE_LINES });
  }

  async start(): Promise<void> {
    await Promise.all([this.evaluationEngine.start(), this.play.start()]);
  }

  async stop(): Promise<void> {
    await Promise.all([this.evaluationEngine.stop(), this.play.stop()]);
  }
}
