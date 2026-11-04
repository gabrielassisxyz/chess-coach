import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGame, finishGame, getGame, listMoves, recordPlayerMove } from "./games.js";
import { type Database, openDatabase } from "./open.js";

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-games-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const newGame = () =>
  createGame(db, {
    playerColor: "white",
    targetElo: 1500,
    initialFen: "start",
    phase: "player_turn",
    startedAt: "2026-01-01T00:00:00.000Z",
  });

const move = (ply: number) => ({
  ply,
  san: "e4",
  uci: "e2e4",
  fenBefore: "a",
  fenAfter: "b",
  isPlayer: true,
});

describe("games schema", () => {
  it("rejects a second unfinished game in SQLite itself", () => {
    newGame();
    expect(() => newGame()).toThrow(/UNIQUE/);
  });

  it("accepts a new game once the previous one is finished", () => {
    const first = newGame();
    finishGame(db, first.id, { result: null, termination: "abort", finishedAt: "t" }, "");
    expect(() => newGame()).not.toThrow();
  });

  it("rejects a duplicate ply for one game", () => {
    const game = newGame();
    recordPlayerMove(db, game.id, move(1), "");
    expect(() => recordPlayerMove(db, game.id, move(1), "")).toThrow(/UNIQUE/);
  });

  it("rejects values outside the column checks", () => {
    expect(() =>
      createGame(db, {
        playerColor: "white",
        targetElo: 50,
        initialFen: "start",
        phase: "player_turn",
        startedAt: "t",
      }),
    ).toThrow(/CHECK/);
  });

  it("cascades the moves when a game row is deleted", () => {
    const game = newGame();
    recordPlayerMove(db, game.id, move(1), "");
    db.prepare("DELETE FROM games WHERE id = ?").run(game.id);
    expect(listMoves(db, game.id)).toEqual([]);
  });

  it("refuses to write to a finished game and rolls the whole transaction back", () => {
    const game = newGame();
    finishGame(db, game.id, { result: null, termination: "abort", finishedAt: "t" }, "p");
    expect(() => recordPlayerMove(db, game.id, move(1), "later")).toThrow(/finished/);
    expect(listMoves(db, game.id)).toEqual([]);
    expect(getGame(db, game.id)?.pgn).toBe("p");
  });
});
