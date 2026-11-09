import type {
  ChessComListedGame,
  ChessComListResponse,
  ImportResult,
  ImportStatus,
} from "@chess-coach/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { resolveLichessToken, storedChessComUsername } from "../db/connections.js";
import { getIdsBySource } from "../db/games.js";
import type { Database } from "../db/open.js";
import {
  assertUsername,
  ChessComError,
  type ChessComGame,
  type ChessComSource,
  resultOf,
  studentColorIn,
} from "../import/chesscom.js";
import type { ImportGrader } from "../import/grader.js";
import {
  assertLichessUsername,
  httpLichessGamesFetcher,
  LichessError,
  type LichessGamesFetcher,
  lichessImportRequest,
} from "../import/lichess.js";
import {
  colorFromHeaders,
  importFinishedGame,
  MAX_PGN_BYTES,
  PgnImportError,
} from "../import/pgn.js";
import { type Log, silentLog } from "../log.js";

export interface ImportRoutesOptions {
  db: Database;
  source: ChessComSource;
  /** Where Lichess games come from; the real export, with the saved or environment token, when absent. */
  lichess?: LichessGamesFetcher;
  grader: ImportGrader;
  /** Usernames that identify the student's side in a pasted PGN. */
  usernames: string[];
  log?: Log;
}

const MAX_UUIDS_PER_IMPORT = 100;
const listBody = z.object({ username: z.string(), from: z.string(), to: z.string() });
const lichessBody = listBody;
const importBody = z.object({
  username: z.string(),
  uuids: z.array(z.string().min(1).max(64)).min(1).max(MAX_UUIDS_PER_IMPORT),
});
const pgnBody = z.object({
  pgn: z.string().min(1).max(MAX_PGN_BYTES),
  student_color: z.enum(["white", "black"]).optional(),
});

const STATUS_BY_CODE = {
  invalid_username: 400,
  invalid_range: 400,
  unknown_games: 409,
  upstream: 502,
} as const;

const LICHESS_STATUS_BY_CODE = {
  invalid_username: 400,
  invalid_range: 400,
  not_found: 404,
  rate_limited: 429,
  upstream: 502,
} as const;

async function fail(reply: FastifyReply, status: number, error: string, message: string) {
  await reply.code(status).send({ error, message });
  return undefined;
}

async function failFrom(reply: FastifyReply, error: unknown) {
  if (error instanceof ChessComError) {
    return fail(reply, STATUS_BY_CODE[error.code], error.code, error.message);
  }
  if (error instanceof LichessError) {
    return fail(reply, LICHESS_STATUS_BY_CODE[error.code], error.code, error.message);
  }
  if (error instanceof PgnImportError) return fail(reply, 400, "invalid_pgn", error.message);
  throw error;
}

function listed(game: ChessComGame, username: string, imported: Set<string>): ChessComListedGame {
  const color = studentColorIn(game, username) ?? "white";
  const mine = color === "white" ? game.white : game.black;
  const theirs = color === "white" ? game.black : game.white;
  return {
    uuid: game.uuid,
    url: game.url,
    played_at: new Date(game.end_time * 1000).toISOString(),
    opponent: theirs.username,
    student_color: color,
    result: resultOf(game),
    time_control: game.time_control ?? null,
    student_rating: mine.rating ?? null,
    opponent_rating: theirs.rating ?? null,
    already_imported: imported.has(game.uuid),
  };
}

function importChessComGame(db: Database, game: ChessComGame, username: string): number | null {
  const color = studentColorIn(game, username);
  if (!color) throw new PgnImportError(`${username} did not play game ${game.uuid}`);
  const mine = color === "white" ? game.white : game.black;
  const theirs = color === "white" ? game.black : game.white;
  return importFinishedGame(db, {
    pgn: game.pgn as string,
    playerColor: color,
    source: "chesscom",
    sourceId: game.uuid,
    sourceUrl: game.url,
    opponent: theirs.username,
    ...(mine.rating !== undefined && { studentRating: mine.rating }),
    ...(theirs.rating !== undefined && { opponentRating: theirs.rating }),
    ...(game.time_control && { timeControl: game.time_control }),
    playedAt: new Date(game.end_time * 1000).toISOString(),
  });
}

export function registerImportRoutes(app: FastifyInstance, options: ImportRoutesOptions): void {
  const { db, source, grader } = options;
  const log = options.log ?? silentLog;
  // The token is read at each export, so one saved in Connections applies with no restart.
  const lichess = options.lichess ?? httpLichessGamesFetcher(() => resolveLichessToken(db));

  app.post(
    "/api/import/chesscom/list",
    async (request, reply): Promise<ChessComListResponse | undefined> => {
      const body = listBody.safeParse(request.body);
      if (!body.success)
        return fail(reply, 400, "invalid_body", "username, from and to are required");
      try {
        const games = await source.games(body.data.username, body.data.from, body.data.to);
        const imported = getIdsBySource(
          db,
          "chesscom",
          games.map((game) => game.uuid),
        );
        log.info("import.chesscom_listed", {
          username: body.data.username,
          from: body.data.from,
          to: body.data.to,
          games: games.length,
          already_imported: imported.size,
        });
        return { games: games.map((game) => listed(game, body.data.username, imported)) };
      } catch (error) {
        log.error("import.failed", error, { route: "chesscom_list", username: body.data.username });
        return failFrom(reply, error);
      }
    },
  );

  app.post("/api/import/chesscom", async (request, reply): Promise<ImportResult | undefined> => {
    const body = importBody.safeParse(request.body);
    if (!body.success)
      return fail(reply, 400, "invalid_body", "username and 1 to 100 uuids are required");
    try {
      const username = assertUsername(body.data.username);
      const games = source.lookup(username, [...new Set(body.data.uuids)]);
      const result: ImportResult = { imported: 0, skipped: 0 };
      const failed: NonNullable<ImportResult["failed"]> = [];
      for (const game of games) {
        try {
          if (importChessComGame(db, game, username) === null) result.skipped += 1;
          else result.imported += 1;
        } catch (error) {
          if (!(error instanceof PgnImportError)) throw error;
          failed.push({ id: game.uuid, message: error.message });
        }
      }
      if (failed.length > 0) result.failed = failed;
      log.info("import.chesscom", {
        username,
        requested: body.data.uuids.length,
        imported: result.imported,
        skipped: result.skipped,
        failed,
      });
      if (result.imported > 0) grader.kick();
      return result;
    } catch (error) {
      log.error("import.failed", error, { route: "chesscom", username: body.data.username });
      return failFrom(reply, error);
    }
  });

  // One step, unlike Chess.com's list and pick: the export is the whole range, and a second run
  // is safe because a stored game id is skipped.
  app.post("/api/import/lichess", async (request, reply): Promise<ImportResult | undefined> => {
    const body = lichessBody.safeParse(request.body);
    if (!body.success)
      return fail(reply, 400, "invalid_body", "username, from and to are required");
    try {
      const username = assertLichessUsername(body.data.username);
      const games = await lichess.games(username, body.data.from, body.data.to);
      const result: ImportResult = { imported: 0, skipped: 0 };
      const failed: NonNullable<ImportResult["failed"]> = [];
      for (const game of games) {
        try {
          if (importFinishedGame(db, lichessImportRequest(game, username)) === null) {
            result.skipped += 1;
          } else result.imported += 1;
        } catch (error) {
          if (!(error instanceof PgnImportError)) throw error;
          failed.push({ id: game.id, message: error.message });
        }
      }
      if (failed.length > 0) result.failed = failed;
      log.info("import.lichess", {
        username,
        from: body.data.from,
        to: body.data.to,
        listed: games.length,
        imported: result.imported,
        skipped: result.skipped,
        failed,
      });
      if (result.imported > 0) grader.kick();
      return result;
    } catch (error) {
      log.error("import.failed", error, { route: "lichess", username: body.data.username });
      return failFrom(reply, error);
    }
  });

  app.post("/api/import/pgn", async (request, reply): Promise<ImportResult | undefined> => {
    const body = pgnBody.safeParse(request.body);
    if (!body.success)
      return fail(reply, 400, "invalid_body", "pgn is required and at most 100000 bytes");
    const saved = storedChessComUsername(db);
    const accounts = saved === null ? options.usernames : [...options.usernames, saved];
    const color = body.data.student_color ?? colorFromHeaders(body.data.pgn, accounts);
    if (!color) {
      return fail(
        reply,
        400,
        "student_color_required",
        "say which side you played: white or black",
      );
    }
    try {
      const id = importFinishedGame(db, { pgn: body.data.pgn, playerColor: color, source: "pgn" });
      log.info("import.pgn", { game_id: id, student_color: color, skipped: id === null });
      if (id !== null) grader.kick();
      return { imported: id === null ? 0 : 1, skipped: id === null ? 1 : 0 };
    } catch (error) {
      log.error("import.failed", error, { route: "pgn", bytes: body.data.pgn.length });
      return failFrom(reply, error);
    }
  });

  app.get("/api/import/status", async (): Promise<ImportStatus> => {
    const progress = grader.progress();
    return {
      pending: progress.pending,
      failed: progress.failed,
      running: progress.running && {
        game_id: progress.running.gameId,
        graded_plies: progress.running.gradedPlies,
        total_plies: progress.running.totalPlies,
      },
    };
  });
}
