import type { ConnectionsStatus } from "@chess-coach/shared";
import { DEFAULT_POSITION } from "chess.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type Clock, systemClock } from "../clock.js";
import {
  clearChessComUsername,
  clearLichessToken,
  hasLichessToken,
  setChessComUsername,
  setLichessToken,
  storedChessComUsername,
} from "../db/connections.js";
import type { Database } from "../db/open.js";
import { assertUsername, ChessComError, type ChessComFetcher } from "../import/chesscom.js";
import { type Log, silentLog } from "../log.js";
import { ExplorerError, type ExplorerFetcher } from "../openings/explorer-client.js";
import { isUpgradeAllowed } from "../ws/origin.js";

export interface ConnectionRoutesOptions {
  db: Database;
  chessCom: ChessComFetcher;
  explorerFor(token: string): ExplorerFetcher;
  allowedOrigins: readonly string[];
  clock?: Clock;
  log?: Log;
}

// Anything else would reach the Authorization header, and the error that refuses a bad header
// quotes its value.
const tokenBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) });
const usernameBody = z.object({ username: z.string() });

interface Refusal {
  status: number;
  error: string;
  message: string;
}

const TOKEN_REFUSALS = {
  malformed: {
    status: 400,
    error: "invalid_token",
    message: "That does not look like a Lichess API token.",
  },
  rejected: {
    status: 400,
    error: "lichess_token_rejected",
    message: "Lichess did not accept that token.",
  },
  unreachable: {
    status: 502,
    error: "lichess_unreachable",
    message: "Lichess could not be reached, so the token was not saved. Try again.",
  },
} as const satisfies Record<string, Refusal>;

const ACCOUNT_REFUSALS = {
  malformed: {
    status: 400,
    error: "invalid_username",
    message: "A Chess.com username is 3 to 25 letters, digits, _ or -.",
  },
  missing: {
    status: 404,
    error: "chesscom_user_not_found",
    message: "Chess.com has no account with that name.",
  },
  unreachable: {
    status: 502,
    error: "chesscom_unreachable",
    message: "Chess.com could not be reached, so the account was not saved. Try again.",
  },
} as const satisfies Record<string, Refusal>;

// The refusal is chosen here so that no upstream message, which could quote the token, travels on.
async function tokenRefusal(explorer: ExplorerFetcher): Promise<Refusal | null> {
  try {
    await explorer.fetch(DEFAULT_POSITION);
    return null;
  } catch (error) {
    const rejected = error instanceof ExplorerError && error.code === "unauthorized";
    return rejected ? TOKEN_REFUSALS.rejected : TOKEN_REFUSALS.unreachable;
  }
}

async function accountRefusal(chessCom: ChessComFetcher, name: string): Promise<Refusal | null> {
  try {
    return (await chessCom.playerExists(name)) ? null : ACCOUNT_REFUSALS.missing;
  } catch (error) {
    if (error instanceof ChessComError && error.code === "upstream") {
      return ACCOUNT_REFUSALS.unreachable;
    }
    throw error;
  }
}

function normalisedUsername(username: string): string | null {
  try {
    return assertUsername(username);
  } catch {
    return null;
  }
}

export function registerConnectionRoutes(
  app: FastifyInstance,
  options: ConnectionRoutesOptions,
): void {
  const { db, chessCom, explorerFor, allowedOrigins } = options;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? silentLog;
  const now = (): string => clock.now().toISOString();
  const status = (): ConnectionsStatus => ({
    lichess_token_set: hasLichessToken(db),
    chesscom_username: storedChessComUsername(db),
  });
  const refuse = async (reply: FastifyReply, event: string, refusal: Refusal) => {
    log.warn(event, { code: refusal.error });
    await reply.code(refusal.status).send({ error: refusal.error, message: refusal.message });
    return undefined;
  };

  // The socket's rule: a browser always sends Origin on these methods, and pinning Host as well is
  // what stops a DNS-rebinding page, which is same-origin to itself, from replacing the token.
  const writeGuard = {
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      const { origin, host } = request.headers;
      if (isUpgradeAllowed({ origin, host }, allowedOrigins)) return;
      log.warn("connections.origin_refused", { origin, host });
      await reply
        .code(403)
        .send({ error: "origin_not_allowed", message: "This page may not change connections." });
    },
  };

  app.get("/api/connections", async (): Promise<ConnectionsStatus> => status());

  app.put("/api/connections/lichess", writeGuard, async (request, reply) => {
    const body = tokenBody.safeParse(request.body);
    if (!body.success) {
      return refuse(reply, "connections.lichess_refused", TOKEN_REFUSALS.malformed);
    }
    const refusal = await tokenRefusal(explorerFor(body.data.token));
    if (refusal) return refuse(reply, "connections.lichess_refused", refusal);
    setLichessToken(db, body.data.token, now());
    log.info("connections.lichess_saved");
    return status();
  });

  app.delete("/api/connections/lichess", writeGuard, async (): Promise<ConnectionsStatus> => {
    clearLichessToken(db);
    log.info("connections.lichess_removed");
    return status();
  });

  app.put("/api/connections/chesscom", writeGuard, async (request, reply) => {
    const body = usernameBody.safeParse(request.body);
    const username = body.success ? normalisedUsername(body.data.username) : null;
    if (username === null) {
      return refuse(reply, "connections.chesscom_refused", ACCOUNT_REFUSALS.malformed);
    }
    const refusal = await accountRefusal(chessCom, username);
    if (refusal) return refuse(reply, "connections.chesscom_refused", refusal);
    setChessComUsername(db, username, now());
    log.info("connections.chesscom_saved", { username });
    return status();
  });

  app.delete("/api/connections/chesscom", writeGuard, async (): Promise<ConnectionsStatus> => {
    clearChessComUsername(db);
    log.info("connections.chesscom_removed");
    return status();
  });
}
