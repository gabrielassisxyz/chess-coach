import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess, type Move } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../db/open.js";
import {
  createRepertoireVariation,
  insertRepertoireOwnMove,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { importFinishedGame } from "../import/pgn.js";
import {
  type AddableExplorer,
  addableCandidates,
  listAddableOpenings,
} from "./addable-openings.js";
import { ExplorerError, type ExplorerPosition } from "./explorer-client.js";
import { positionKey } from "./from-games.js";
import { parseOpeningTable } from "./names.js";
import { checkRepertoireRoot } from "./repertoire-root.js";

function fenOf(line: string[]): string {
  const board = new Chess();
  for (const san of line) board.move(san);
  return board.fen();
}

const keyOf = (line: string[]): string => positionKey(fenOf(line));

const NAMES = parseOpeningTable(
  [
    "eco\tname\tpgn\tuci\tepd",
    `C20\tKing's Pawn Game\t-\t-\t${keyOf(["e4", "e5"])}`,
    `B20\tSicilian Defense\t-\t-\t${keyOf(["e4", "c5"])}`,
    `C00\tFrench Defense\t-\t-\t${keyOf(["e4", "e6"])}`,
    `B01\tScandinavian Defense\t-\t-\t${keyOf(["e4", "d5"])}`,
    `B10\tCaro-Kann Defense\t-\t-\t${keyOf(["e4", "c6"])}`,
    `B02\tAlekhine Defense\t-\t-\t${keyOf(["e4", "Nf6"])}`,
    `C44\tKing's Knight Opening: Normal Variation\t-\t-\t${keyOf(["e4", "e5", "Nf3", "Nc6"])}`,
    `C42\tPetrov's Defense\t-\t-\t${keyOf(["e4", "e5", "Nf3", "Nf6"])}`,
    `C41\tPhilidor Defense\t-\t-\t${keyOf(["e4", "e5", "Nf3", "d6"])}`,
    `C40\tKing's Pawn Game: Busch-Gass Gambit\t-\t-\t${keyOf(["e4", "e5", "Nf3", "Bc5"])}`,
    `C40\tKing's Pawn Game: Damiano Defense\t-\t-\t${keyOf(["e4", "e5", "Nf3", "f6"])}`,
    "",
  ].join("\n"),
);

/** Answers by position from numbers a test writes out; anything unwritten has no games. */
class AddableFakeExplorer implements AddableExplorer {
  private readonly answers = new Map<string, ExplorerPosition>();

  write(line: string[], moves: Record<string, number>, total: number): this {
    const white = Math.floor(total / 2);
    const draws = Math.floor(total / 20);
    this.answers.set(keyOf(line), {
      white,
      draws,
      black: total - white - draws,
      moves: Object.entries(moves).map(([san, games]) => ({
        san,
        white: games,
        draws: 0,
        black: 0,
      })),
    });
    return this;
  }

  async position(fen: string, _ratings?: string): Promise<ExplorerPosition> {
    return this.answers.get(positionKey(fen)) ?? { white: 0, draws: 0, black: 0, moves: [] };
  }
}

class AddableFailingExplorer implements AddableExplorer {
  async position(_fen: string, _ratings?: string): Promise<ExplorerPosition> {
    throw new ExplorerError("upstream", "the explorer answered 500");
  }
}

function stockedExplorer(): AddableFakeExplorer {
  return new AddableFakeExplorer()
    .write(["e4"], { e5: 500, c5: 300, e6: 100, d5: 40, c6: 30, Nf6: 10 }, 1000)
    .write(["e4", "e5", "Nf3"], { Nc6: 400, Nf6: 200, Bc5: 150, d6: 100, f6: 50 }, 1000);
}

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "addable-"));
  db = openDatabase(tmp);
  gameCount = 0;
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

// The stored rows of a unit's root: White's moves and Black's replies, ending on Black's move.
function addRootedUnit(root: string[], groupName: string): number {
  const { id } = createRepertoireVariation(db, {
    side: "white",
    groupName,
    variationName: `Rooted (${root.join(" ")})`,
  });
  root.forEach((san, index) => {
    const line = root.slice(0, index);
    const row = {
      repertoireId: id,
      ...placeOf(line, san),
      ply: index + 1,
      line,
      reach: 1,
      openingName: null,
      san,
      share: null,
      source: "setup" as const,
    };
    if (index % 2 === 1) upsertRepertoireReply(db, row);
    else insertRepertoireOwnMove(db, { ...row, cpLoss: 0, evalCp: 25, results: null });
  });
  return id;
}

let gameCount = 0;
function addReviewedGame(line: string[], leftPly: number, name: string | null): void {
  gameCount += 1;
  const pgn = line
    .map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}. ${san}` : san))
    .join(" ");
  const id = importFinishedGame(db, {
    pgn: `[Result "1-0"]\n\n${pgn} 1-0`,
    playerColor: "white",
    source: "pgn",
    sourceId: `addable-${gameCount}`,
  }) as number;
  const board = new Chess();
  let key: string | null = null;
  let move: Move | null = null;
  for (const [index, san] of line.entries()) {
    if (index + 1 === leftPly) key = positionKey(board.fen());
    const played = board.move(san);
    if (index + 1 === leftPly) move = played;
  }
  const italian = createRepertoireVariation(db, {
    side: "white",
    groupName: "Italian Game",
    variationName: `Italian ${gameCount}`,
  }).id;
  db.prepare(
    `INSERT INTO repertoire_game_reviews
       (game_id, repertoire_id, reviewed_at, outcome, followed_plies, passed_moves, left_ply,
        left_position_key, left_san, left_uci, opening_name)
     VALUES (?, ?, ?, 'not_reached', 0, 0, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    italian,
    "2026-01-01T00:00:00.000Z",
    leftPly,
    key,
    move?.san ?? null,
    move ? `${move.from}${move.to}` : null,
    name,
  );
}

describe("addableCandidates", () => {
  it("lists one entry per book family, leaving the path's own moves out", () => {
    expect(addableCandidates(NAMES)).toEqual([
      {
        root: ["e4", "e5", "Nf3", "Bc5"],
        openingName: "King's Pawn Game: Busch-Gass Gambit",
        family: "King's Pawn Game",
      },
      { root: ["e4", "Nf6"], openingName: "Alekhine Defense", family: "Alekhine Defense" },
      {
        root: ["e4", "e5", "Nf3", "Nf6"],
        openingName: "Petrov's Defense",
        family: "Petrov's Defense",
      },
      { root: ["e4", "c5"], openingName: "Sicilian Defense", family: "Sicilian Defense" },
      { root: ["e4", "c6"], openingName: "Caro-Kann Defense", family: "Caro-Kann Defense" },
      { root: ["e4", "d5"], openingName: "Scandinavian Defense", family: "Scandinavian Defense" },
      {
        root: ["e4", "e5", "Nf3", "d6"],
        openingName: "Philidor Defense",
        family: "Philidor Defense",
      },
      { root: ["e4", "e6"], openingName: "French Defense", family: "French Defense" },
    ]);
  });

  it("leaves out a legal reply the book never names", () => {
    const roots = addableCandidates(NAMES).map((candidate) => candidate.root.join(" "));
    expect(roots).not.toContain("e4 b5");
    expect(roots).not.toContain("e4 e5 Nf3 a6");
  });
});

describe("listAddableOpenings", () => {
  it("orders entries by share, then games, then name", async () => {
    const { entries } = await listAddableOpenings(db, NAMES, stockedExplorer());
    expect(entries.map((entry) => [entry.opening_name, entry.share_0_1199])).toEqual([
      ["Sicilian Defense", 0.3],
      ["Petrov's Defense", 0.2],
      ["King's Pawn Game: Busch-Gass Gambit", 0.15],
      ["French Defense", 0.1],
      ["Philidor Defense", 0.1],
      ["Scandinavian Defense", 0.04],
      ["Caro-Kann Defense", 0.03],
      ["Alekhine Defense", 0.01],
    ]);
  });

  it("falls back to games, then name without an explorer", async () => {
    addReviewedGame(["e4", "c5", "Nf3"], 2, "Sicilian Defense");
    addReviewedGame(["e4", "d5", "exd5"], 2, "Scandinavian Defense");
    addReviewedGame(["e4", "d5", "Nc3"], 2, "Scandinavian Defense");
    const { entries } = await listAddableOpenings(db, NAMES, null);
    expect(entries.every((entry) => entry.share_0_1199 === null)).toBe(true);
    expect(entries.map((entry) => [entry.opening_name, entry.games])).toEqual([
      ["Scandinavian Defense", 2],
      ["Sicilian Defense", 1],
      ["Alekhine Defense", 0],
      ["Caro-Kann Defense", 0],
      ["French Defense", 0],
      ["King's Pawn Game: Busch-Gass Gambit", 0],
      ["Petrov's Defense", 0],
      ["Philidor Defense", 0],
    ]);
  });

  it("falls back the same way when the explorer fails", async () => {
    addReviewedGame(["e4", "c5", "Nf3"], 2, "Sicilian Defense");
    const { entries } = await listAddableOpenings(db, NAMES, new AddableFailingExplorer());
    expect(entries.every((entry) => entry.share_0_1199 === null)).toBe(true);
    expect(entries[0]).toMatchObject({ opening_name: "Sicilian Defense", games: 1 });
  });

  it("counts the student's games and names the unit built from the root", async () => {
    addReviewedGame(["e4", "c5", "Nf3"], 2, "Sicilian Defense");
    addReviewedGame(["e4", "c5", "Nf3"], 2, "Sicilian Defense");
    const scandinavian = addRootedUnit(["e4", "d5"], "Scandinavian Defense");
    const { entries } = await listAddableOpenings(db, NAMES, null);
    const byName = new Map(entries.map((entry) => [entry.opening_name, entry]));
    expect(byName.get("Sicilian Defense")).toMatchObject({ games: 2, repertoire_id: null });
    expect(byName.get("Scandinavian Defense")).toMatchObject({
      games: 0,
      repertoire_id: scandinavian,
    });
  });

  it("returns only roots that pass the repertoire root check", async () => {
    const { entries } = await listAddableOpenings(db, NAMES, stockedExplorer());
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(checkRepertoireRoot(entry.root)).toEqual({
        ok: true,
        root: entry.root,
        fen: fenOf(entry.root),
      });
    }
  });

  it("answers no entries where the book names nothing", async () => {
    const empty = parseOpeningTable("eco\tname\tpgn\tuci\tepd\n");
    expect(await listAddableOpenings(db, empty, null)).toEqual({ entries: [] });
  });
});
