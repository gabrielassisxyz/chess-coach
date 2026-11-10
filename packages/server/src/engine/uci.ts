import { Chess } from "chess.js";
import { EngineFault } from "./errors.js";
import { applyUci } from "./moves.js";
import { type InfoLine, parseBestmove, parseInfoLine } from "./parse.js";
import type { EngineProcess, EngineSpawner } from "./process.js";

export interface SearchRequest {
  fen: string;
  depth?: number;
  movetime?: number;
  multipv?: number;
  /**
   * Stops the search once this long has passed and answers with the best line it had reached, a
   * shallower one than `depth`. Without it the search runs to its depth or movetime, and fails when
   * the answer is more than the engine's search slack late.
   */
  capMs?: number;
}

export interface SearchResult {
  fen: string;
  bestmove: string | null;
  lines: Array<{ moves: string[]; score: number }>;
  /** The depth every line reached, the shallowest of them; unset when the searcher does not say. */
  depth?: number | undefined;
  /** True when `capMs` passed before the engine finished, so the search was stopped at what it had. */
  cutByTime?: boolean;
}

export interface Searcher {
  search(request: SearchRequest): Promise<SearchResult>;
}

export interface EngineTimeouts {
  startupMs: number;
  readyMs: number;
  searchSlackMs: number;
  quitGraceMs: number;
}

export const DEFAULT_TIMEOUTS: EngineTimeouts = {
  startupMs: 5000,
  readyMs: 5000,
  searchSlackMs: 5000,
  quitGraceMs: 2000,
};

interface Exchange {
  onLine(line: string): void;
  onExit(): void;
}

interface ReachedLine extends InfoLine {
  /** The depth the engine printed with the line; null when it printed none. */
  depth: number | null;
}

interface ReachedSearch {
  bestmoveLine: string;
  /** The engine's last line for each MultiPV rank, best first. */
  reached: ReachedLine[];
  cutByTime: boolean;
}

// parseInfoLine keeps a line's moves and score; the depth printed beside them is read here.
function infoDepth(line: string): number | null {
  const tokens = line.split(/\s+/);
  const at = tokens.indexOf("depth");
  const depth = at < 0 ? Number.NaN : Number(tokens[at + 1]);
  return Number.isInteger(depth) ? depth : null;
}

// A stop can leave MultiPV lines a layer apart, the first ones finished in the layer it cut and the
// rest still in the one before, so the depth every line reached is the shallowest of them.
function shallowestDepth(lines: ReachedLine[]): number | undefined {
  const depths = lines.map((line) => line.depth);
  if (depths.length === 0 || !depths.every((depth): depth is number => depth !== null)) {
    return undefined;
  }
  return Math.min(...depths);
}

export class UciEngine implements Searcher {
  private process: EngineProcess | null = null;
  private exchange: Exchange | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly options = new Map<string, string>();
  private restartFailed = false;
  private readonly timeouts: EngineTimeouts;

  constructor(
    private readonly spawner: EngineSpawner,
    timeouts: Partial<EngineTimeouts> = {},
  ) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
  }

  start(): Promise<void> {
    this.restartFailed = false;
    return this.enqueue(() => this.boot());
  }

  setOption(name: string, value: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.options.get(name) === value && this.process) return;
      this.options.set(name, value);
      if (!this.process) return;
      await this.ask(
        [`setoption name ${name} value ${value}`, "isready"],
        isReadyok,
        this.timeouts.readyMs,
      );
    });
  }

  search(request: SearchRequest): Promise<SearchResult> {
    return this.enqueue(() => this.runSearch(request));
  }

  async stop(): Promise<void> {
    await this.enqueue(async () => {
      const proc = this.process;
      this.process = null;
      if (!proc) return;
      await new Promise<void>((resolve) => {
        const grace = setTimeout(() => {
          proc.kill();
          resolve();
        }, this.timeouts.quitGraceMs);
        proc.onExit(() => {
          clearTimeout(grace);
          resolve();
        });
        proc.send("quit");
      });
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async runSearch(request: SearchRequest): Promise<SearchResult> {
    await this.ensureRunning();
    const position = new Chess(request.fen);
    const multipv = String(request.multipv ?? 1);
    if (this.options.get("MultiPV") !== multipv) {
      this.options.set("MultiPV", multipv);
      await this.guarded(
        this.ask(
          [`setoption name MultiPV value ${multipv}`, "isready"],
          isReadyok,
          this.timeouts.readyMs,
        ),
      );
    }
    const { bestmoveLine, reached, cutByTime } = await this.searchUntilBestmove(request);
    return {
      fen: request.fen,
      bestmove: this.validatedBestmove(bestmoveLine, position),
      lines: reached.map(({ moves, score }) => ({ moves, score })),
      depth: shallowestDepth(reached),
      cutByTime,
    };
  }

  private async searchUntilBestmove(request: SearchRequest): Promise<ReachedSearch> {
    const infos = new Map<number, ReachedLine>();
    const limit =
      request.movetime !== undefined
        ? `movetime ${request.movetime}`
        : `depth ${request.depth ?? 16}`;
    let cutByTime = false;
    const stopAtCap =
      request.capMs === undefined
        ? undefined
        : {
            afterMs: request.capMs,
            onStop: () => {
              cutByTime = true;
            },
          };
    const bestmoveLine = await this.guarded(
      this.ask(
        [`position fen ${request.fen}`, `go ${limit}`],
        (line) => {
          const info = parseInfoLine(line);
          if (info) infos.set(info.multipv, { ...info, depth: infoDepth(line) });
          return line.startsWith("bestmove");
        },
        (request.capMs ?? request.movetime ?? 0) + this.timeouts.searchSlackMs,
        stopAtCap,
      ),
    );
    const reached = [...infos.values()].sort((a, b) => a.multipv - b.multipv);
    return { bestmoveLine, reached, cutByTime };
  }

  private validatedBestmove(line: string, position: Chess): string | null {
    const move = parseBestmove(line);
    if (move === null) {
      if (position.isGameOver() && line.includes("(none)")) return null;
      this.discard();
      throw new EngineFault(
        "bad-bestmove",
        `engine returned "${line}" for a non-terminal position`,
      );
    }
    try {
      applyUci(position, move);
    } catch {
      this.discard();
      throw new EngineFault("bad-bestmove", `engine returned illegal move ${move}`);
    }
    return move;
  }

  private async ensureRunning(): Promise<void> {
    if (this.process) return;
    if (this.restartFailed) {
      throw new EngineFault("exited", "engine failed to restart; call start() to try again");
    }
    try {
      await this.boot();
    } catch (error) {
      this.restartFailed = true;
      throw error;
    }
  }

  private async boot(): Promise<void> {
    this.discard();
    const proc = this.spawner();
    this.process = proc;
    proc.onLine((line) => {
      if (this.process === proc) this.exchange?.onLine(line);
    });
    proc.onExit(() => {
      if (this.process === proc) this.exchange?.onExit();
    });
    try {
      await this.ask(["uci"], (line) => line === "uciok", this.timeouts.startupMs);
      const setup = [...this.options].map(
        ([name, value]) => `setoption name ${name} value ${value}`,
      );
      await this.ask([...setup, "isready"], isReadyok, this.timeouts.readyMs);
    } catch (error) {
      this.discard();
      throw error;
    }
  }

  /** A fault leaves the process in an unknown state, so the next request boots a fresh one. */
  private async guarded<T>(pending: Promise<T>): Promise<T> {
    try {
      return await pending;
    } catch (error) {
      if (error instanceof EngineFault) this.discard();
      throw error;
    }
  }

  private discard(): void {
    const proc = this.process;
    this.process = null;
    this.exchange = null;
    proc?.kill();
  }

  // With `stopAfter`, the engine is told to stop when that long has passed and its answer is then
  // waited for under the same timeout, which the caller sets to leave room for it.
  private ask(
    commands: string[],
    isDone: (line: string) => boolean,
    timeoutMs: number,
    stopAfter?: { afterMs: number; onStop: () => void },
  ): Promise<string> {
    const proc = this.process;
    if (!proc) return Promise.reject(new EngineFault("exited", "engine is not running"));
    return new Promise<string>((resolve, reject) => {
      const finish = (settle: () => void): void => {
        clearTimeout(timer);
        clearTimeout(stopTimer);
        this.exchange = null;
        settle();
      };
      const timer = setTimeout(
        () => finish(() => reject(new EngineFault("timeout", `no answer within ${timeoutMs} ms`))),
        timeoutMs,
      );
      const stopTimer = stopAfter
        ? setTimeout(() => {
            stopAfter.onStop();
            proc.send("stop");
          }, stopAfter.afterMs)
        : undefined;
      this.exchange = {
        onLine: (line) => {
          if (isDone(line)) finish(() => resolve(line));
        },
        onExit: () => finish(() => reject(new EngineFault("exited", "engine process exited"))),
      };
      for (const command of commands) proc.send(command);
    });
  }
}

function isReadyok(line: string): boolean {
  return line === "readyok";
}
