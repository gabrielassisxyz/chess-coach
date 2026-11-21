import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepertoiresResponseSchema } from "@chess-coach/shared";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { type Database, openDatabase } from "../db/open.js";
import {
  createRepertoireVariation,
  insertRepertoireOwnMove,
  type RepertoireSide,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { positionKey } from "../openings/from-games.js";

// The route reads the system clock, so a card is due or not by a wide margin either way.
const LONG_AGO = "2000-01-01T00:00:00.000Z";
const FAR_AHEAD = "2999-01-01T00:00:00.000Z";

// A White unit that starts 1.d4, three moves of White's, and a Black unit that answers two first moves
// of White's, four moves of Black's.
const LONDON_LINE = ["d4", "d5", "Bf4", "Nf6", "e3"];
const BLACK_LINES = [
  ["e4", "c6", "d4", "d5"],
  ["d4", "d5", "c4", "c6"],
];

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-repertoire-sides-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function placeOf(line: string[], san: string): { positionKey: string; uci: string } {
  const board = new Chess();
  for (const played of line) board.move(played);
  const key = positionKey(board.fen());
  const move = board.move(san);
  return { positionKey: key, uci: `${move.from}${move.to}${move.promotion ?? ""}` };
}

// The student's move sits where the line before it ends on the opponent's: at an even length for
// White and an odd one for Black, whose first move answers White's.
function addUnit(
  side: RepertoireSide,
  groupName: string,
  variationName: string,
  lines: string[][],
): number {
  const { id } = createRepertoireVariation(db, { side, groupName, variationName });
  for (const sans of lines) {
    sans.forEach((san, index) => {
      const line = sans.slice(0, index);
      const row = {
        repertoireId: id,
        ...placeOf(line, san),
        ply: index + 1,
        line,
        reach: 1,
        openingName: null,
        san,
        share: null,
        source: "explorer" as const,
      };
      if ((index % 2 === 0) !== (side === "white")) upsertRepertoireReply(db, row);
      else if (!ownMoveStored(id, row.positionKey)) {
        insertRepertoireOwnMove(db, { ...row, cpLoss: 0, evalCp: 25, results: null });
      }
    });
  }
  return id;
}

const ownMoveStored = (repertoireId: number, key: string): boolean =>
  db
    .prepare(
      "SELECT 1 FROM repertoire_positions WHERE repertoire_id = ? AND position_key = ? AND kind = 'own'",
    )
    .get(repertoireId, key) !== undefined;

const ownMoveCount = (repertoireId: number): number =>
  (
    db
      .prepare(
        "SELECT COUNT(*) AS own FROM repertoire_positions WHERE repertoire_id = ? AND kind = 'own'",
      )
      .get(repertoireId) as { own: number }
  ).own;

function addCard(line: string[], san: string, nextReviewAt: string): void {
  const place = placeOf(line, san);
  db.prepare(
    `INSERT INTO repertoire_cards (position_key, move_uci, introduced_at, next_review_at,
       interval_hours)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(place.positionKey, place.uci, LONG_AGO, nextReviewAt);
}

async function getRepertoires() {
  const app = buildApp({ db });
  const response = await app.inject({ method: "GET", url: "/api/repertoires" });
  await app.close();
  return RepertoiresResponseSchema.parse(response.json());
}

// White's unit has no card, so only 1.d4 is new and may enter. Black's has a card on each of its four
// moves, one of them not due, so its counts differ from White's in all three figures.
function addBothSides(): { white: number; black: number } {
  const white = addUnit("white", "London System", "London System (2.Bf4)", [LONDON_LINE]);
  const black = addUnit("black", "Black repertoire", "Caro-Kann and Slav", BLACK_LINES);
  addCard(["e4"], "c6", LONG_AGO);
  addCard(["e4", "c6", "d4"], "d5", LONG_AGO);
  addCard(["d4"], "d5", LONG_AGO);
  addCard(["d4", "d5", "c4"], "c6", FAR_AHEAD);
  return { white, black };
}

describe("GET /api/repertoires with a White and a Black unit", () => {
  it("lists a side for each colour with its own recommended, due and all counts", async () => {
    addBothSides();

    const body = await getRepertoires();

    expect(body.sides).toHaveLength(2);
    expect(body.sides?.find((entry) => entry.side === "white")).toEqual({
      side: "white",
      moves: { recommended: 1, due: 1, all: 1 },
    });
    expect(body.sides?.find((entry) => entry.side === "black")).toEqual({
      side: "black",
      moves: { recommended: 3, due: 3, all: 4 },
    });
  });

  it("gives each unit and each opening the side and the counts of its own moves", async () => {
    const { white, black } = addBothSides();

    const body = await getRepertoires();

    expect(body.repertoires.find((entry) => entry.id === white)).toMatchObject({
      side: "white",
      group_name: "London System",
      moves: { recommended: 1, due: 1, all: 1 },
    });
    expect(body.repertoires.find((entry) => entry.id === black)).toMatchObject({
      side: "black",
      group_name: "Black repertoire",
      variation_name: "Caro-Kann and Slav",
      moves: { recommended: 3, due: 3, all: 4 },
    });
    expect(body.groups?.find((entry) => entry.side === "black")).toMatchObject({
      group_name: "Black repertoire",
      moves: { recommended: 3, due: 3, all: 4 },
    });
    expect(body.groups?.find((entry) => entry.side === "white")).toMatchObject({
      group_name: "London System",
      moves: { recommended: 1, due: 1, all: 1 },
    });
  });

  it("counts a Black unit's moves_total as its rows of kind own, and a White unit's as its own", async () => {
    const { white, black } = addBothSides();

    const body = await getRepertoires();

    // Black's replies are White's moves and are no part of the count, so four of eight rows.
    expect(ownMoveCount(black)).toBe(4);
    expect(body.repertoires.find((entry) => entry.id === black)?.moves_total).toBe(4);
    expect(body.groups?.find((entry) => entry.side === "black")?.moves_total).toBe(4);
    expect(ownMoveCount(white)).toBe(3);
    expect(body.repertoires.find((entry) => entry.id === white)?.moves_total).toBe(3);
    expect(body.groups?.find((entry) => entry.side === "white")?.moves_total).toBe(3);
  });

  it("lists only the colour that holds a unit when the other holds none", async () => {
    addUnit("black", "Black repertoire", "Caro-Kann and Slav", BLACK_LINES);

    const body = await getRepertoires();

    expect(body.sides?.map((entry) => entry.side)).toEqual(["black"]);
    expect(body.groups?.map((entry) => entry.side)).toEqual(["black"]);
  });
});
