import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { USER_AGENT } from "../import/chesscom.js";

export const EXPLORER_RATINGS = "400,600";
export const EXPLORER_SPEEDS = "rapid,blitz";
export const EXPLORER_BAND_LABEL = "400-600";
export const ITALIAN_WHITE_RATINGS = "1800,2000,2200";
export const ITALIAN_WHITE_BAND_LABEL = "1800-2200";
export const MIN_REQUEST_GAP_MS = 1100;
export const RATE_LIMIT_WAIT_MS = 30_000;
export const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** One run asks the network at most this often; the cache makes the next run pick up where it stopped. */
export const MAX_REQUESTS_PER_RUN = 2000;
/** A position answer with eight moves is a few KB; the cap stops a broken or hostile answer. */
export const MAX_RESPONSE_BYTES = 256_000;
const MAX_MOVES_PER_POSITION = 50;
const MOVES_REQUESTED = 8;
const FETCH_TIMEOUT_MS = 15_000;
const EXPLORER_ORIGIN = "https://explorer.lichess.ovh/lichess";

export class ExplorerError extends Error {
  constructor(
    readonly code: "unauthorized" | "upstream" | "budget",
    message: string,
  ) {
    super(message);
  }
}

export class ExplorerRateLimited extends Error {
  constructor() {
    super("the explorer answered 429");
  }
}

const MoveSchema = z.object({
  san: z.string().min(1).max(12),
  white: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
  black: z.number().int().nonnegative(),
});
const PositionSchema = z.object({
  white: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
  black: z.number().int().nonnegative(),
  moves: z.array(MoveSchema).max(MAX_MOVES_PER_POSITION),
});
export type ExplorerMove = z.infer<typeof MoveSchema>;
export type ExplorerPosition = z.infer<typeof PositionSchema>;

export const gamesOf = (stats: { white: number; draws: number; black: number }): number =>
  stats.white + stats.draws + stats.black;

/** Moves are matched by SAN: the explorer writes castling as king-takes-rook in UCI. */
export interface ExplorerFetcher {
  /** The raw JSON text of one position; a 429 is an `ExplorerRateLimited`. */
  fetch(fen: string, ratings?: string): Promise<string>;
}

export interface ExplorerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemExplorerClock: ExplorerClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// The FEN comes from chess.js and the rest from constants, never from the browser.
export function explorerUrl(fen: string, ratings: string = EXPLORER_RATINGS): string {
  const query = new URLSearchParams({
    variant: "standard",
    speeds: EXPLORER_SPEEDS,
    ratings,
    moves: String(MOVES_REQUESTED),
    topGames: "0",
    recentGames: "0",
    fen,
  });
  return `${EXPLORER_ORIGIN}?${query.toString()}`;
}

export function httpExplorerFetcher(
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): ExplorerFetcher {
  return {
    async fetch(fen, ratings: string = EXPLORER_RATINGS) {
      const headers: Record<string, string> = {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetchImpl(explorerUrl(fen, ratings), {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }).catch((error: unknown) => {
        throw new ExplorerError("upstream", `the explorer could not be reached: ${String(error)}`);
      });
      if (response.status === 429) throw new ExplorerRateLimited();
      if (response.status === 401) {
        throw new ExplorerError(
          "unauthorized",
          "the explorer wants a Lichess API token: set LICHESS_API_TOKEN",
        );
      }
      if (!response.ok)
        throw new ExplorerError("upstream", `the explorer answered ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      const text = declared > MAX_RESPONSE_BYTES ? "" : await response.text();
      if (declared > MAX_RESPONSE_BYTES || text.length > MAX_RESPONSE_BYTES) {
        throw new ExplorerError("upstream", "the explorer answer is too large");
      }
      return text;
    },
  };
}

export function parsePosition(text: string): ExplorerPosition {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ExplorerError("upstream", "the explorer answered something that is not JSON");
  }
  const parsed = PositionSchema.safeParse(json);
  if (!parsed.success)
    throw new ExplorerError("upstream", "the explorer answered an unexpected shape");
  return parsed.data;
}

const CacheEntrySchema = z.object({ fetchedAt: z.number(), response: PositionSchema });

/** Paces, caches and bounds the calls of one run; every network attempt counts against the budget. */
export class CachedExplorer {
  requests = 0;
  cacheHits = 0;
  private lastRequestAt: number | null = null;

  constructor(
    private readonly fetcher: ExplorerFetcher,
    private readonly cacheDir: string,
    private readonly clock: ExplorerClock,
    private readonly maxRequests: number = MAX_REQUESTS_PER_RUN,
  ) {}

  async position(fen: string, ratings: string = EXPLORER_RATINGS): Promise<ExplorerPosition> {
    const file = join(
      this.cacheDir,
      `${createHash("sha256").update(explorerUrl(fen, ratings)).digest("hex")}.json`,
    );
    const cached = this.readFresh(file);
    if (cached) {
      this.cacheHits += 1;
      return cached;
    }
    const response = parsePosition(await this.fetchPaced(fen, ratings));
    this.store(file, response);
    return response;
  }

  private readFresh(file: string): ExplorerPosition | null {
    try {
      const entry = CacheEntrySchema.parse(JSON.parse(readFileSync(file, "utf8")));
      return this.clock.now() - entry.fetchedAt < CACHE_MAX_AGE_MS ? entry.response : null;
    } catch {
      return null;
    }
  }

  private store(file: string, response: ExplorerPosition): void {
    mkdirSync(this.cacheDir, { recursive: true });
    const partial = `${file}.tmp`;
    writeFileSync(partial, JSON.stringify({ fetchedAt: this.clock.now(), response }));
    renameSync(partial, file);
  }

  private async fetchPaced(fen: string, ratings: string): Promise<string> {
    try {
      return await this.attempt(fen, ratings);
    } catch (error) {
      if (!(error instanceof ExplorerRateLimited)) throw error;
      await this.clock.sleep(RATE_LIMIT_WAIT_MS);
    }
    try {
      return await this.attempt(fen, ratings);
    } catch (error) {
      if (!(error instanceof ExplorerRateLimited)) throw error;
      throw new ExplorerError("upstream", "the explorer is still rate limiting after a wait");
    }
  }

  private async attempt(fen: string, ratings: string): Promise<string> {
    if (this.requests >= this.maxRequests) {
      throw new ExplorerError("budget", `the run reached its ${this.maxRequests} request limit`);
    }
    if (this.lastRequestAt !== null) {
      const wait = this.lastRequestAt + MIN_REQUEST_GAP_MS - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
    }
    this.requests += 1;
    this.lastRequestAt = this.clock.now();
    return this.fetcher.fetch(fen, ratings);
  }
}
