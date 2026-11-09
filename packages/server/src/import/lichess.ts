import { z } from "zod";
import type { PlayerColor } from "../db/games.js";
import { monthsBetween, USER_AGENT } from "./chesscom.js";
import { type ImportRequest, PgnImportError } from "./pgn.js";

// Every existing Lichess account matches this, and it is also all that may reach a URL path.
export const LICHESS_USERNAME_PATTERN = /^[A-Za-z0-9_-]{2,30}$/;
// Lichess asks a client that got a 429 to stay away for a full minute.
export const LICHESS_RATE_LIMIT_WAIT_MS = 60_000;
// An export streams at 20 to 30 games a second and a game is about 3 KB, so these two bound a
// range of several thousand games and stop a broken or hostile answer from filling memory.
export const LICHESS_EXPORT_MAX_BYTES = 20_000_000;
const LICHESS_FETCH_TIMEOUT_MS = 5 * 60_000;
const LICHESS_ORIGIN = "https://lichess.org";
// These never reach a result, so they are not games to grade.
const UNFINISHED_STATUSES = new Set(["created", "started", "aborted", "noStart"]);

export class LichessError extends Error {
  constructor(
    readonly code: "invalid_username" | "invalid_range" | "not_found" | "rate_limited" | "upstream",
    message: string,
  ) {
    super(message);
  }
}

const PlayerSchema = z.object({
  user: z.object({ id: z.string(), name: z.string() }).optional(),
  rating: z.number().int().optional(),
  aiLevel: z.number().int().optional(),
});
const ExportLineSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9]{8}$/),
  variant: z.string(),
  status: z.string(),
  createdAt: z.number().int(),
  lastMoveAt: z.number().int(),
  players: z.object({ white: PlayerSchema, black: PlayerSchema }),
  pgn: z.string().optional(),
  clock: z
    .object({ initial: z.number().int().nonnegative(), increment: z.number().int().nonnegative() })
    .optional(),
  daysPerTurn: z.number().int().positive().optional(),
});
type LichessPlayer = z.infer<typeof PlayerSchema>;
/** A finished standard game with its PGN: the only kind the importer reads. */
export type LichessGame = z.infer<typeof ExportLineSchema> & { pgn: string };

export interface LichessGamesFetcher {
  /** Games the account finished in the months, oldest first; a quiet account is an empty list. */
  games(username: string, from: string, to: string): Promise<LichessGame[]>;
}

export function assertLichessUsername(username: string): string {
  if (!LICHESS_USERNAME_PATTERN.test(username)) {
    throw new LichessError(
      "invalid_username",
      "a Lichess username is 2 to 30 letters, digits, _ or -",
    );
  }
  return username.toLowerCase();
}

// Whole UTC months, as Chess.com's archives are; `until` stops one millisecond short of the next month.
function rangeInMilliseconds(from: string, to: string): { since: number; until: number } {
  let months: ReturnType<typeof monthsBetween>;
  try {
    months = monthsBetween(from, to);
  } catch (error) {
    throw new LichessError(
      "invalid_range",
      error instanceof Error ? error.message : "the range is not valid",
    );
  }
  const first = months[0] as (typeof months)[number];
  const last = months[months.length - 1] as (typeof months)[number];
  return {
    since: Date.UTC(first.year, first.month - 1, 1),
    until: Date.UTC(last.year, last.month, 1) - 1,
  };
}

// The name is validated and everything else is a constant, so nothing from the browser shapes the URL.
export function lichessGamesUrl(username: string, from: string, to: string): string {
  const name = assertLichessUsername(username);
  const { since, until } = rangeInMilliseconds(from, to);
  const query = new URLSearchParams({
    since: String(since),
    until: String(until),
    pgnInJson: "true",
    ongoing: "false",
  });
  return `${LICHESS_ORIGIN}/api/games/user/${name}?${query.toString()}`;
}

function isGradable(line: z.infer<typeof ExportLineSchema>): line is LichessGame {
  return (
    line.variant === "standard" &&
    !UNFINISHED_STATUSES.has(line.status) &&
    line.pgn !== undefined &&
    line.pgn !== ""
  );
}

/**
 * Reads the NDJSON of an export. A line that is not a game at all fails the whole read, so a changed
 * format never passes for an account with no games. Lichess streams the newest game first; the
 * result is oldest first, so stored ids grow with time and the list reads newest on top.
 */
export function parseLichessGames(text: string): LichessGame[] {
  const games: LichessGame[] = [];
  for (const row of text.split("\n")) {
    const line = row.trim();
    if (line === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new LichessError("upstream", "Lichess answered something that is not NDJSON");
    }
    const parsed = ExportLineSchema.safeParse(json);
    if (!parsed.success) {
      throw new LichessError("upstream", "Lichess answered an unexpected shape");
    }
    if (isGradable(parsed.data)) games.push(parsed.data);
  }
  return games.sort((a, b) => a.lastMoveAt - b.lastMoveAt);
}

export function lichessSideOf(game: LichessGame, username: string): PlayerColor | null {
  const name = username.toLowerCase();
  if (game.players.white.user?.id.toLowerCase() === name) return "white";
  if (game.players.black.user?.id.toLowerCase() === name) return "black";
  return null;
}

function opponentName(player: LichessPlayer): string {
  if (player.user) return player.user.name;
  return player.aiLevel === undefined ? "Anonymous" : `Stockfish level ${player.aiLevel}`;
}

// The same shapes Chess.com writes, so the time class works on both: "300+3", and "1/259200" for
// a correspondence game that allows 3 days a move.
function timeControlOf(game: LichessGame): string | null {
  if (game.clock) return `${game.clock.initial}+${game.clock.increment}`;
  return game.daysPerTurn ? `1/${game.daysPerTurn * 86_400}` : null;
}

/** What the importer stores for one game; throws PgnImportError when the account is not a player in it. */
export function lichessImportRequest(game: LichessGame, username: string): ImportRequest {
  const color = lichessSideOf(game, username);
  if (!color) throw new PgnImportError(`${username} did not play game ${game.id}`);
  const mine = color === "white" ? game.players.white : game.players.black;
  const theirs = color === "white" ? game.players.black : game.players.white;
  const timeControl = timeControlOf(game);
  return {
    pgn: game.pgn,
    playerColor: color,
    source: "lichess",
    sourceId: game.id,
    sourceUrl: `${LICHESS_ORIGIN}/${game.id}`,
    opponent: opponentName(theirs),
    ...(mine.rating !== undefined && { studentRating: mine.rating }),
    ...(theirs.rating !== undefined && { opponentRating: theirs.rating }),
    ...(timeControl !== null && { timeControl }),
    playedAt: new Date(game.lastMoveAt).toISOString(),
  };
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function tooLarge(): LichessError {
  return new LichessError(
    "upstream",
    "that range holds too many games for one import: pick fewer months",
  );
}

// Counts bytes as they arrive, so an endless stream stops at the cap instead of after it.
async function readWithinCap(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length") ?? 0) > LICHESS_EXPORT_MAX_BYTES) {
    await discardBody(response);
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > LICHESS_EXPORT_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
}

/**
 * The token is asked for on every call, so one saved in the app applies with no restart. It goes
 * only into the Authorization header, and no message below quotes an error from the network layer,
 * because the one that refuses a malformed header repeats its value.
 */
export function httpLichessGamesFetcher(
  token: () => string | undefined,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = pause,
): LichessGamesFetcher {
  const request = async (url: string): Promise<Response> => {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/x-ndjson",
    };
    const secret = token();
    if (secret) headers.Authorization = `Bearer ${secret}`;
    try {
      // A redirect would carry the token somewhere else.
      return await fetchImpl(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(LICHESS_FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new LichessError("upstream", "Lichess could not be reached");
    }
  };

  const requestWithOneRetry = async (url: string): Promise<Response> => {
    const first = await request(url);
    if (first.status !== 429) return first;
    await discardBody(first);
    await sleep(LICHESS_RATE_LIMIT_WAIT_MS);
    const second = await request(url);
    if (second.status !== 429) return second;
    await discardBody(second);
    throw new LichessError(
      "rate_limited",
      "Lichess is rate limiting this app. Wait a few minutes, then import again.",
    );
  };

  return {
    async games(username, from, to) {
      const response = await requestWithOneRetry(lichessGamesUrl(username, from, to));
      if (response.status === 404) {
        await discardBody(response);
        throw new LichessError("not_found", "Lichess has no account with that name.");
      }
      if (response.status === 401) {
        await discardBody(response);
        throw new LichessError(
          "upstream",
          "Lichess did not accept the saved API token. Replace or remove it in Connections.",
        );
      }
      if (!response.ok) {
        await discardBody(response);
        throw new LichessError("upstream", `Lichess answered ${response.status}`);
      }
      const text = await readWithinCap(response).catch((error: unknown) => {
        if (error instanceof LichessError) throw error;
        throw new LichessError(
          "upstream",
          "Lichess stopped answering before the export was complete",
        );
      });
      return parseLichessGames(text);
    },
  };
}
