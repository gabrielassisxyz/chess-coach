import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeChessCom } from "../../test/fakes/fake-chesscom.js";
import { FakeClock, FakeExplorer } from "../../test/fakes/fake-explorer.js";
import { buildApp } from "../app.js";
import { resolveLichessToken } from "../db/connections.js";
import { type Database, openDatabase } from "../db/open.js";
import { ChessComError } from "../import/chesscom.js";
import { RecordingLog } from "../log.js";
import {
  ExplorerError,
  type ExplorerFetcher,
  httpExplorerFetcher,
} from "../openings/explorer-client.js";
import { DEFAULT_ALLOWED_ORIGINS } from "../ws/origin.js";

const TOKEN = "lip_secretValue123";

let tmp: string;
let db: Database;
let log: RecordingLog;
let chessCom: FakeChessCom;
let explorerFailure: Error | null;
let tried: string[];
let app: FastifyInstance;

function explorerFor(token: string): ExplorerFetcher {
  tried.push(token);
  const fake = new FakeExplorer(new FakeClock());
  return {
    fetch: async (fen) => {
      if (explorerFailure) throw explorerFailure;
      return fake.fetch(fen);
    },
  };
}

const startApp = (): FastifyInstance =>
  buildApp({
    db,
    log,
    connections: { chessCom, explorerFor, allowedOrigins: DEFAULT_ALLOWED_ORIGINS },
  });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-connections-"));
  db = openDatabase(tmp);
  log = new RecordingLog();
  chessCom = new FakeChessCom();
  explorerFailure = null;
  tried = [];
  app = startApp();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const status = () => app.inject({ method: "GET", url: "/api/connections" });
const LOCAL_PAGE = { origin: "http://localhost:5173", host: "localhost:5173" };
const saveToken = (token: unknown, headers: Record<string, string> = LOCAL_PAGE) =>
  app.inject({ method: "PUT", url: "/api/connections/lichess", payload: { token }, headers });
const saveAccount = (username: unknown, headers: Record<string, string> = LOCAL_PAGE) =>
  app.inject({ method: "PUT", url: "/api/connections/chesscom", payload: { username }, headers });
const remove = (kind: "lichess" | "chesscom", headers: Record<string, string> = LOCAL_PAGE) =>
  app.inject({ method: "DELETE", url: `/api/connections/${kind}`, headers });
const settingRows = (): number =>
  (
    db
      .prepare(
        "SELECT count(*) AS n FROM settings WHERE key IN ('lichess_api_token', 'chesscom_username')",
      )
      .get() as { n: number }
  ).n;

describe("the Lichess token", () => {
  it("is never returned once saved", async () => {
    const saved = await saveToken(TOKEN);
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(TOKEN);
    const read = await status();
    expect(read.json()).toEqual({ lichess_token_set: true, chesscom_username: null });
    expect(read.body).not.toContain(TOKEN);
  });

  it("reaches the explorer in the Authorization header with no environment variable", async () => {
    await saveToken(TOKEN);
    const token = resolveLichessToken(db, {});
    let authorization: unknown;
    const fetcher = httpExplorerFetcher(token, (async (_url: string, init: RequestInit) => {
      authorization = (init.headers as Record<string, string>).Authorization;
      return new Response("{}");
    }) as typeof fetch);
    await fetcher.fetch("8/8/8/8/8/8/8/8 w - - 0 1");
    expect(authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("gives way to a set LICHESS_API_TOKEN", async () => {
    await saveToken(TOKEN);
    expect(resolveLichessToken(db, { LICHESS_API_TOKEN: "lip_fromEnv" })).toBe("lip_fromEnv");
    expect(resolveLichessToken(db, { LICHESS_API_TOKEN: "" })).toBe(TOKEN);
  });

  it("is tried once against the explorer before being stored", async () => {
    await saveToken(TOKEN);
    expect(tried).toEqual([TOKEN]);
  });

  it("refuses a token the explorer rejects and stores nothing", async () => {
    explorerFailure = new ExplorerError("unauthorized", "no");
    const answer = await saveToken(TOKEN);
    expect(answer.statusCode).toBe(400);
    expect(answer.json().error).toBe("lichess_token_rejected");
    expect(settingRows()).toBe(0);
  });

  it("refuses when Lichess cannot be reached and stores nothing", async () => {
    explorerFailure = new ExplorerError("upstream", "down");
    const answer = await saveToken(TOKEN);
    expect(answer.statusCode).toBe(502);
    expect(answer.json().error).toBe("lichess_unreachable");
    expect(settingRows()).toBe(0);
  });

  // A control character would otherwise reach the Authorization header, and the fetch error that
  // refuses it quotes the header value.
  it.each(["", "with space", "line\nbreak", "a".repeat(201), 7])(
    "refuses the malformed token %j without calling Lichess",
    async (token) => {
      const answer = await saveToken(token);
      expect(answer.statusCode).toBe(400);
      expect(answer.json().error).toBe("invalid_token");
      expect(tried).toEqual([]);
      expect(settingRows()).toBe(0);
    },
  );

  it("is removed, and the next explorer request carries no token", async () => {
    await saveToken(TOKEN);
    const removed = await remove("lichess");
    expect(removed.json().lichess_token_set).toBe(false);
    expect(settingRows()).toBe(0);
    let headers: Record<string, string> = {};
    const fetcher = httpExplorerFetcher(resolveLichessToken(db, {}), (async (
      _url: string,
      init: RequestInit,
    ) => {
      headers = init.headers as Record<string, string>;
      return new Response("{}");
    }) as typeof fetch);
    await fetcher.fetch("8/8/8/8/8/8/8/8 w - - 0 1");
    expect(headers.Accept).toBe("application/json");
    expect(headers.Authorization).toBeUndefined();
  });

  it("never reaches a log, a response or an error, on any path", async () => {
    await saveToken(TOKEN);
    explorerFailure = new ExplorerError("unauthorized", `rejected ${TOKEN}`);
    const rejected = await saveToken(TOKEN);
    explorerFailure = new ExplorerError("upstream", `failed with ${TOKEN}`);
    const unreachable = await saveToken(TOKEN);
    await saveToken(`${TOKEN}\n`);
    await status();
    expect(log.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(log.events)).not.toContain(TOKEN);
    expect(rejected.body).not.toContain(TOKEN);
    expect(unreachable.body).not.toContain(TOKEN);
  });
});

describe("the Chess.com account", () => {
  it("is stored lowercased once the profile exists", async () => {
    const saved = await saveAccount("SomeOne_1");
    expect(saved.statusCode).toBe(200);
    expect(saved.json().chesscom_username).toBe("someone_1");
    expect(chessCom.profilesAsked).toEqual(["someone_1"]);
  });

  it("refuses an invalid name without asking Chess.com", async () => {
    const answer = await saveAccount("a/b");
    expect(answer.statusCode).toBe(400);
    expect(answer.json().error).toBe("invalid_username");
    expect(chessCom.profilesAsked).toEqual([]);
    expect(settingRows()).toBe(0);
  });

  it("refuses an account that does not exist", async () => {
    chessCom.missingPlayers.add("nobody_here");
    const answer = await saveAccount("nobody_here");
    expect(answer.statusCode).toBe(404);
    expect(answer.json().error).toBe("chesscom_user_not_found");
    expect(settingRows()).toBe(0);
  });

  it("refuses when Chess.com cannot answer", async () => {
    chessCom.failWith = new ChessComError("upstream", "Chess.com answered 429");
    const answer = await saveAccount("someone");
    expect(answer.statusCode).toBe(502);
    expect(answer.json().error).toBe("chesscom_unreachable");
    expect(settingRows()).toBe(0);
  });

  it("is removed", async () => {
    await saveAccount("someone");
    const removed = await remove("chesscom");
    expect(removed.json().chesscom_username).toBeNull();
    expect(settingRows()).toBe(0);
  });
});

describe("both connections", () => {
  // A rebinding page is same-origin to itself, so its Host and Origin agree; only the list stops it.
  const REBOUND = { origin: "http://evil.example:3210", host: "evil.example:3210" };
  const FOREIGN_ORIGIN = { origin: "http://evil.example", host: "localhost:5173" };
  const FOREIGN_HOST = { origin: "http://localhost:5173", host: "evil.example:3210" };

  it.each([
    ["a rebinding page", REBOUND],
    ["a foreign origin", FOREIGN_ORIGIN],
    ["a foreign host", FOREIGN_HOST],
    ["no origin", { host: "localhost:5173" }],
  ])("refuses every write from %s", async (_label, headers) => {
    expect((await saveToken(TOKEN, headers)).statusCode).toBe(403);
    expect((await saveAccount("someone", headers)).statusCode).toBe(403);
    expect(settingRows()).toBe(0);
    await saveToken(TOKEN);
    await saveAccount("someone");
    expect((await remove("lichess", headers)).statusCode).toBe(403);
    expect((await remove("chesscom", headers)).statusCode).toBe(403);
    expect(settingRows()).toBe(2);
    expect(tried).toEqual([TOKEN]);
  });

  it("survive a restart", async () => {
    await saveToken(TOKEN);
    await saveAccount("someone");
    await app.close();
    db.close();
    db = openDatabase(tmp);
    app = startApp();
    expect((await status()).json()).toEqual({
      lichess_token_set: true,
      chesscom_username: "someone",
    });
    expect(resolveLichessToken(db, {})).toBe(TOKEN);
  });
});
