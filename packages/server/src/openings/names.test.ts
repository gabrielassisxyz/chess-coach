import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import {
  loadOpeningNames,
  NO_OPENING_NAMES,
  OPENING_TABLE_FILE,
  OpeningTableError,
  parseOpeningTable,
} from "./names.js";

const REPOSITORY_CONTENT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../content");
const TABLE_ROWS = 3865;
const TABLE_SOURCE_COMMIT = "3ba6b20d31b2e6125cb0e6a2e792f400717d9d39";

const HEADER = "eco\tname\tpgn\tuci\tepd";
const KINGS_PAWN_EPD = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -";
const SCANDINAVIAN_EPD = "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -";

function tableOf(...rows: [eco: string, name: string, epd: string][]): string {
  const lines = rows.map(([eco, name, epd]) => [eco, name, "1. e4", "e2e4", epd].join("\t"));
  return [HEADER, ...lines, ""].join("\n");
}

const SMALL_TABLE = tableOf(
  ["B00", "King's Pawn Game", KINGS_PAWN_EPD],
  ["B01", "Scandinavian Defense", SCANDINAVIAN_EPD],
);

function fensAfter(sans: string[]): string[] {
  const chess = new Chess();
  return sans.map((san) => {
    chess.move(san);
    return chess.fen();
  });
}

describe("reading an opening table", () => {
  it("names a position whatever its move counters are", () => {
    const names = parseOpeningTable(SMALL_TABLE);
    expect(names.size).toBe(2);
    // chess.js writes an en passant square only when the pawn can be taken, as the table does.
    const [afterE4] = fensAfter(["e4"]);
    expect(afterE4).toBe(`${KINGS_PAWN_EPD} 0 1`);
    expect(names.ofPosition(afterE4 as string)).toEqual({ eco: "B00", name: "King's Pawn Game" });
    expect(names.ofPosition(`${SCANDINAVIAN_EPD} 7 31`)).toEqual({
      eco: "B01",
      name: "Scandinavian Defense",
    });
    expect(names.ofPosition(SCANDINAVIAN_EPD)).toEqual({
      eco: "B01",
      name: "Scandinavian Defense",
    });
  });

  it("answers null for a position the table does not hold", () => {
    const names = parseOpeningTable(SMALL_TABLE);
    expect(names.ofPosition("8/8/8/8/8/8/8/K6k w - - 0 1")).toBeNull();
  });

  it("reads a table with Windows line ends the same way", () => {
    const names = parseOpeningTable(SMALL_TABLE.replaceAll("\n", "\r\n"));
    expect(names.ofPosition(SCANDINAVIAN_EPD)).toEqual({
      eco: "B01",
      name: "Scandinavian Defense",
    });
  });

  it("refuses a header that is not the five expected columns", () => {
    expect(() => parseOpeningTable("eco\tname\tepd\n")).toThrow(OpeningTableError);
    expect(() => parseOpeningTable("eco\tname\tepd\n", "table.tsv")).toThrow(/table\.tsv:1/);
  });

  it("names the line of a row with the wrong number of cells", () => {
    const broken = `${SMALL_TABLE}A00\tAmar Opening\tonly three\n`;
    expect(() => parseOpeningTable(broken, "table.tsv")).toThrow(/table\.tsv:4/);
  });

  it("refuses a row whose position is already named, naming its line", () => {
    const twice = tableOf(
      ["B00", "King's Pawn Game", KINGS_PAWN_EPD],
      ["C20", "King's Pawn Game: Again", KINGS_PAWN_EPD],
    );
    expect(() => parseOpeningTable(twice, "table.tsv")).toThrow(/table\.tsv:3/);
  });
});

describe("the name of a game", () => {
  const names = parseOpeningTable(SMALL_TABLE);
  const kingsPawn = `${KINGS_PAWN_EPD} 0 1`;
  const scandinavian = `${SCANDINAVIAN_EPD} 0 2`;

  it("is the last named position in move order, whichever row is longer", () => {
    expect(names.ofGame([kingsPawn, scandinavian])).toEqual({
      eco: "B01",
      name: "Scandinavian Defense",
    });
    expect(names.ofGame([scandinavian, kingsPawn])).toEqual({
      eco: "B00",
      name: "King's Pawn Game",
    });
  });

  it("keeps the last named position when the line goes on past theory", () => {
    expect(names.ofGame([kingsPawn, scandinavian, "no such position", "nor this one"])).toEqual({
      eco: "B01",
      name: "Scandinavian Defense",
    });
  });

  it("is null when no position of the game is named, and for a game with no moves", () => {
    expect(names.ofGame(["no such position", "nor this one"])).toBeNull();
    expect(names.ofGame([])).toBeNull();
  });

  it("is null for every game when there is no table", () => {
    expect(NO_OPENING_NAMES.size).toBe(0);
    expect(NO_OPENING_NAMES.ofGame([kingsPawn])).toBeNull();
  });
});

describe("the shipped Lichess table", () => {
  const names = loadOpeningNames(REPOSITORY_CONTENT);
  const text = readFileSync(join(REPOSITORY_CONTENT, OPENING_TABLE_FILE), "utf8");

  it("holds a header and 3865 rows, one position each", () => {
    expect(text.trimEnd().split("\n")).toHaveLength(TABLE_ROWS + 1);
    expect(names.size).toBe(TABLE_ROWS);
  });

  it("names the Italian Game by position, from an order that has no row of its own", () => {
    expect(text).not.toContain("\t1. Nf3 Nc6 2. e4 e5 3. Bc4\t");
    const fens = fensAfter(["Nf3", "Nc6", "e4", "e5", "Bc4"]);
    expect(names.ofGame(fens)).toEqual({ eco: "C50", name: "Italian Game" });
    expect(names.ofPosition(fens.at(-1) as string)).toEqual({ eco: "C50", name: "Italian Game" });
  });

  it("keeps the last named position of a Scandinavian that leaves theory at move 4", () => {
    const line = ["e4", "d5", "exd5", "Qxd5", "Nc3", "Qa5", "d4", "c6", "Nf3", "Nf6", "Bc4"];
    expect(names.ofGame(fensAfter(line))).toEqual({
      eco: "B01",
      name: "Scandinavian Defense: Main Line",
    });
  });

  // The lookup stands on chess.js writing every position the way the table does, en passant and
  // castling included; replaying each row is the only check that covers all of them.
  it("names the position every row ends on, so chess.js and the table agree on every key", {
    timeout: 30_000,
  }, () => {
    const rows = text.split("\n").slice(1).filter(Boolean);
    expect(rows).toHaveLength(TABLE_ROWS);
    for (const row of rows) {
      const [eco, name, , uci] = row.split("\t") as [string, string, string, string];
      const chess = new Chess();
      for (const move of uci.split(" ")) {
        chess.move({
          from: move.slice(0, 2),
          to: move.slice(2, 4),
          ...(move.length > 4 ? { promotion: move.slice(4) } : {}),
        });
      }
      expect(names.ofPosition(chess.fen()), `${eco} ${name}`).toEqual({ eco, name });
    }
  });

  it("is credited to its source, commit and licence in the content notice", () => {
    const notice = readFileSync(join(REPOSITORY_CONTENT, "NOTICE"), "utf8");
    expect(notice).toContain("https://github.com/lichess-org/chess-openings");
    expect(notice).toContain(TABLE_SOURCE_COMMIT);
    expect(notice).toContain("CC0");
  });
});
