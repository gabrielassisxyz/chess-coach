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
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { positionKey } from "../openings/from-games.js";

// The route reads the system clock, so a card is due or not by a wide margin either way.
const LONG_AGO = "2000-01-01T00:00:00.000Z";
const FAR_AHEAD = "2999-01-01T00:00:00.000Z";
const SETUP = ["e4", "e5", "Nf3", "Nc6", "Bc4"];

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-repertoire-route-"));
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

// Every line starts with the setup; a White move sits where the line before it has an even length.
function addVariation(name: string, branches: string[][]): number {
  const { id } = createRepertoireVariation(db, {
    side: "white",
    groupName: "Italian Game",
    variationName: name,
  });
  for (const branch of branches) {
    const sans = [...SETUP, ...branch];
    sans.forEach((san, index) => {
      const line = sans.slice(0, index);
      const row = {
        repertoireId: id,
        ...placeOf(line, san),
        ply: index + 1,
        line,
        reach: 1 / (branches.indexOf(branch) + 1),
        openingName: null,
        san,
        share: null,
        source: "explorer" as const,
      };
      if (index % 2 === 1) upsertRepertoireReply(db, row);
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

function addCard(line: string[], san: string, nextReviewAt: string): void {
  const place = placeOf(line, san);
  db.prepare(
    `INSERT INTO repertoire_cards (position_key, move_uci, introduced_at, next_review_at)
     VALUES (?, ?, ?, ?)`,
  ).run(place.positionKey, place.uci, LONG_AGO, nextReviewAt);
}

async function getRepertoires() {
  const app = buildApp({ db });
  const response = await app.inject({ method: "GET", url: "/api/repertoires" });
  await app.close();
  return response;
}

describe("GET /api/repertoires", () => {
  it("returns each repertoire with the moves each scope would serve", async () => {
    const classical = addVariation("Classical Variation (4.c3)", [
      ["Bc5", "c3", "Nf6", "d4"],
      ["Nf6", "d3"],
    ]);
    const wide = addVariation(
      "Wide",
      ["Bc5", "Nf6", "Be7", "d6", "h6", "a6", "g6", "Qe7", "Na5"].map((reply) => [reply, "d3"]),
    );
    // A move both variations play has one card, so it is due, or not, in both at once.
    addCard(["e4", "e5", "Nf3", "Nc6"], "Bc4", FAR_AHEAD);
    addCard([], "e4", LONG_AGO);

    const response = await getRepertoires();
    expect(response.statusCode).toBe(200);
    const body = RepertoiresResponseSchema.parse(response.json());
    expect(body.repertoires).toEqual([
      {
        id: classical,
        side: "white",
        group_name: "Italian Game",
        variation_name: "Classical Variation (4.c3)",
        moves: { recommended: 5, due: 5, all: 6 },
      },
      {
        id: wide,
        side: "white",
        group_name: "Italian Game",
        variation_name: "Wide",
        moves: { recommended: 10, due: 11, all: 12 },
      },
    ]);
  });

  it("answers an empty list before any repertoire is stored", async () => {
    const response = await getRepertoires();
    expect(response.statusCode).toBe(200);
    expect(RepertoiresResponseSchema.parse(response.json())).toEqual({ repertoires: [] });
  });
});
