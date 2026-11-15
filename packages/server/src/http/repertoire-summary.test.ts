import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepertoireUnitMoves } from "../activity/repertoire-session.js";
import { type Database, openDatabase } from "../db/open.js";
import { listDrillRepertoires, listRepertoireDrillMoves } from "../db/repertoire-cards.js";
import {
  createRepertoireVariation,
  insertRepertoireOwnMove,
  type RepertoireRow,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { positionKey } from "../openings/from-games.js";
import {
  repertoireGroupFigures,
  repertoireGroupLine,
  repertoireVariationFigures,
  repertoireVariationLine,
} from "./repertoire-summary.js";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const SETUP = ["e4", "e5", "Nf3", "Nc6", "Bc4"];
const ITALIAN = "Italian Game";

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-repertoire-summary-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function placeOf(line: readonly string[], san: string): { positionKey: string; uci: string } {
  const board = new Chess();
  for (const played of line) board.move(played);
  const key = positionKey(board.fen());
  const move = board.move(san);
  return { positionKey: key, uci: `${move.from}${move.to}${move.promotion ?? ""}` };
}

// The rows a run leaves for one path of moves: White's as own moves and Black's as replies, the
// first `setupLength` of them marked as the opening's. One path to a variation, so no position is
// stored twice.
function storePath(id: number, path: readonly string[], setupLength: number): void {
  path.forEach((san, index) => {
    const line = path.slice(0, index);
    const row = {
      repertoireId: id,
      ...placeOf(line, san),
      ply: index + 1,
      line,
      reach: 1,
      openingName: null,
      san,
      share: null,
      source: index < setupLength ? ("setup" as const) : ("explorer" as const),
    };
    if (index % 2 === 1) upsertRepertoireReply(db, row);
    else insertRepertoireOwnMove(db, { ...row, cpLoss: 0, evalCp: 25, results: null });
  });
}

function addUnit(groupName: string, name: string, path: readonly string[], setupLength: number) {
  const row = createRepertoireVariation(db, { side: "white", groupName, variationName: name });
  storePath(row.id, path, setupLength);
  return row;
}

const unitMovesOf = (row: RepertoireRow): RepertoireUnitMoves => ({
  variation: row,
  moves: listRepertoireDrillMoves(db, row.id),
});

describe("the line that tells a variation from the others of its group", () => {
  it("is the naming reply and White's answer for the first Italian variation", () => {
    const first = addUnit(ITALIAN, "Giuoco Pianissimo (4.d3)", [...SETUP, "Bc5", "d3"], 5);
    expect(repertoireVariationLine(db, first, null, true)).toBe("3...Bc5 4.d3");
  });

  it("is the rest of the branch for a variation built at a branch point", () => {
    const branched = addUnit(ITALIAN, "Two Knights Defense (4.Ng5)", [...SETUP, "Nf6", "Ng5"], 5);
    expect(repertoireVariationLine(db, branched, [...SETUP, "Nf6", "Ng5"], false)).toBe(
      "3...Nf6 4.Ng5",
    );
  });

  it("numbers a longer branch from its first move after the setup", () => {
    const branch = [...SETUP, "Bc5", "c3", "Nf6", "d4"];
    const branched = addUnit(ITALIAN, "Classical Variation (5.d4)", branch, 5);
    expect(repertoireVariationLine(db, branched, branch, false)).toBe("3...Bc5 4.c3 Nf6 5.d4");
  });

  it("tells a branch from the first variation by the branch when both could apply", () => {
    const branch = [...SETUP, "Nf6", "Ng5"];
    const branched = addUnit(ITALIAN, "Two Knights Defense (4.Ng5)", branch, 5);
    expect(repertoireVariationLine(db, branched, branch, true)).toBe("3...Nf6 4.Ng5");
  });

  it("is White's answer after the root for a unit of another opening", () => {
    const scandinavian = addUnit(
      "Scandinavian Defense",
      "Mieses-Kotroc (2.exd5)",
      ["e4", "d5", "exd5"],
      2,
    );
    expect(repertoireVariationLine(db, scandinavian, null, true)).toBe("2.exd5");
  });

  it("counts White's answer from the ply after a longer root", () => {
    const philidor = addUnit(
      "Philidor Defense",
      "Philidor (3.d4)",
      ["e4", "e5", "Nf3", "d6", "d4"],
      4,
    );
    expect(repertoireVariationLine(db, philidor, null, true)).toBe("3.d4");
  });

  it("is null for a variation that is neither the first of its group nor built at a branch point", () => {
    addUnit(ITALIAN, "Giuoco Pianissimo (4.d3)", [...SETUP, "Bc5", "d3"], 5);
    const later = addUnit(ITALIAN, "Classical Variation (4.c3)", [...SETUP, "Bc5", "c3"], 5);
    expect(repertoireVariationLine(db, later, null, false)).toBeNull();
  });

  it("is null for a first variation whose answer is not stored yet", () => {
    const cutShort = addUnit(ITALIAN, "Giuoco Pianissimo (4.d3)", [...SETUP, "Bc5"], 5);
    expect(repertoireVariationLine(db, cutShort, null, true)).toBeNull();
  });

  it("is null for a first variation of a group with no root to read", () => {
    const bare = createRepertoireVariation(db, {
      side: "white",
      groupName: "King's Pawn Game",
      variationName: "Bare",
    });
    expect(repertoireVariationLine(db, bare, null, true)).toBeNull();
  });
});

describe("the line every variation of a group starts with", () => {
  it("is the five moves of the Italian setup, numbered from move 1", () => {
    const first = addUnit(ITALIAN, "Giuoco Pianissimo (4.d3)", [...SETUP, "Bc5", "d3"], 5);
    expect(repertoireGroupLine(db, first)).toBe("1.e4 e5 2.Nf3 Nc6 3.Bc4");
  });

  it("is the root of a unit built from one", () => {
    const first = addUnit(
      "Scandinavian Defense",
      "Mieses-Kotroc (2.exd5)",
      ["e4", "d5", "exd5"],
      2,
    );
    expect(repertoireGroupLine(db, first)).toBe("1.e4 d5");
  });

  it("is null while no setup move is stored", () => {
    const bare = createRepertoireVariation(db, {
      side: "white",
      groupName: ITALIAN,
      variationName: "Bare",
    });
    expect(repertoireGroupLine(db, bare)).toBeNull();
  });
});

describe("the White moves a variation and an opening hold", () => {
  const unitsOfGroup = (): RepertoireUnitMoves[] =>
    listDrillRepertoires(db)
      .filter((row) => row.group_name === ITALIAN)
      .map(unitMovesOf);

  it("counts every White move a variation stores, the opening's among them", () => {
    const first = addUnit(ITALIAN, "Giuoco Pianissimo (4.d3)", [...SETUP, "Bc5", "d3"], 5);
    expect(repertoireVariationFigures(db, unitMovesOf(first), NOW).moves_total).toBe(4);
  });

  it("counts a move two variations share once for the opening", () => {
    addUnit(ITALIAN, "Giuoco Pianissimo (4.d3)", [...SETUP, "Bc5", "d3"], 5);
    addUnit(ITALIAN, "Two Knights Defense (4.Ng5)", [...SETUP, "Nf6", "Ng5"], 5);

    const units = unitsOfGroup();

    // e4, Nf3 and Bc4 are in both, so 4 + 4 White moves are 5 for the opening.
    expect(units.map((unit) => repertoireVariationFigures(db, unit, NOW).moves_total)).toEqual([
      4, 4,
    ]);
    expect(repertoireGroupFigures(db, units, NOW).moves_total).toBe(5);
  });

  it("counts both White moves where two variations answer one position differently", () => {
    addUnit(ITALIAN, "Giuoco Pianissimo (4.d3)", [...SETUP, "Bc5", "d3"], 5);
    addUnit(ITALIAN, "Classical Variation (4.c3)", [...SETUP, "Bc5", "c3"], 5);

    expect(repertoireGroupFigures(db, unitsOfGroup(), NOW).moves_total).toBe(5);
  });
});
