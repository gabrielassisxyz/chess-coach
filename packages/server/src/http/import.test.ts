import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeChessCom } from "../../test/fakes/fake-chesscom.js";
import { buildApp } from "../app.js";
import { setChessComUsername } from "../db/connections.js";
import { type Database, openDatabase } from "../db/open.js";
import { ChessComError, ChessComSource } from "../import/chesscom.js";
import { ImportGrader } from "../import/grader.js";
import { MAX_PGN_BYTES } from "../import/pgn.js";
import { silentLog } from "../log.js";

const FIXTURE_PGN = readFileSync(
  new URL("../../test/fixtures/chesscom_2026-10-28.pgn", import.meta.url),
  "utf8",
);
const MONTH_COUNT = 10;

let tmp: string;
let db: Database;
let fetcher: FakeChessCom;
let grader: ImportGrader;
let app: FastifyInstance;
let gate: Promise<void> | null = null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-import-http-"));
  db = openDatabase(tmp);
  fetcher = new FakeChessCom();
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
    importer: { source: new ChessComSource(fetcher), grader, usernames: ["assiszzz"] },
  });
});
afterEach(async () => {
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
