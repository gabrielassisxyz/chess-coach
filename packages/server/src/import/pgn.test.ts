import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGame, listMoves } from "../db/games.js";
import { type Database, openDatabase } from "../db/open.js";
import {
  colorFromHeaders,
  importFinishedGame,
  MAX_PGN_BYTES,
  PgnImportError,
  parseFinishedGame,
} from "./pgn.js";

const FIXTURE = readFileSync(
  new URL("../../test/fixtures/chesscom_2026-10-28.pgn", import.meta.url),
  "utf8",
);
const NOW = () => new Date("2026-11-01T00:00:00.000Z");

let tmp: string;
let db: Database;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-import-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("importFinishedGame", () => {
  it("stores the fixture game as finished, ungraded, with one row per ply", () => {
    const id = importFinishedGame(db, {
      pgn: FIXTURE,
      playerColor: "white",
      source: "pgn",
      now: NOW,
    });
    expect(id).not.toBeNull();
    const game = getGame(db, id as number);
    expect(game).toMatchObject({
      phase: "finished",
      result: "1-0",
      termination: "checkmate",
      grading: "pending",
      source: "pgn",
      playerColor: "white",
    });
    const moves = listMoves(db, id as number);
    expect(moves).toHaveLength(59);
    expect(moves[0]).toMatchObject({ ply: 1, san: "e4", uci: "e2e4", isPlayer: true });
    expect(moves[1]).toMatchObject({ san: "e5", isPlayer: false });
    expect(moves.filter((move) => move.isPlayer)).toHaveLength(30);
    expect(moves.every((move) => move.cpLoss === null && move.classification === null)).toBe(true);
    expect(moves[58]).toMatchObject({ san: "Qxa7#", uci: "a6a7", isPlayer: true });
  });

  it("creates nothing the second time", () => {
    const request = {
      pgn: FIXTURE,
      playerColor: "white" as const,
      source: "pgn" as const,
      now: NOW,
    };
    importFinishedGame(db, request);
    expect(importFinishedGame(db, request)).toBeNull();
    const count = db.prepare("SELECT COUNT(*) AS n FROM games").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("marks the student's plies by colour", () => {
    const id = importFinishedGame(db, {
      pgn: FIXTURE,
      playerColor: "black",
      source: "pgn",
      now: NOW,
    });
    const first = listMoves(db, id as number)[0];
    expect(first?.isPlayer).toBe(false);
  });

  it("keeps the source details and uses the end time for the dates", () => {
    const id = importFinishedGame(db, {
      pgn: FIXTURE,
      playerColor: "white",
      source: "chesscom",
      sourceId: "abc",
      sourceUrl: "https://www.chess.com/game/live/1",
      opponent: "Dibitard49",
      studentRating: 400,
      opponentRating: 410,
      timeControl: "600",
      playedAt: "2026-10-28T12:00:00.000Z",
    });
    expect(getGame(db, id as number)).toMatchObject({
      sourceId: "abc",
      sourceUrl: "https://www.chess.com/game/live/1",
      opponent: "Dibitard49",
      studentRating: 400,
      opponentRating: 410,
      timeControl: "600",
      playedAt: "2026-10-28T12:00:00.000Z",
      finishedAt: "2026-10-28T12:00:00.000Z",
      targetElo: 400,
    });
  });

  it("stores a Lichess game under its own source, with the Lichess id as the dedupe key", () => {
    const request = {
      pgn: FIXTURE,
      playerColor: "white" as const,
      source: "lichess" as const,
      sourceId: "Wm4cTe9R",
      sourceUrl: "https://lichess.org/Wm4cTe9R",
      opponent: "fixture-rival",
      studentRating: 1538,
      opponentRating: 1612,
      timeControl: "300+3",
      playedAt: "2026-10-21T12:03:40.000Z",
    };
    const id = importFinishedGame(db, request);
    expect(getGame(db, id as number)).toMatchObject({
      source: "lichess",
      sourceId: "Wm4cTe9R",
      sourceUrl: "https://lichess.org/Wm4cTe9R",
      studentRating: 1538,
      opponentRating: 1612,
      timeControl: "300+3",
      targetElo: 1538,
      grading: "pending",
    });
    expect(importFinishedGame(db, request)).toBeNull();
  });
});

describe("parseFinishedGame", () => {
  const parse = (pgn: string) =>
    parseFinishedGame({ pgn, playerColor: "white", source: "pgn", now: NOW });

  it("rejects text that is not a game with the parser's message", () => {
    expect(() => parse("1. e4 e5 2. Ke4 1-0")).toThrow(PgnImportError);
    expect(() => parse("1. e4 e5 2. Ke4 1-0")).toThrow(/Invalid move|Ke4/);
  });

  it("rejects a PGN without moves", () => {
    expect(() => parse('[Result "1-0"]\n\n1-0')).toThrow(/no moves/);
  });

  it("rejects a game that has no result yet", () => {
    expect(() => parse("1. e4 e5 *")).toThrow(/no result/);
  });

  it("rejects a PGN over the size cap before parsing it", () => {
    expect(() => parse("x".repeat(MAX_PGN_BYTES + 1))).toThrow(/larger than/);
  });

  it("reads a loss on time as a resignation and an abandonment as an abort", () => {
    const body = '[Result "0-1"]\n[Termination "x"]\n\n1. e4 e5 0-1';
    expect(parse(body).finish.termination).toBe("resign");
    expect(parse(body.replace('"x"', '"y abandoned"')).finish.termination).toBe("abort");
  });

  it("reads the date from the UTC headers", () => {
    const body =
      '[Result "1/2-1/2"]\n[UTCDate "2026.10.28"]\n[UTCTime "03:04:05"]\n\n1. e4 e5 1/2-1/2';
    const game = parse(body);
    expect(game.playedAt).toBe("2026-10-28T03:04:05.000Z");
    expect(game.finish.termination).toBe("draw");
  });
});

describe("colorFromHeaders", () => {
  it("matches a known username on either side, ignoring case", () => {
    expect(colorFromHeaders(FIXTURE, ["ASSISZZZ"])).toBe("white");
    expect(colorFromHeaders(FIXTURE, ["dibitard49"])).toBe("black");
    expect(colorFromHeaders(FIXTURE, ["nobody"])).toBeNull();
    expect(colorFromHeaders(FIXTURE, [])).toBeNull();
  });
});
