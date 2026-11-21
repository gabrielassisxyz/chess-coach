import { readFileSync } from "node:fs";
import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { positionKey } from "./from-games.js";
import {
  type PgnRepertoireCounts,
  type PgnRepertoireError,
  type PgnRepertoireMove,
  type PgnRepertoireResult,
  type PgnRepertoireSide,
  readPgnRepertoire,
} from "./pgn-repertoire.js";

function movesOf(result: PgnRepertoireResult): PgnRepertoireMove[] {
  if (result.errors) throw new Error(`expected moves, got ${JSON.stringify(result.errors)}`);
  return result.moves;
}

function countsOf(result: PgnRepertoireResult): PgnRepertoireCounts {
  if (result.errors) throw new Error(`expected counts, got ${JSON.stringify(result.errors)}`);
  return result.counts;
}

function errorsOf(result: PgnRepertoireResult): PgnRepertoireError[] {
  if (!result.errors) throw new Error("expected errors, got moves");
  return result.errors;
}

const read = (pgn: string, side: PgnRepertoireSide = "white", weights?: string) =>
  readPgnRepertoire(pgn, side, weights);

// A row as one string: its kind and the whole line it ends, so a test names the rows it expects.
const rowText = (row: PgnRepertoireMove): string =>
  `${row.kind} ${[...row.line_san, row.move_san].join(" ")}`;

const rowsOf = (pgn: string, side: PgnRepertoireSide = "white", weights?: string): string[] =>
  movesOf(read(pgn, side, weights)).map(rowText);

const rowAt = (rows: PgnRepertoireMove[], text: string): PgnRepertoireMove => {
  const row = rows.find((candidate) => rowText(candidate) === text);
  if (!row) throw new Error(`no row ${text} in ${rows.map(rowText).join(" | ")}`);
  return row;
};

// What the generator writes in its column: the key of the position before a move, from a board
// that replays the line with chess.js.
function generatorKeyBefore(row: PgnRepertoireMove): string {
  const board = new Chess();
  for (const san of row.line_san) board.move(san);
  return positionKey(board.fen());
}

const START_KEY = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";

describe("1. the function and what it imports", () => {
  it("exports one function and nothing else at run time", async () => {
    const exported = await import("./pgn-repertoire.js");
    expect(Object.keys(exported)).toEqual(["readPgnRepertoire"]);
  });

  it("returns either moves and counts or errors, never both", () => {
    expect(Object.keys(read("1. e4 e5 *")).sort()).toEqual(["counts", "moves"]);
    expect(Object.keys(read("1. e4 e4 *"))).toEqual(["errors"]);
  });

  it("imports nothing from db or http and reaches for no network", () => {
    const source = readFileSync(new URL("./pgn-repertoire.ts", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(
      (match) => match[1],
    );
    expect(specifiers).toEqual(["chess.js", "./from-games.js"]);
    expect(source).not.toMatch(/\bfetch\(|\brequire\(|\bimport\(/);
  });
});

describe("2. reading the text into one tree", () => {
  it("accepts a move number as 1., 1... and 1. ..., glued to its move or not", () => {
    const spellings = [
      "1.e4 e5 (1...c5) 2.Nf3 *",
      "1. e4 e5 ( 1... c5 ) 2. Nf3 *",
      "1. e4 e5 (1. ... c5) 2. Nf3 *",
      "1. e4 e5 (1. ...c5)2. Nf3 *",
    ];
    for (const spelling of spellings) {
      expect(rowsOf(spelling)).toEqual(["own e4", "reply e4 e5", "reply e4 c5", "own e4 e5 Nf3"]);
    }
  });

  it("accepts the suffixes + # ! ? and stores the SAN chess.js writes", () => {
    const mate = rowsOf("1. e4! e5?! 2. Qh5!? Nc6 3. Bc4 Nf6?? 4. Qxf7# 1-0");
    expect(mate.map((text) => text.split(" ").pop())).toEqual([
      "e4",
      "e5",
      "Qh5",
      "Nc6",
      "Bc4",
      "Nf6",
      "Qxf7#",
    ]);
    expect(rowsOf("1. e4 e5 2. Bc4 Nc6 3. Bxf7+ Kxf7").pop()).toBe(
      "reply e4 e5 Bc4 Nc6 Bxf7+ Kxf7",
    );
    expect(rowsOf("1. e4+ e5#")).toEqual(["own e4", "reply e4 e5"]);
  });

  it("skips headers, escape lines, NAGs and comments, and ends a game at each result", () => {
    const text = [
      "% an escape line {with a brace and ( a paren",
      '[Event "a ] tricky name"]',
      '[White "x"]',
      "",
      "1. e4 $1 e5 ; the rest of this line ( is no variation",
      "2. Nf3 {a comment",
      "over two lines} Nc6 $14 $3 *",
      "",
      "1. e4 e5 2. Nf3 Nc6 1-0",
      "1. e4 e5 2. Nf3 Nc6 0-1",
      "1. e4 e5 2. Nf3 Nc6 1/2-1/2",
    ].join("\n");
    const result = read(text);
    expect(rowsOf(text)).toEqual(["own e4", "reply e4 e5", "own e4 e5 Nf3", "reply e4 e5 Nf3 Nc6"]);
    expect(countsOf(result).games).toBe(4);
  });

  it("nests variations three levels deep and keeps each line's own path", () => {
    const rows = rowsOf(
      "1. d4 d5 (1... Nf6 2. Bf4 d5 (2... e6 3. e3 d5 (3... c5 4. c3) 4. Nf3) 3. e3) 2. Bf4 *",
    );
    expect(rows).toContain("reply d4 Nf6 Bf4 e6 e3 c5");
    expect(rows).toContain("own d4 Nf6 Bf4 e6 e3 c5 c3");
    expect(rows).toContain("own d4 Nf6 Bf4 e6 e3 d5 Nf3");
    expect(rows).toContain("own d4 Nf6 Bf4 d5 e3");
    expect(rows).toContain("own d4 d5 Bf4");
  });

  it("reads a variation whose first move is written either way, spaced or not", () => {
    const spaced = "1. e4 ( 1. d4 d5 ) 1... c6 2. d4 ( 2. c4 d5 ) 2... d5 *";
    const tight = "1. e4 (1. d4 d5) 1... c6 2. d4 (2. c4 d5) 2... d5 *";
    expect(rowsOf(tight, "black")).toEqual(rowsOf(spaced, "black"));
    expect(rowsOf(tight, "black")).toContain("reply e4 c6 c4");
    expect(rowsOf(tight, "black")).toContain("own d4 d5");
  });

  it("reads a line wrapped in the middle of a variation as the unwrapped line", () => {
    const wrapped = "1. d4 d5 (\n1... e6 2.\nBf4 ) 2.\nBf4 *";
    expect(rowsOf(wrapped)).toEqual(rowsOf("1. d4 d5 ( 1... e6 2. Bf4 ) 2. Bf4 *"));
    expect(rowsOf(wrapped)).toContain("own d4 e6 Bf4");
  });

  it("reads a Black-side text whose first branching is White's first move", () => {
    const rows = rowsOf("1. e4 (1. d4 d5 2. c4) 1... e5 2. Nf3 *", "black");
    expect(rows).toEqual([
      "reply e4",
      "reply d4",
      "own d4 d5",
      "own e4 e5",
      "reply d4 d5 c4",
      "reply e4 e5 Nf3",
    ]);
  });

  it("merges the games of a text into one tree", () => {
    const result = read("1. e4 e5 2. Nf3 Nc6 *\n\n1. e4 c5 2. Nf3 d6 *");
    expect(movesOf(result).map(rowText).sort()).toEqual(
      [
        "own e4",
        "reply e4 e5",
        "reply e4 c5",
        "own e4 e5 Nf3",
        "own e4 c5 Nf3",
        "reply e4 e5 Nf3 Nc6",
        "reply e4 c5 Nf3 d6",
      ].sort(),
    );
    expect(countsOf(result)).toMatchObject({ games: 2, own_moves: 3, replies: 4 });
  });

  it("starts a game at its header even when the one before has no result", () => {
    const text = '[Event "a"]\n\n1. e4 e5\n\n[Event "b"]\n\n1. e4 c5 *';
    expect(countsOf(read(text)).games).toBe(2);
  });

  it("reads a text with a byte order mark and CRLF line ends as the same text", () => {
    const text = '[Event "a"]\n\n1. e4 {why} e5 ; note\n2. Nf3 *';
    const windows = `${String.fromCharCode(0xfeff)}${text.replaceAll("\n", "\r\n")}`;
    expect(read(windows)).toEqual(read(text));
  });

  it("refuses a game with a SetUp or a FEN header as not_from_start", () => {
    const fen = '[FEN "8/8/8/8/8/8/8/K1k5 w - - 0 1"]';
    const setUp = '[SetUp "1"]';
    for (const header of [fen, setUp, `${setUp}\n${fen}`]) {
      const result = read(`${header}\n\n1. Kb1 *`);
      expect(errorsOf(result)[0]).toMatchObject({ code: "not_from_start", game: 1 });
      expect(result.moves).toBeUndefined();
    }
    const second = read(`[Event "a"]\n\n1. e4 *\n\n[Event "b"]\n${fen}\n\n1. Kb1 *`);
    expect(errorsOf(second)[0]).toMatchObject({ code: "not_from_start", game: 2 });
  });

  it.each<[string, string, number]>([
    ["a comment never closed", "1. e4 {oops", 1],
    ["a } with no {", "1. e4 e5\n2. Nf3 } Nc6", 2],
    ["a ) with no (", "1. e4 e5\n2. Nf3 )", 2],
    ["a variation never closed", "1. e4 e5 (1... c5", 1],
    ["a variation before any move", "(1. e4) 1. d4", 1],
    ["an empty variation", "1. e4 e5 ()", 1],
    ["a result inside a variation", "1. e4 e5 (1... c5 *) 2. Nf3", 1],
    ["a tag pair inside a variation", '1. e4 e5 (1... c5 [Event "x"]) 2. Nf3', 1],
    ["a tag pair that is not closed", '[Event "x\n\n1. e4 *', 1],
  ])("refuses %s as invalid_pgn naming its line", (_name, text, line) => {
    const result = read(text);
    expect(errorsOf(result)).toHaveLength(1);
    expect(errorsOf(result)[0]).toMatchObject({ code: "invalid_pgn", line });
    expect(result.moves).toBeUndefined();
  });

  it("refuses a text with no moves", () => {
    for (const text of ["", "  \n\t", '[Event "x"]\n\n*', "{only a comment}"]) {
      expect(errorsOf(read(text))[0]).toMatchObject({ code: "no_moves" });
    }
  });
});

describe("2b. lines and variations deep enough for an opening file", () => {
  // A legal line of the length asked, from a fixed pseudo-random choice among the legal moves.
  function legalLine(plies: number): string[] {
    const board = new Chess();
    const sans: string[] = [];
    let seed = 20_241_121;
    while (sans.length < plies) {
      const legal = board.moves();
      seed = (seed * 48_271) % 2_147_483_647;
      const san = legal[seed % legal.length] as string;
      board.move(san);
      sans.push(san);
    }
    return sans;
  }

  it("reads a line of 70 plies with the ply and line of every move", () => {
    const sans = legalLine(70);
    const rows = movesOf(read(`${sans.join(" ")} *`));
    expect(rows).toHaveLength(70);
    rows.forEach((row, index) => {
      expect(row.ply).toBe(index + 1);
      expect(row.line_san).toEqual(sans.slice(0, index));
      expect(row.move_san).toBe(sans[index]);
    });
  });

  it("reads variations nested 62 plies deep as the plain line", () => {
    const sans = legalLine(62);
    const nested = sans.reduceRight(
      (inner, san, index) =>
        index === sans.length - 1 ? `${san} (${san})` : `${san} (${san} ${inner})`,
      "",
    );
    expect(nested.match(/\(/g)).toHaveLength(62);
    expect(read(`${nested} *`)).toEqual(read(`${sans.join(" ")} *`));
  });
});

describe("3. replaying every move with chess.js", () => {
  it("refuses a move chess.js refuses as illegal_move and returns no moves", () => {
    const text = '1. e4 e5 *\n\n[Event "b"]\n\n1. e4 c5 2. Qh6?! Nf6 *';
    const result = read(text);
    expect(errorsOf(result)).toHaveLength(1);
    expect(errorsOf(result)[0]).toMatchObject({
      code: "illegal_move",
      game: 2,
      move: "Qh6?!",
      line_san: ["e4", "c5"],
    });
    expect(result.moves).toBeUndefined();
    expect(result.counts).toBeUndefined();
  });

  it("names the line of the variation an illegal move is in", () => {
    const result = read("1. e4 e5 (1... c5 2. Ke3) 2. Nf3 *");
    expect(errorsOf(result)[0]).toMatchObject({
      code: "illegal_move",
      game: 1,
      move: "Ke3",
      line_san: ["e4", "c5"],
    });
  });

  it("refuses a move that needs the disambiguation it lacks", () => {
    const result = read("1. d4 d5 2. Nf3 Nf6 3. Nd2 *");
    expect(errorsOf(result)[0]).toMatchObject({ code: "illegal_move", move: "Nd2" });
  });

  it("refuses a move played after the game was won", () => {
    const result = read("1. f3 e5 2. g4 Qh4# 3. a3 *");
    expect(errorsOf(result)[0]).toMatchObject({ code: "illegal_move", move: "a3" });
  });

  it("stores the SAN chess.js writes where the file wrote a longer spelling", () => {
    const rows = rowsOf("1. d4 d5 2. Bf4 Nf6 3. Nbd2 e6 *");
    expect(rows).toContain("own d4 d5 Bf4 Nf6 Nd2");
    expect(rows).toContain("reply d4 d5 Bf4 Nf6 Nd2 e6");
    expect(rows.join(" ")).not.toContain("Nbd2");
  });
});

describe("4. own moves, replies and the key of a position", () => {
  it("makes the given side's moves own and every other move a reply", () => {
    expect(movesOf(read("1. e4 e5 2. Nf3 *", "white")).map((row) => row.kind)).toEqual([
      "own",
      "reply",
      "own",
    ]);
    expect(movesOf(read("1. e4 e5 2. Nf3 *", "black")).map((row) => row.kind)).toEqual([
      "reply",
      "own",
      "reply",
    ]);
  });

  it("writes the move as UCI the way the engine does, castling and promotion included", () => {
    const uci = (pgn: string, side: PgnRepertoireSide): string[] =>
      movesOf(read(pgn, side)).map((row) => row.move_uci);
    expect(uci("1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. O-O *", "white").pop()).toBe("e1g1");
    expect(uci("1. d4 d5 2. Nc3 Nc6 3. Bf4 Bf5 4. Qd2 Qd7 5. O-O-O O-O-O *", "black").pop()).toBe(
      "e8c8",
    );
    expect(uci("1. e4 d5 2. exd5 c6 3. dxc6 Nf6 4. cxb7 Nc6 5. bxa8=Q *", "white").pop()).toBe(
      "b7a8q",
    );
    expect(uci("1. e4 a6 2. e5 d5 3. exd6 *", "white").pop()).toBe("e5d6");
  });

  it("gives every row the ply after its line and the SANs before it", () => {
    for (const row of movesOf(read("1. d4 d5 (1... e6 2. Bf4) 2. Bf4 Nf6 3. e3 *"))) {
      expect(row.ply).toBe(row.line_san.length + 1);
    }
  });

  it("writes the position key of the position before the move, as the generator does", () => {
    const rows = movesOf(
      read("1. e4 a6 2. e5 d5 3. exd6 Nf6 4. Nf3 e6 5. Bc4 Bxd6 6. O-O O-O 7. d4 *"),
    );
    const first = rowAt(rows, "own e4");
    const enPassant = rowAt(rows, "own e4 a6 e5 d5 exd6");
    const afterCastling = rowAt(rows, "own e4 a6 e5 d5 exd6 Nf6 Nf3 e6 Bc4 Bxd6 O-O O-O d4");
    expect(first.position_key).toBe(START_KEY);
    expect(enPassant.position_key).toBe(
      "rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6",
    );
    for (const row of [first, enPassant, afterCastling]) {
      expect(row.position_key).toBe(generatorKeyBefore(row));
    }
    const board = new Chess();
    for (const san of [...first.line_san, first.move_san]) board.move(san);
    expect(positionKey(board.fen())).not.toBe(first.position_key);
  });
});

describe("5. one row for a position and move, and two answers to one position", () => {
  it("returns a position and own move reached by two lines once, with the line of higher reach", () => {
    // The first game reaches the position through a position with two replies, the second through
    // one with a single reply, so the later line is the likelier one.
    const rows = movesOf(
      read("1. d4 d5 2. Bf4 Nf6 (2... c5 3. e3) 3. e3 *\n\n1. d4 Nf6 2. Bf4 d5 3. e3 *"),
    );
    expect(rows.filter((row) => row.kind === "own" && row.move_san === "e3")).toHaveLength(2);
    const kept = rowAt(rows, "own d4 Nf6 Bf4 d5 e3");
    expect(kept.reach).toBe(0.5);
    expect(rows.map(rowText)).not.toContain("own d4 d5 Bf4 Nf6 e3");
  });

  it("keeps the earlier line when two lines reach the same position and move with equal reach", () => {
    const rows = movesOf(read("1. d4 d5 2. Bf4 Nf6 3. e3 *\n\n1. d4 Nf6 2. Bf4 d5 3. e3 *"));
    expect(rows.map(rowText)).toContain("own d4 d5 Bf4 Nf6 e3");
    expect(rows.map(rowText)).not.toContain("own d4 Nf6 Bf4 d5 e3");
    expect(rows.filter((row) => row.move_san === "e3")).toHaveLength(1);
  });

  it("does the same for a reply: the likelier line, and the earlier one at a tie", () => {
    const likelier = movesOf(
      read("1. d4 d5 2. Bf4 Nf6 (2... c5 3. e3) 3. e3 e6 *\n\n1. d4 Nf6 2. Bf4 d5 3. e3 e6 *"),
    );
    expect(likelier.map(rowText)).toContain("reply d4 Nf6 Bf4 d5 e3 e6");
    expect(likelier.map(rowText)).not.toContain("reply d4 d5 Bf4 Nf6 e3 e6");
    const tied = movesOf(read("1. d4 d5 2. Bf4 Nf6 3. e3 e6 *\n\n1. d4 Nf6 2. Bf4 d5 3. e3 e6 *"));
    expect(tied.map(rowText)).toContain("reply d4 d5 Bf4 Nf6 e3 e6");
    expect(tied.map(rowText)).not.toContain("reply d4 Nf6 Bf4 d5 e3 e6");
  });

  it("returns the same game read twice as one set of rows", () => {
    const once = read("1. d4 d5 2. Bf4 *");
    const twice = read("1. d4 d5 2. Bf4 *\n\n1. d4 d5 2. Bf4 *");
    expect(movesOf(twice)).toEqual(movesOf(once));
    expect(countsOf(twice)).toMatchObject({ games: 2, own_moves: 2, replies: 1 });
  });

  it("refuses two different own moves in one position as two_answers naming both lines", () => {
    const result = read("1. d4 d5 2. Bf4 (2. c4) 2... Nf6 *");
    expect(errorsOf(result)).toHaveLength(1);
    expect(errorsOf(result)[0]).toMatchObject({
      code: "two_answers",
      answers: [
        { game: 1, line_san: ["d4", "d5"], move_san: "Bf4" },
        { game: 1, line_san: ["d4", "d5"], move_san: "c4" },
      ],
    });
    expect(result.moves).toBeUndefined();
  });

  it("finds two answers to one position that two lines of different order reach", () => {
    const result = read("1. d4 d5 2. Bf4 Nf6 3. e3 *\n\n1. d4 Nf6 2. Bf4 d5 3. Nf3 *");
    expect(errorsOf(result)[0]).toMatchObject({
      code: "two_answers",
      answers: [
        { game: 1, line_san: ["d4", "d5", "Bf4", "Nf6"], move_san: "e3" },
        { game: 2, line_san: ["d4", "Nf6", "Bf4", "d5"], move_san: "Nf3" },
      ],
    });
  });

  it("reports every position that has two answers", () => {
    const result = read("1. d4 d5 2. Bf4 (2. c4) 2... Nf6 3. e3 (3. Nf3) *");
    expect(errorsOf(result).map((error) => error.code)).toEqual(["two_answers", "two_answers"]);
  });
});

describe("6. reach, without and with weights", () => {
  it("gives the start reach 1, an own move its position's reach and each of k replies 1 over k", () => {
    const rows = movesOf(read("1. d4 d5 (1... e6) (1... Nf6) 2. Bf4 Nc6 (2... c5) 3. e3 *"));
    const reach = (text: string): number => rowAt(rows, text).reach;
    expect(reach("own d4")).toBe(1);
    expect(reach("reply d4 d5")).toBe(1 / 3);
    expect(reach("reply d4 e6")).toBe(1 / 3);
    expect(reach("reply d4 Nf6")).toBe(1 / 3);
    expect(reach("own d4 d5 Bf4")).toBe(1 / 3);
    expect(reach("reply d4 d5 Bf4 Nc6")).toBe(1 / 6);
    expect(reach("reply d4 d5 Bf4 c5")).toBe(1 / 6);
    expect(reach("own d4 d5 Bf4 Nc6 e3")).toBe(reach("reply d4 d5 Bf4 Nc6"));
  });

  it("counts a reply two lines share once when it divides the reach", () => {
    const rows = movesOf(read("1. d4 d5 2. Bf4 *\n\n1. d4 d5 2. Bf4 *\n\n1. d4 e6 2. Bf4 *"));
    expect(rowAt(rows, "reply d4 d5").reach).toBe(1 / 2);
    expect(rowAt(rows, "reply d4 e6").reach).toBe(1 / 2);
  });

  const text = "1. d4 d5 (1... e6) (1... Nf6) 2. Bf4 Nc6 (2... c5) 3. e3 *";
  // The columns are found by name, in any order; reason and best are the generator's own and
  // are not read.
  const weights = [
    "line\tbest\tloss_cp\treason\treach",
    "1. d4\td4\t4\toverride\t0.9000",
    "1. d4 d5 2. Bf4\tBf4\t17\trule\t0.5592",
    "1. d4 d5\td5\t0\trule\t0.4",
    "1. c4 e5 2. Nc3\tNc3\t9\trule\t0.2",
    "",
  ].join("\n");

  it("takes the reach and the loss of the row whose line matches an own move", () => {
    const rows = movesOf(read(text, "white", weights));
    expect(rowAt(rows, "own d4")).toMatchObject({ reach: 0.9, cp_loss: 4, reason: null });
    expect(rowAt(rows, "own d4 d5 Bf4")).toMatchObject({
      reach: 0.5592,
      cp_loss: 17,
      reason: null,
    });
  });

  it("keeps the rule without weights, and a null loss, for an own move with no row", () => {
    const rows = movesOf(read(text, "white", weights));
    expect(rowAt(rows, "own d4 d5 Bf4 Nc6 e3")).toMatchObject({ reach: 1 / 6, cp_loss: null });
    expect(rowAt(rows, "reply d4 d5").reach).toBe(1 / 3);
    expect(rowAt(rows, "reply d4 d5 Bf4 Nc6").reach).toBe(1 / 6);
  });

  it("counts a weights row that matches no own move, and does not refuse it", () => {
    const result = read(text, "white", weights);
    expect(countsOf(result)).toMatchObject({ weights_matched: 2, weights_unmatched: 2 });
    expect(countsOf(read(text)).weights_matched).toBe(0);
    expect(countsOf(read(text)).weights_unmatched).toBe(0);
  });

  it("finds a row by the SAN chess.js writes, the line numbered or not and CRLF or not", () => {
    const pgn = "1. d4 d5 2. Bf4 Nf6 3. Nd2 *";
    const spelled = "reach\tloss_cp\tline\r\n0.25\t8\td4 d5 Bf4 Nf6 3. Nbd2\r\n";
    expect(movesOf(read(pgn, "white", spelled)).pop()).toMatchObject({ reach: 0.25, cp_loss: 8 });
  });

  it("matches only the own moves of the side asked for", () => {
    const result = read("1. d4 d5 2. Bf4 *", "black", "reach\tloss_cp\tline\n0.5\t3\t1. d4 d5\n");
    expect(rowAt(movesOf(result), "own d4 d5")).toMatchObject({ reach: 0.5, cp_loss: 3 });
    const white = read("1. d4 d5 2. Bf4 *", "white", "reach\tloss_cp\tline\n0.5\t3\t1. d4 d5\n");
    expect(countsOf(white)).toMatchObject({ weights_matched: 0, weights_unmatched: 1 });
  });

  it.each<[string, string]>([
    ["no header at all", ""],
    ["no reach column", "loss_cp\tline\n3\t1. d4\n"],
    ["no loss_cp column", "reach\tline\n0.5\t1. d4\n"],
    ["no line column", "reach\tloss_cp\n0.5\t3\n"],
    ["a reach that is no number", "reach\tloss_cp\tline\nhalf\t3\t1. d4\n"],
    ["a reach over 1", "reach\tloss_cp\tline\n1.5\t3\t1. d4\n"],
    ["a loss that is no number", "reach\tloss_cp\tline\n0.5\t\t1. d4\n"],
    ["an empty line", "reach\tloss_cp\tline\n0.5\t3\t\n"],
    ["two rows for one line", "reach\tloss_cp\tline\n0.5\t3\t1. d4\n0.4\t2\t1. d4\n"],
  ])("refuses a weights text with %s as invalid_weights", (_name, bad) => {
    const result = read("1. d4 d5 *", "white", bad);
    expect(errorsOf(result)[0]).toMatchObject({ code: "invalid_weights" });
    expect(result.moves).toBeUndefined();
  });
});

describe("7. reasons and the comments that are not one", () => {
  const reasonOf = (pgn: string, side: PgnRepertoireSide = "white"): string | null =>
    movesOf(read(pgn, side))[0]?.reason ?? null;

  it.each<[string, string, string | null]>([
    ["one comment", "1. e4 {Takes the centre} e5 *", "Takes the centre"],
    [
      "a command in square brackets",
      "1. e4 {[%cal Gd2d4] Takes [%csl Gd5]the centre } e5 *",
      "Takes the centre",
    ],
    ["whitespace and line breaks", "1. e4 {  Takes\n   the \t centre\n} e5 *", "Takes the centre"],
    ["two comments", "1. e4 {Takes} {the centre} e5 *", "Takes the centre"],
    ["a NAG between two comments", "1. e4 {Takes} $1 {the centre} e5 *", "Takes the centre"],
    ["a comment that is only a command", "1. e4 {[%cal Gd2d4]} e5 *", null],
    ["an empty comment", "1. e4 {} e5 *", null],
    ["a comment of white space", "1. e4 { \n } e5 *", null],
  ])("makes the comment after an own move its reason: %s", (_name, pgn, reason) => {
    expect(reasonOf(pgn)).toBe(reason);
  });

  it("gives a Black-side text's reason to Black's move and ignores the comment after White's", () => {
    const result = read("1. e4 {the reply} e5 {the reason} *", "black");
    const rows = movesOf(result);
    expect(rowAt(rows, "reply e4").reason).toBeNull();
    expect(rowAt(rows, "own e4 e5").reason).toBe("the reason");
    expect(countsOf(result)).toMatchObject({ reasons: 1, comments_ignored: 1 });
  });

  it.each<[string, string]>([
    ["after a reply", "1. e4 e5 {on the reply} 2. Nf3 *"],
    ["before the first move", "{an introduction} 1. e4 e5 *"],
    ["right after a variation opens", "1. e4 e5 ({inside} 1... c5) 2. Nf3 *"],
    ["right after a variation closes", "1. e4 e5 (1... c5) {after} 2. Nf3 *"],
    ["to the end of the line with ;", "1. e4 ; why\ne5 *"],
    ["after the result", "1. e4 e5 * {after the game}"],
    ["between a move number and its move", "1. {between} e4 e5 *"],
  ])("counts a comment %s as ignored and stores no reason", (_name, pgn) => {
    const result = read(pgn);
    expect(countsOf(result)).toMatchObject({ comments_ignored: 1, reasons: 0 });
    expect(movesOf(result).every((row) => row.reason === null)).toBe(true);
  });

  it("does not count a comment that only held a command as ignored", () => {
    expect(countsOf(read("1. e4 {[%cal Gd2d4]} e5 *"))).toMatchObject({
      comments_ignored: 0,
      reasons: 0,
    });
  });

  it("gives a reason to the row kept for a position and move, with the line kept", () => {
    const rows = movesOf(
      read("1. d4 d5 2. Bf4 Nf6 3. e3 {first line} *\n\n1. d4 Nf6 2. Bf4 d5 3. e3 {second line} *"),
    );
    expect(rowAt(rows, "own d4 d5 Bf4 Nf6 e3").reason).toBe("first line");
  });
});

describe("8. a line that ends on an opponent's move", () => {
  it("keeps the reply and counts it as unanswered", () => {
    const result = read("1. d4 d5 (1... e6) 2. Bf4 *");
    expect(rowAt(movesOf(result), "reply d4 e6").kind).toBe("reply");
    expect(countsOf(result).unanswered_replies).toBe(1);
  });

  it("counts the last reply of a main line that ends on one", () => {
    expect(countsOf(read("1. d4 d5 2. Bf4 Nf6 *")).unanswered_replies).toBe(1);
    expect(countsOf(read("1. e4 e5 2. Nf3 *", "black")).unanswered_replies).toBe(1);
  });

  it("does not count a reply whose position another line answers", () => {
    const result = read("1. d4 d5 2. Bf4 Nf6 *\n\n1. d4 Nf6 2. Bf4 d5 3. e3 *");
    expect(countsOf(result).unanswered_replies).toBe(0);
  });
});

describe("9. the order of the moves", () => {
  it("orders by reach descending, then ply ascending, then the order in the text", () => {
    expect(rowsOf("1. d4 d5 (1... e6) 2. Bf4 *")).toEqual([
      "own d4",
      "reply d4 d5",
      "reply d4 e6",
      "own d4 d5 Bf4",
    ]);
  });

  it("puts a deeper move of higher reach before a shallower one of lower reach", () => {
    const weights = "reach\tloss_cp\tline\n0.9\t0\t1. d4 d5 2. Bf4\n";
    expect(rowsOf("1. d4 d5 (1... e6) 2. Bf4 *", "white", weights)).toEqual([
      "own d4",
      "own d4 d5 Bf4",
      "reply d4 d5",
      "reply d4 e6",
    ]);
  });
});

describe("10. the counts", () => {
  it("counts what was read, with every field", () => {
    const result = read(
      "1. d4 {Start with the queen pawn} d5 {on a reply} (1... Nf6 {again}) 2. Bf4 ; line note\ne6 *",
    );
    expect(countsOf(result)).toEqual({
      games: 1,
      own_moves: 2,
      replies: 3,
      reasons: 1,
      comments_ignored: 3,
      unanswered_replies: 2,
      deepest_ply: 4,
      weights_matched: 0,
      weights_unmatched: 0,
    });
  });
});

describe("11. the size limit", () => {
  const padded = (bytes: number): string => `1. e4 e5 *${" ".repeat(bytes - 10)}`;

  it("refuses a text over 500,000 bytes as too_large without parsing it", () => {
    const result = read("x".repeat(500_001));
    expect(errorsOf(result)).toHaveLength(1);
    expect(errorsOf(result)[0]).toMatchObject({ code: "too_large" });
    expect(result.moves).toBeUndefined();
  });

  it("reads a text of exactly 500,000 bytes", () => {
    expect(movesOf(read(padded(500_000)))).toHaveLength(2);
    expect(errorsOf(read(padded(500_001)))[0]).toMatchObject({ code: "too_large" });
  });

  it("counts bytes and not characters", () => {
    const text = "é".repeat(250_001);
    expect(text.length).toBeLessThan(500_000);
    expect(errorsOf(read(text))[0]).toMatchObject({ code: "too_large" });
  });

  it("holds the weights text to the same limit", () => {
    const result = read("1. e4 e5 *", "white", `reach\tloss_cp\tline\n${"x".repeat(500_000)}`);
    expect(errorsOf(result)[0]).toMatchObject({ code: "too_large" });
  });
});

describe("the golden fixtures", () => {
  const fixture = (name: string): string =>
    readFileSync(new URL(`./pgn-repertoire-fixtures/${name}`, import.meta.url), "utf8");

  const readings: [string, PgnRepertoireSide, string | null, string][] = [
    ["white.pgn", "white", null, "white.expected.json"],
    ["white.pgn", "white", "white.weights.tsv", "white-weighted.expected.json"],
    ["black.pgn", "black", null, "black.expected.json"],
  ];

  // The stored rows leave out position_key: the scanner for secrets reads a FEN next to a field
  // named key as one, and the key of every row is proved against the generator's function below.
  const withoutKey = ({ position_key: _key, ...rest }: PgnRepertoireMove) => rest;

  it.each(readings)("reads %s as %s with weights %s into %s", (pgn, side, weights, expected) => {
    const result = read(fixture(pgn), side, weights === null ? undefined : fixture(weights));
    expect({ moves: movesOf(result).map(withoutKey), counts: countsOf(result) }).toEqual(
      JSON.parse(fixture(expected)),
    );
  });

  it.each(readings)("keys every row of %s as %s like the generator", (pgn, side, weights) => {
    const result = read(fixture(pgn), side, weights === null ? undefined : fixture(weights));
    for (const row of movesOf(result)) {
      expect(row.position_key).toBe(generatorKeyBefore(row));
      expect(row.ply).toBe(row.line_san.length + 1);
    }
  });
});
