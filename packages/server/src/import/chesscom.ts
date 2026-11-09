import { z } from "zod";
import { type Clock, systemClock } from "../clock.js";
import type { PlayerColor } from "../db/games.js";

export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,25}$/;
export const MAX_RANGE_MONTHS = 36;
export const MONTH_CACHE_MS = 10 * 60 * 1000;
const MAX_CACHED_MONTHS = 64;
const FETCH_TIMEOUT_MS = 15_000;
// A month of a busy player is well under 1 MB; the cap stops a hostile or broken answer from filling memory.
const MAX_MONTH_BYTES = 20_000_000;
export const USER_AGENT = "chess-coach (https://github.com/gabrielassisxyz/chess-coach)";

const SideSchema = z.object({
  username: z.string(),
  rating: z.number().int().optional(),
  result: z.string(),
});
const ChessComGameSchema = z.object({
  uuid: z.string().min(1),
  url: z.string(),
  pgn: z.string().optional(),
  time_control: z.string().optional(),
  end_time: z.number().int(),
  rules: z.string().optional(),
  white: SideSchema,
  black: SideSchema,
});
export type ChessComGame = z.infer<typeof ChessComGameSchema>;
const MonthSchema = z.object({ games: z.array(z.unknown()) });
const ProfileSchema = z.object({ username: z.string() });

export interface ChessComFetcher {
  /** Games of one month; a month the player never played in is an empty list, not an error. */
  month(username: string, year: number, month: number): Promise<ChessComGame[]>;
  /** False only when Chess.com says the account does not exist; any other failure throws. */
  playerExists(username: string): Promise<boolean>;
}

export class ChessComError extends Error {
  constructor(
    readonly code: "invalid_username" | "invalid_range" | "upstream" | "unknown_games",
    message: string,
  ) {
    super(message);
  }
}

export function assertUsername(username: string): string {
  if (!USERNAME_PATTERN.test(username)) {
    throw new ChessComError(
      "invalid_username",
      "a Chess.com username is 3 to 25 letters, digits, _ or -",
    );
  }
  return username.toLowerCase();
}

export function httpFetcher(fetchImpl: typeof fetch = fetch): ChessComFetcher {
  const request = (url: string): Promise<Response> =>
    fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch((error: unknown) => {
      throw new ChessComError("upstream", `Chess.com could not be reached: ${String(error)}`);
    });
  return {
    async playerExists(username) {
      const response = await request(
        `https://api.chess.com/pub/player/${assertUsername(username)}`,
      );
      if (response.status === 404) return false;
      if (!response.ok)
        throw new ChessComError("upstream", `Chess.com answered ${response.status}`);
      const profile = ProfileSchema.safeParse(await response.json().catch(() => null));
      if (!profile.success) throw new ChessComError("upstream", "Chess.com answer is unreadable");
      return true;
    },
    async month(username, year, month) {
      const mm = String(month).padStart(2, "0");
      const response = await request(
        `https://api.chess.com/pub/player/${assertUsername(username)}/games/${year}/${mm}`,
      );
      if (response.status === 404) return [];
      if (!response.ok)
        throw new ChessComError("upstream", `Chess.com answered ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_MONTH_BYTES)
        throw new ChessComError("upstream", "Chess.com answer is too large");
      return parseMonth(text);
    },
  };
}

export function parseMonth(text: string): ChessComGame[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ChessComError("upstream", "Chess.com answered something that is not JSON");
  }
  const month = MonthSchema.safeParse(json);
  if (!month.success) throw new ChessComError("upstream", "Chess.com answered an unexpected shape");
  // Variants and games without a PGN cannot be graded as standard chess, so they never reach the list.
  return month.data.games.flatMap((raw) => {
    const game = ChessComGameSchema.safeParse(raw);
    return game.success && game.data.pgn && (game.data.rules ?? "chess") === "chess"
      ? [game.data]
      : [];
  });
}

export function monthsBetween(from: string, to: string): Array<{ year: number; month: number }> {
  const pattern = /^(\d{4})-(0[1-9]|1[0-2])$/;
  const start = pattern.exec(from);
  const end = pattern.exec(to);
  if (!start || !end) throw new ChessComError("invalid_range", "from and to are YYYY-MM");
  const first = Number(start[1]) * 12 + Number(start[2]) - 1;
  const last = Number(end[1]) * 12 + Number(end[2]) - 1;
  if (last < first) throw new ChessComError("invalid_range", "from is after to");
  if (last - first + 1 > MAX_RANGE_MONTHS) {
    throw new ChessComError("invalid_range", `the range is at most ${MAX_RANGE_MONTHS} months`);
  }
  return Array.from({ length: last - first + 1 }, (_, index) => ({
    year: Math.floor((first + index) / 12),
    month: ((first + index) % 12) + 1,
  }));
}

const DRAW_RESULTS = new Set([
  "agreed",
  "repetition",
  "stalemate",
  "insufficient",
  "50move",
  "timevsinsufficient",
]);

export function studentColorIn(game: ChessComGame, username: string): PlayerColor | null {
  const name = username.toLowerCase();
  if (game.white.username.toLowerCase() === name) return "white";
  if (game.black.username.toLowerCase() === name) return "black";
  return null;
}

export function resultOf(game: ChessComGame): "1-0" | "0-1" | "1/2-1/2" | null {
  if (game.white.result === "win") return "1-0";
  if (game.black.result === "win") return "0-1";
  return DRAW_RESULTS.has(game.white.result) ? "1/2-1/2" : null;
}

interface CachedMonth {
  at: number;
  games: ChessComGame[];
}

/** Fetches each month once per ten minutes and remembers games so a later import can find them by uuid. */
export class ChessComSource {
  private readonly cache = new Map<string, CachedMonth>();

  constructor(
    private readonly fetcher: ChessComFetcher,
    private readonly clock: Clock = systemClock,
  ) {}

  async games(username: string, from: string, to: string): Promise<ChessComGame[]> {
    const name = assertUsername(username);
    const found: ChessComGame[] = [];
    for (const { year, month } of monthsBetween(from, to)) {
      found.push(...(await this.month(name, year, month)));
    }
    return found.sort((a, b) => b.end_time - a.end_time);
  }

  /** Looks the uuids up in the months already listed; finished games never change, so age does not matter. */
  lookup(username: string, uuids: string[]): ChessComGame[] {
    const prefix = `${assertUsername(username)}/`;
    const known = new Map<string, ChessComGame>();
    for (const [key, entry] of this.cache) {
      if (!key.startsWith(prefix)) continue;
      for (const game of entry.games) known.set(game.uuid, game);
    }
    const missing = uuids.filter((uuid) => !known.has(uuid));
    if (missing.length > 0) {
      throw new ChessComError(
        "unknown_games",
        "those games are not in the last listing: list them again",
      );
    }
    return uuids.map((uuid) => known.get(uuid) as ChessComGame);
  }

  private async month(name: string, year: number, month: number): Promise<ChessComGame[]> {
    const key = `${name}/${year}/${month}`;
    const cached = this.cache.get(key);
    if (cached && this.clock.now().getTime() - cached.at < MONTH_CACHE_MS) return cached.games;
    const games = await this.fetcher.month(name, year, month);
    this.cache.delete(key);
    this.cache.set(key, { at: this.clock.now().getTime(), games });
    if (this.cache.size > MAX_CACHED_MONTHS) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    return games;
  }
}
