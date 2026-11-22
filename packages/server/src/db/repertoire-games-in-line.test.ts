import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importFinishedGame } from "../import/pgn.js";
import { type Database, openDatabase } from "./open.js";
import {
  countRepertoireGamesInLine,
  createRepertoireVariation,
  findRepertoireAnswerAfter,
  insertRepertoireOwnMove,
} from "./repertoires.js";

const OUTCOMES = [
  "in_book",
  "departed",
  "reply_added",
  "reply_not_stored",
  "not_reached",
  "other_side",
] as const;
type Outcome = (typeof OUTCOMES)[number];

let tmp: string;
let db: Database;
let gameCount = 0;

beforeEach(() => {
  gameCount = 0;
  tmp = mkdtempSync(join(tmpdir(), "cc-games-in-line-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const variation = (name: string): number =>
  createRepertoireVariation(db, { side: "white", groupName: "Italian Game", variationName: name })
    .id;

// Only the outcome and the variation matter to the count, so the game is the shortest one that
// imports and the review row carries nothing else.
function addReview(repertoireId: number, outcome: Outcome, practice = false): void {
  gameCount += 1;
  const gameId = importFinishedGame(db, {
    pgn: '[Result "1-0"]\n\n1. e4 e5 1-0',
    playerColor: "white",
    source: "pgn",
    sourceId: `in-line-${gameCount}`,
    practice,
  }) as number;
  db.prepare(
    `INSERT INTO repertoire_game_reviews
       (game_id, repertoire_id, reviewed_at, outcome, followed_plies, passed_moves)
     VALUES (?, ?, '2026-11-15T12:00:00.000Z', ?, 0, 0)`,
  ).run(gameId, repertoireId, outcome);
}

describe("the games reviewed against a variation that stayed in its line", () => {
  it("counts a game that followed the line, added a reply or found none to add as staying, and a departure as leaving", () => {
    const id = variation("Classical");
    for (const outcome of OUTCOMES) addReview(id, outcome);

    expect(countRepertoireGamesInLine(db, id)).toEqual({ stayed: 3, of: 4 });
  });

  it("counts each outcome on its own side of the line", () => {
    const stays = variation("Stays");
    const leaves = variation("Leaves");
    for (const outcome of ["in_book", "reply_added", "reply_not_stored"] as const) {
      addReview(stays, outcome);
    }
    addReview(leaves, "departed");

    expect(countRepertoireGamesInLine(db, stays)).toEqual({ stayed: 3, of: 3 });
    expect(countRepertoireGamesInLine(db, leaves)).toEqual({ stayed: 0, of: 1 });
  });

  it("changes no count for a game that never reached the line or was played as the other colour", () => {
    const id = variation("Classical");
    addReview(id, "in_book");
    addReview(id, "departed");
    const before = countRepertoireGamesInLine(db, id);

    addReview(id, "not_reached");
    addReview(id, "other_side");

    expect(countRepertoireGamesInLine(db, id)).toEqual(before);
    expect(before).toEqual({ stayed: 1, of: 2 });
  });

  it("counts a variation by its own reviews, not by the group's", () => {
    const first = variation("Classical");
    const second = variation("Pianissimo");
    addReview(first, "in_book");
    addReview(second, "departed");
    addReview(second, "departed");

    expect(countRepertoireGamesInLine(db, first)).toEqual({ stayed: 1, of: 1 });
    expect(countRepertoireGamesInLine(db, second)).toEqual({ stayed: 0, of: 2 });
  });

  it("is 0 of 0 for a variation no game was reviewed against", () => {
    expect(countRepertoireGamesInLine(db, variation("Classical"))).toEqual({ stayed: 0, of: 0 });
  });

  it("leaves practice games out of both counts while keeping regular games", () => {
    const id = variation("Classical");
    addReview(id, "in_book", false);
    addReview(id, "in_book", true);
    addReview(id, "departed", true);

    expect(countRepertoireGamesInLine(db, id)).toEqual({ stayed: 1, of: 1 });
  });
});

describe("the White move a variation stores right after a line", () => {
  const MOVE = {
    positionKey: "",
    reach: 1,
    openingName: null,
    share: null,
    source: "explorer" as const,
    cpLoss: 0,
    evalCp: 0,
    results: null,
  };

  function storeAnswer(repertoireId: number, line: string[], san: string, uci: string): void {
    insertRepertoireOwnMove(db, {
      ...MOVE,
      repertoireId,
      positionKey: `after ${line.join(" ")}`,
      ply: line.length + 1,
      line,
      san,
      uci,
    });
  }

  it("finds the answer by the line it follows, among the answers at the same ply", () => {
    const id = variation("Classical");
    storeAnswer(id, ["e4", "e5"], "Nf3", "g1f3");
    storeAnswer(id, ["e4", "c5"], "Nf3", "g1f3");
    storeAnswer(id, ["e4", "e6"], "d4", "d2d4");

    expect(findRepertoireAnswerAfter(db, id, ["e4", "e6"])).toBe("d4");
    expect(findRepertoireAnswerAfter(db, id, ["e4", "e5"])).toBe("Nf3");
  });

  it("finds nothing where the variation stores no answer, or stores it under another variation", () => {
    const id = variation("Classical");
    const other = variation("Pianissimo");
    storeAnswer(other, ["e4", "e5"], "Nf3", "g1f3");

    expect(findRepertoireAnswerAfter(db, id, ["e4", "e5"])).toBeUndefined();
    expect(findRepertoireAnswerAfter(db, other, ["e4", "e5", "Nf3"])).toBeUndefined();
  });
});
