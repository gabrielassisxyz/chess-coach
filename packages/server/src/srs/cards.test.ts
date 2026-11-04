import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertGradedGame, STUDENT_CP_LOSSES } from "../../test/fixture-game.js";
import type { Clock } from "../clock.js";
import { listMoves, removeLastPlies } from "../db/games.js";
import { type Database, openDatabase } from "../db/open.js";
import { listCardsNewestFirst } from "../db/srs.js";
import { createCardsFromGame } from "./cards.js";

let tmp: string;
let db: Database;
const clock: Clock = { now: () => new Date("2026-02-01T12:00:00.000Z") };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-srs-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("createCardsFromGame", () => {
  it("makes a card for each student move at 81 centipawns or worse", () => {
    expect(STUDENT_CP_LOSSES).toEqual([0, 45, 80, 81, 150, 420]);
    const gameId = insertGradedGame(db);
    expect(createCardsFromGame(db, gameId, clock)).toEqual({ created: 3, skipped: 0 });
    const cards = listCardsNewestFirst(db, 10).sort((a, b) => a.id - b.id);
    expect(cards.map((card) => card.cpLoss)).toEqual([81, 150, 420]);
    expect(cards[0]).toMatchObject({
      sourceKind: "game_move",
      sourceGameId: gameId,
      studentColor: "white",
      playedUci: "e2e4",
      expectedUci: "d2d4",
      explanation: null,
      classification: "inaccuracy",
      intervalHours: 0,
      easeFactor: 2.5,
      repetitions: 0,
      createdAt: "2026-02-01T12:00:00.000Z",
      nextReviewAt: "2026-02-01T12:00:00.000Z",
    });
  });

  it("creates nothing the second time and reports the three as skipped", () => {
    const gameId = insertGradedGame(db);
    createCardsFromGame(db, gameId, clock);
    expect(createCardsFromGame(db, gameId, clock)).toEqual({ created: 0, skipped: 3 });
    expect(listCardsNewestFirst(db, 10)).toHaveLength(3);
  });

  it("refuses a game that is still being played", () => {
    const gameId = insertGradedGame(db, false);
    expect(() => createCardsFromGame(db, gameId, clock)).toThrow(
      expect.objectContaining({ code: "game_not_finished" }),
    );
  });

  it("refuses a game that does not exist", () => {
    expect(() => createCardsFromGame(db, 999, clock)).toThrow(
      expect.objectContaining({ code: "game_not_found" }),
    );
  });
});

describe("a card whose move was undone", () => {
  it("stays, with its move reference cleared", () => {
    const gameId = insertGradedGame(db, false);
    // An undo only ever happens in a live game, so the card is made the way a teaching
    // flow would: straight from the move row, with the game still unfinished.
    const moves = listMoves(db, gameId);
    const last = moves.filter((move) => move.isPlayer).at(-1);
    if (!last) throw new Error("fixture has no student move");
    db.prepare(
      `INSERT INTO srs_cards (source_kind, source_game_id, source_move_id, prompt_fen, student_color,
         expected_uci, created_at, next_review_at)
       VALUES ('game_move', ?, ?, 'f', 'white', 'd2d4', 't', 't')`,
    ).run(gameId, last.id);
    removeLastPlies(db, gameId, 2, "");
    const [card] = listCardsNewestFirst(db, 10);
    expect(card).toMatchObject({ sourceMoveId: null });
  });
});
