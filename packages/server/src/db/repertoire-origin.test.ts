import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoverageSourceSchema } from "@chess-coach/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "./open.js";
import {
  createRepertoireVariation,
  findRepertoireOrigin,
  insertRepertoireOwnMove,
  listWhiteMovesLackingIdea,
  type NewRepertoireOwnMove,
  type RepertoireMoveSource,
} from "./repertoires.js";

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-repertoire-origin-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const newUnit = (variationName: string): number =>
  createRepertoireVariation(db, { side: "white", groupName: "London System", variationName }).id;

function ownMove(unit: number, overrides: Partial<NewRepertoireOwnMove>): NewRepertoireOwnMove {
  return {
    repertoireId: unit,
    positionKey: "start",
    ply: 1,
    line: [],
    reach: 1,
    openingName: null,
    uci: "d2d4",
    san: "d4",
    share: null,
    source: "pgn",
    cpLoss: null,
    evalCp: null,
    results: null,
    ...overrides,
  };
}

describe("a move stored with no engine figures", () => {
  it("keeps a null centipawn loss, a null evaluation and the pgn source", () => {
    const unit = newUnit("Main line");

    insertRepertoireOwnMove(db, ownMove(unit, {}));

    expect(
      db
        .prepare(
          "SELECT kind, source, cp_loss, eval_cp, eval_depth, wins, draws, losses FROM repertoire_positions",
        )
        .all(),
    ).toEqual([
      {
        kind: "own",
        source: "pgn",
        cp_loss: null,
        eval_cp: null,
        eval_depth: null,
        wins: null,
        draws: null,
        losses: null,
      },
    ]);
  });

  it("still stores the figures of a move the engine measured", () => {
    const unit = newUnit("Main line");

    insertRepertoireOwnMove(db, ownMove(unit, { source: "engine", cpLoss: 14, evalCp: -35 }));

    expect(db.prepare("SELECT source, cp_loss, eval_cp FROM repertoire_positions").all()).toEqual([
      { source: "engine", cp_loss: 14, eval_cp: -35 },
    ]);
  });
});

describe("the sources a stored move may have", () => {
  // One entry for each member of the union: a value missing here, or one the union lacks, is a
  // type error, so this list cannot drift from `RepertoireMoveSource` unseen.
  const SOURCES_OF_THE_UNION: Record<RepertoireMoveSource, true> = {
    setup: true,
    explorer: true,
    engine: true,
    mainline: true,
    game: true,
    pgn: true,
  };

  it("are the ones the shared schema of a coverage reply names", () => {
    expect([...CoverageSourceSchema.options].sort()).toEqual(
      Object.keys(SOURCES_OF_THE_UNION).sort(),
    );
  });
});

describe("findRepertoireOrigin", () => {
  it("reads generated for a unit stored without an origin, and pgn for one stored with it", () => {
    const built = newUnit("Built");
    const imported = newUnit("Imported");
    db.prepare("UPDATE repertoires SET origin = 'pgn' WHERE id = ?").run(imported);

    expect(findRepertoireOrigin(db, built)).toBe("generated");
    expect(findRepertoireOrigin(db, imported)).toBe("pgn");
  });

  it("reads generated for a unit that is not stored, as every unit was before the column", () => {
    expect(findRepertoireOrigin(db, 9999)).toBe("generated");
  });
});

describe("listWhiteMovesLackingIdea", () => {
  it("leaves out a move with no evaluation, which its text would be written from", () => {
    const unit = newUnit("Main line");
    insertRepertoireOwnMove(db, ownMove(unit, { source: "engine", cpLoss: 0, evalCp: 25 }));
    insertRepertoireOwnMove(
      db,
      ownMove(unit, { positionKey: "after d4 d5", ply: 3, uci: "c1f4", san: "Bf4" }),
    );

    expect(listWhiteMovesLackingIdea(db).map(({ san, evalCp }) => ({ san, evalCp }))).toEqual([
      { san: "d4", evalCp: 25 },
    ]);
  });
});
