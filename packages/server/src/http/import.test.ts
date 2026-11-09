import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameListResponseSchema } from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChessCom } from "../../test/fakes/fake-chesscom.js";
import { FakeLichess } from "../../test/fakes/fake-lichess.js";
import { buildApp } from "../app.js";
import { setChessComUsername, setLichessToken } from "../db/connections.js";
import { type Database, openDatabase } from "../db/open.js";
import { ChessComError, ChessComSource } from "../import/chesscom.js";
import { ImportGrader } from "../import/grader.js";
import { httpLichessGamesFetcher, LichessError } from "../import/lichess.js";
import { MAX_PGN_BYTES } from "../import/pgn.js";
import { silentLog } from "../log.js";

const FIXTURE_PGN = readFileSync(
  new URL("../../test/fixtures/chesscom_2026-10-28.pgn", import.meta.url),
  "utf8",
);
const LICHESS_EXPORT = readFileSync(
  new URL("../../test/fixtures/lichess/2026-10.ndjson", import.meta.url),
  "utf8",
);
const MONTH_COUNT = 10;
// Finished standard games in the Lichess fixture; its other two are a variant and an aborted game.
const LICHESS_GAME_COUNT = 4;

let tmp: string;
let db: Database;
let fetcher: FakeChessCom;
let lichess: FakeLichess;
let grader: ImportGrader;
let app: FastifyInstance;
let gate: Promise<void> | null = null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-import-http-"));
  db = openDatabase(tmp);
  fetcher = new FakeChessCom();
  lichess = new FakeLichess();
  grader = new ImportGrader({
    db,
    log: silentLog,
    evaluate: async () => {
      await gate;
      return {
        evalBeforeCp: 0,
        evalAfterCp: 0,
        cpLoss: 0,
        classification: "best",
        bestMoveUci: null,
        bestMoveSan: null,
      };
    },
  });
  app = buildApp({
    db,
    importer: { source: new ChessComSource(fetcher), lichess, grader, usernames: ["assiszzz"] },
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  gate = null;
  await grader.idle();
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, payload: payload as object });

describe("a pasted PGN and the saved account", () => {
  beforeEach(async () => {
    await app.close();
    app = buildApp({
      db,
      importer: { source: new ChessComSource(fetcher), grader, usernames: [] },
    });
  });

  it("asks for the colour when no account names a side", async () => {
    const answer = await post("/api/import/pgn", { pgn: FIXTURE_PGN });
    expect(answer.json().error).toBe("student_color_required");
  });

  it("finds the side from the saved account, with no restart", async () => {
    setChessComUsername(db, "assiszzz", "2026-11-09T00:00:00.000Z");
    const answer = await post("/api/import/pgn", { pgn: FIXTURE_PGN });
    expect(answer.statusCode).toBe(200);
    expect(answer.json().imported).toBe(1);
  });
});

const list = (range = { from: "2026-10", to: "2026-10" }) =>
  post("/api/import/chesscom/list", { username: "assiszzz", ...range });

interface Listed {
  uuid: string;
  already_imported: boolean;
  student_color: string;
  opponent: string;
}

describe("POST /api/import/chesscom/list", () => {
  it("lists the recorded month, none imported yet, and fetches only that month", async () => {
    const response = await list();
    expect(response.statusCode).toBe(200);
    const { games } = response.json() as { games: Listed[] };
    expect(games).toHaveLength(MONTH_COUNT);
    expect(games.every((game) => !game.already_imported)).toBe(true);
    expect(fetcher.asked).toEqual(["assiszzz/2026-10"]);
    expect(games.find((game) => game.opponent === "Dibitard49")).toMatchObject({
      student_color: "white",
      result: "1-0",
    });
  });

  it("fetches every month in a range and none outside it", async () => {
    await list({ from: "2026-09", to: "2026-11" });
    expect(fetcher.asked).toEqual(["assiszzz/2026-09", "assiszzz/2026-10", "assiszzz/2026-11"]);
  });

  it("marks the games imported afterwards", async () => {
    const { games } = (await list()).json() as { games: Listed[] };
    await post("/api/import/chesscom", {
      username: "assiszzz",
      uuids: [games[0]?.uuid, games[1]?.uuid],
    });
    const again = ((await list()).json() as { games: Listed[] }).games;
    expect(again.filter((game) => game.already_imported).map((game) => game.uuid)).toEqual([
      games[0]?.uuid,
      games[1]?.uuid,
    ]);
  });

  it.each([
    [{ username: "../x", from: "2026-10", to: "2026-10" }, "invalid_username"],
    [{ username: "assiszzz", from: "2026-10", to: "2026-09" }, "invalid_range"],
    [{ username: "assiszzz", from: "2020-01", to: "2026-10" }, "invalid_range"],
    [{ username: "assiszzz" }, "invalid_body"],
  ])("answers 400 for %j", async (payload, code) => {
    const response = await post("/api/import/chesscom/list", payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: code });
    expect(fetcher.asked).toHaveLength(0);
  });

  it("answers 502 when Chess.com fails", async () => {
    fetcher.failWith = new ChessComError("upstream", "Chess.com answered 503");
    const response = await list();
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: "upstream" });
  });
});

describe("POST /api/import/chesscom", () => {
  it("imports two games, then skips both", async () => {
    const { games } = (await list()).json() as { games: Listed[] };
    const uuids = [games[0]?.uuid, games[1]?.uuid];
    const first = await post("/api/import/chesscom", { username: "assiszzz", uuids });
    expect(first.json()).toEqual({ imported: 2, skipped: 0 });
    const second = await post("/api/import/chesscom", { username: "assiszzz", uuids });
    expect(second.json()).toEqual({ imported: 0, skipped: 2 });
  });

  it("stores the source details and grades the games in the background", async () => {
    const { games } = (await list()).json() as { games: Listed[] };
    await post("/api/import/chesscom", { username: "assiszzz", uuids: [games[0]?.uuid] });
    await grader.idle();
    const stored = (await app.inject({ method: "GET", url: "/api/games" })).json() as {
      games: Record<string, unknown>[];
    };
    expect(stored.games[0]).toMatchObject({
      source: "chesscom",
      opponent: games[0]?.opponent,
      grading: "done",
    });
    expect(stored.games[0]?.source_url).toMatch(/^https:\/\/www\.chess\.com\//);
    expect(typeof stored.games[0]?.student_rating).toBe("number");
  });

  it("asks for a fresh listing when a uuid was never listed", async () => {
    const response = await post("/api/import/chesscom", { username: "assiszzz", uuids: ["nope"] });
    expect(response.statusCode).toBe(409);
  });

  it("rejects an empty or oversized uuid list and a bad username", async () => {
    expect(
      (await post("/api/import/chesscom", { username: "assiszzz", uuids: [] })).statusCode,
    ).toBe(400);
    const many = Array.from({ length: 101 }, (_, index) => String(index));
    expect(
      (await post("/api/import/chesscom", { username: "assiszzz", uuids: many })).statusCode,
    ).toBe(400);
    expect((await post("/api/import/chesscom", { username: "a/b", uuids: ["x"] })).statusCode).toBe(
      400,
    );
  });
});

const importLichess = (
  payload: unknown = { username: "fixture-student", from: "2026-10", to: "2026-10" },
) => post("/api/import/lichess", payload);

describe("POST /api/import/lichess", () => {
  it("imports the finished standard games, then a second run adds none", async () => {
    const first = await importLichess();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ imported: LICHESS_GAME_COUNT, skipped: 0 });
    const second = await importLichess();
    expect(second.json()).toEqual({ imported: 0, skipped: LICHESS_GAME_COUNT });
    expect(db.prepare("SELECT COUNT(*) AS n FROM games").get()).toEqual({ n: LICHESS_GAME_COUNT });
  });

  it("asks Lichess for the lower-cased account and the months given", async () => {
    await importLichess({ username: "Fixture-Student", from: "2026-09", to: "2026-11" });
    expect(lichess.asked).toEqual(["fixture-student/2026-09..2026-11"]);
  });

  it("stores the source details, grades the games and lists them as Lichess games", async () => {
    await importLichess();
    await grader.idle();
    const answer = await app.inject({ method: "GET", url: "/api/games" });
    const { games } = GameListResponseSchema.parse(answer.json());
    expect(games.map((game) => game.source)).toEqual(Array(LICHESS_GAME_COUNT).fill("lichess"));
    expect(games.map((game) => game.grading)).toEqual(Array(LICHESS_GAME_COUNT).fill("done"));
    expect(games[0]).toMatchObject({
      source_url: "https://lichess.org/kP2dQv7x",
      opponent: "Stockfish level 3",
      player_color: "black",
      student_rating: 1544,
      opponent_rating: null,
      time_control: "600+0",
      played_at: "2026-10-28T19:02:11.000Z",
    });
    expect(games[3]).toMatchObject({
      source_url: "https://lichess.org/Hj3uBw2C",
      time_control: "1/259200",
    });
  });

  it("reports a game it cannot read and still imports the rest", async () => {
    const games = (await lichess.games("fixture-student", "2026-10", "2026-10")).map((game) => ({
      ...game,
      players: game.id === "Wm4cTe9R" ? { white: {}, black: {} } : game.players,
    }));
    lichess.serves = games;
    const answer = await importLichess();
    expect(answer.statusCode).toBe(200);
    const body = answer.json() as { imported: number; failed: { id: string; message: string }[] };
    expect(body.imported).toBe(LICHESS_GAME_COUNT - 1);
    expect(body.failed).toEqual([
      { id: "Wm4cTe9R", message: expect.stringMatching(/did not play/) },
    ]);
  });

  it.each([
    [{ username: "a", from: "2026-10", to: "2026-10" }, "invalid_username"],
    [{ username: "../x", from: "2026-10", to: "2026-10" }, "invalid_username"],
    [{ username: "a/b", from: "2026-10", to: "2026-10" }, "invalid_username"],
    [{ username: "a".repeat(31), from: "2026-10", to: "2026-10" }, "invalid_username"],
    [{ username: "fixture-student" }, "invalid_body"],
  ])("answers 400 for %j without calling Lichess", async (payload, code) => {
    const answer = await importLichess(payload);
    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toMatchObject({ error: code });
    expect(lichess.asked).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM games").get()).toEqual({ n: 0 });
  });

  it.each([
    ["2026-10", "2026-09"],
    ["2020-01", "2026-10"],
  ])("answers 400 for the range %s to %s before the real fetcher goes out", async (from, to) => {
    const calls: string[] = [];
    await app.close();
    app = buildApp({
      db,
      importer: {
        source: new ChessComSource(fetcher),
        lichess: httpLichessGamesFetcher(
          () => undefined,
          async (input) => {
            calls.push(String(input));
            return new Response(LICHESS_EXPORT);
          },
        ),
        grader,
        usernames: [],
      },
    });
    const answer = await importLichess({ username: "fixture-student", from, to });
    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toMatchObject({ error: "invalid_range" });
    expect(calls).toEqual([]);
  });

  it.each([
    ["not_found", 404],
    ["rate_limited", 429],
    ["upstream", 502],
  ] as const)("answers %s from Lichess with %i and the reason", async (code, status) => {
    lichess.failWith = new LichessError(code, `Lichess said ${code}`);
    const answer = await importLichess();
    expect(answer.statusCode).toBe(status);
    expect(answer.json()).toEqual({ error: code, message: `Lichess said ${code}` });
  });

  it("waits and asks once more on a 429, then reports it and stores nothing", async () => {
    const waits: number[] = [];
    const calls: string[] = [];
    await app.close();
    app = buildApp({
      db,
      importer: {
        source: new ChessComSource(fetcher),
        lichess: httpLichessGamesFetcher(
          () => undefined,
          async (input) => {
            calls.push(String(input));
            return new Response(null, { status: 429 });
          },
          async (ms) => {
            waits.push(ms);
          },
        ),
        grader,
        usernames: [],
      },
    });
    const answer = await importLichess();
    expect(answer.statusCode).toBe(429);
    expect(answer.json()).toMatchObject({
      error: "rate_limited",
      message: expect.stringMatching(/rate limiting/),
    });
    expect(waits).toEqual([60_000]);
    expect(calls).toHaveLength(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM games").get()).toEqual({ n: 0 });
  });

  it("uses the token saved in Connections, read when the export is asked for", async () => {
    vi.stubEnv("LICHESS_API_TOKEN", "");
    const seen: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).Authorization);
      return new Response(LICHESS_EXPORT);
    });
    await app.close();
    app = buildApp({
      db,
      importer: { source: new ChessComSource(fetcher), grader, usernames: [] },
    });
    await importLichess();
    setLichessToken(db, "lip_saved-later", "2026-11-09T00:00:00.000Z");
    await importLichess();
    expect(seen).toEqual([undefined, "Bearer lip_saved-later"]);
  });
});

describe("POST /api/import/pgn", () => {
  it("imports a pasted PGN, finding the side from the configured username", async () => {
    const response = await post("/api/import/pgn", { pgn: FIXTURE_PGN });
    expect(response.json()).toEqual({ imported: 1, skipped: 0 });
    const row = db.prepare("SELECT player_color, source FROM games").get();
    expect(row).toEqual({ player_color: "white", source: "pgn" });
    expect((await post("/api/import/pgn", { pgn: FIXTURE_PGN })).json()).toEqual({
      imported: 0,
      skipped: 1,
    });
  });

  it("asks for the side when no username matches, and takes it when given", async () => {
    const pgn = FIXTURE_PGN.replace("assiszzz", "someone");
    const missing = await post("/api/import/pgn", { pgn });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "student_color_required" });
    const given = await post("/api/import/pgn", { pgn, student_color: "black" });
    expect(given.json()).toEqual({ imported: 1, skipped: 0 });
  });

  it("answers 400 with the parser's message for a PGN that does not parse", async () => {
    const response = await post("/api/import/pgn", {
      pgn: "1. e4 e5 2. Ke4 1-0",
      student_color: "white",
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; message: string };
    expect(body.error).toBe("invalid_pgn");
    expect(body.message).toMatch(/Ke4/);
  });

  it("rejects a PGN over the size cap", async () => {
    const response = await post("/api/import/pgn", {
      pgn: "x".repeat(MAX_PGN_BYTES + 1),
      student_color: "white",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_body" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM games").get()).toEqual({ n: 0 });
  });
});

describe("GET /api/import/status", () => {
  it("reports the queue before and after grading", async () => {
    expect((await app.inject({ method: "GET", url: "/api/import/status" })).json()).toEqual({
      pending: 0,
      running: null,
      failed: 0,
    });
    let release = (): void => {};
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await post("/api/import/pgn", { pgn: FIXTURE_PGN, student_color: "white" });
    const queued = (await app.inject({ method: "GET", url: "/api/import/status" })).json();
    expect(queued).toMatchObject({
      pending: 0,
      failed: 0,
      running: { graded_plies: 0, total_plies: 30 },
    });
    release();
    await grader.idle();
    expect((await app.inject({ method: "GET", url: "/api/import/status" })).json()).toEqual({
      pending: 0,
      running: null,
      failed: 0,
    });
  });
});
