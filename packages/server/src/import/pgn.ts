import { createHash } from "node:crypto";
import { Chess } from "chess.js";
import {
  type Finish,
  type GameResult,
  type ImportedGame,
  insertImportedGame,
  type NewMove,
  type PlayerColor,
  type Termination,
} from "../db/games.js";
import type { Database } from "../db/open.js";

// A real game is a few KB; the cap exists so a pasted blob cannot stall the parser.
export const MAX_PGN_BYTES = 100_000;
const DEFAULT_TARGET_ELO = 1200;
const MIN_TARGET_ELO = 100;
const MAX_TARGET_ELO = 3190;

export class PgnImportError extends Error {}

export interface ImportRequest {
  pgn: string;
  playerColor: PlayerColor;
  source: "chesscom" | "lichess" | "pgn";
  /** The site's own game id (Chess.com uuid, Lichess id); a hash of the PGN text when absent. */
  sourceId?: string;
  sourceUrl?: string;
  opponent?: string;
  studentRating?: number;
  opponentRating?: number;
  timeControl?: string;
  /** ISO time the game ended; the PGN headers are the fallback. */
  playedAt?: string;
  now?: () => Date;
}

export function pgnSourceId(pgn: string): string {
  return `pgn:${createHash("sha256").update(pgn.trim()).digest("hex")}`;
}

function headerTime(headers: Record<string, string | null>): string | null {
  const date = headers.UTCDate ?? headers.Date;
  if (!date || !/^\d{4}\.\d{2}\.\d{2}$/.test(date)) return null;
  const time =
    headers.UTCTime && /^\d{2}:\d{2}:\d{2}$/.test(headers.UTCTime) ? headers.UTCTime : "00:00:00";
  const parsed = new Date(`${date.replaceAll(".", "-")}T${time}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function gameResult(headers: Record<string, string | null>): GameResult {
  const result = headers.Result;
  if (result === "1-0" || result === "0-1" || result === "1/2-1/2") return result;
  throw new PgnImportError("the game has no result: only finished games can be imported");
}

// The enum has no timeout, so a game lost on time reads as a resignation.
function terminationOf(chess: Chess, result: GameResult, text: string | null): Termination {
  if (chess.isCheckmate()) return "checkmate";
  if (chess.isStalemate()) return "stalemate";
  if (result === "1/2-1/2") return "draw";
  return /abandon/i.test(text ?? "") ? "abort" : "resign";
}

function clampElo(rating: number | undefined): number {
  return Math.min(MAX_TARGET_ELO, Math.max(MIN_TARGET_ELO, rating ?? DEFAULT_TARGET_ELO));
}

function replayMoves(chess: Chess, playerColor: PlayerColor): NewMove[] {
  const student = playerColor === "white" ? "w" : "b";
  return chess.history({ verbose: true }).map((move, index) => ({
    ply: index + 1,
    san: move.san,
    uci: `${move.from}${move.to}${move.promotion ?? ""}`,
    fenBefore: move.before,
    fenAfter: move.after,
    isPlayer: move.color === student,
  }));
}

/** Parses a finished game and returns what the database needs; throws PgnImportError on anything unusable. */
export function parseFinishedGame(request: ImportRequest): ImportedGame {
  if (Buffer.byteLength(request.pgn, "utf8") > MAX_PGN_BYTES) {
    throw new PgnImportError(`the PGN is larger than ${MAX_PGN_BYTES} bytes`);
  }
  const chess = new Chess();
  try {
    chess.loadPgn(request.pgn);
  } catch (error) {
    throw new PgnImportError(error instanceof Error ? error.message : "the PGN could not be read");
  }
  const headers = chess.getHeaders() as Record<string, string | null>;
  const moves = replayMoves(chess, request.playerColor);
  if (moves.length === 0) throw new PgnImportError("the PGN has no moves");
  const result = gameResult(headers);
  const playedAt = request.playedAt ?? headerTime(headers);
  const finishedAt = playedAt ?? (request.now ?? (() => new Date()))().toISOString();
  const finish: Finish = {
    result,
    termination: terminationOf(chess, result, headers.Termination ?? null),
    finishedAt,
  };
  return {
    playerColor: request.playerColor,
    targetElo: clampElo(request.studentRating),
    initialFen: (moves[0] as NewMove).fenBefore,
    startedAt: finishedAt,
    finish,
    pgn: request.pgn,
    moves,
    source: request.source,
    sourceId: request.sourceId ?? pgnSourceId(request.pgn),
    sourceUrl: request.sourceUrl ?? null,
    opponent: request.opponent ?? null,
    studentRating: request.studentRating ?? null,
    opponentRating: request.opponentRating ?? null,
    timeControl: request.timeControl ?? null,
    playedAt,
  };
}

/** Returns the new game id, or null when this source id was imported before. */
export function importFinishedGame(db: Database, request: ImportRequest): number | null {
  return insertImportedGame(db, parseFinishedGame(request));
}

/** Picks the student's side by matching the White/Black headers against known usernames. */
export function colorFromHeaders(pgn: string, usernames: string[]): PlayerColor | null {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn);
  } catch {
    return null;
  }
  const known = new Set(usernames.map((name) => name.toLowerCase()));
  const { White, Black } = chess.getHeaders();
  if (White && known.has(White.toLowerCase())) return "white";
  if (Black && known.has(Black.toLowerCase())) return "black";
  return null;
}
