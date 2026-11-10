import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess, type Move } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../test/fakes/fake-explorer.js";
import { buildApp } from "../app.js";
import { type Database, openDatabase } from "../db/open.js";
import {
  createRepertoireVariation,
  findFirstRepertoireVariation,
  insertRepertoireOwnMove,
  raiseRepertoireOwnMoveReach,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { applyUci } from "../engine/moves.js";
import type { Searcher, SearchRequest, SearchResult } from "../engine/uci.js";
import { RecordingLog } from "../log.js";
import {
  EXPLORER_RATINGS,
  ExplorerError,
  type ExplorerFetcher,
  ITALIAN_WHITE_RATINGS,
} from "./explorer-client.js";
import { positionKey } from "./from-games.js";
import {
  generateRepertoire,
  REPERTOIRE_MAX_PLY,
  REPERTOIRE_MIN_REACH,
  type RepertoireOptions,
  type RepertoireResult,
} from "./from-repertoire.js";
import { NO_OPENING_NAMES, type OpeningNames, parseOpeningTable } from "./names.js";

const SETUP = ["e4", "e5", "Nf3", "Nc6", "Bc4"];
const BEFORE_BC4 = SETUP.slice(0, 4);
const AFTER_BC5 = [...SETUP, "Bc5"];
const AFTER_C3 = [...AFTER_BC5, "c3"];
const BEFORE_CXD4 = [...AFTER_C3, "Nf6", "d4", "exd4"];
const AFTER_CXD4 = [...BEFORE_CXD4, "cxd4"];

function fenOf(line: string[]): string {
  const game = new Chess();
  for (const san of line) game.move(san);
  return game.fen();
}

const keyOf = (line: string[]): string => positionKey(fenOf(line));

/** Answers by position and band from numbers a test writes out; anything unwritten has no games. */
class RepertoireFakeExplorer implements ExplorerFetcher {
  readonly calls: Array<{ key: string; ratings: string | undefined }> = [];
  /** A student-band position nobody wrote answers its first legal move, so a line never stalls. */
  autoplay = false;
  private readonly answers = new Map<string, unknown>();
  private readonly failures = new Map<string, ExplorerError>();

  write(line: string[], ratings: string, moves: Record<string, number>, total: number): this {
    const white = Math.round(total * 0.5);
    const draws = Math.round(total * 0.04);
    this.answers.set(`${ratings}|${keyOf(line)}`, {
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

  gamesWrittenAt(key: string, ratings: string): number {
    const answer = this.answers.get(`${ratings}|${key}`) as
      | { white: number; draws: number; black: number }
      | undefined;
    return answer ? answer.white + answer.draws + answer.black : 0;
  }

  /** Throws for one position and band, as the real client does on a 401 or an upstream error. */
  failAt(line: string[], ratings: string, failure: ExplorerError): this {
    this.failures.set(`${ratings}|${keyOf(line)}`, failure);
    return this;
  }

  async fetch(fen: string, ratings?: string): Promise<string> {
    const key = positionKey(fen);
    this.calls.push({ key, ratings });
    const failure = this.failures.get(`${ratings}|${key}`);
    if (failure) throw failure;
    return JSON.stringify(this.answers.get(`${ratings}|${key}`) ?? this.unwritten(fen, ratings));
  }

  private unwritten(fen: string, ratings: string | undefined): unknown {
    const empty = { white: 0, draws: 0, black: 0, moves: [] };
    if (!this.autoplay || ratings !== EXPLORER_RATINGS) return empty;
    const move = forwardMove(fen);
    if (!move) return empty;
    const counts = { white: 1000, draws: 0, black: 0 };
    return { ...counts, moves: [{ san: move.san, ...counts }] };
  }
}

/** A pawn move when there is one: it can never repeat a position, so a line stays new to its end. */
function forwardMove(fen: string): Move | undefined {
  const moves = new Chess(fen).moves({ verbose: true });
  return moves.find((move) => move.piece === "p") ?? moves[0];
}

/** Scores the moves a test writes out; an unwritten position has one forward move alone. */
class RepertoireFakeEngine implements Searcher {
  readonly requests: SearchRequest[] = [];
  /** Names no move where Black is to move, as an engine that was never asked for replies would. */
  blindToBlack = false;
  private readonly scripted = new Map<string, Array<{ moves: string[]; score: number }>>();

  write(line: string[], scores: Array<[uci: string, score: number]>): this {
    this.scripted.set(
      keyOf(line),
      scores.map(([uci, score]) => ({ moves: [uci], score })),
    );
    return this;
  }

  /** Stockfish's answer when the side to move is mated: one line with no move and a lost score. */
  writeMated(line: string[]): this {
    this.scripted.set(keyOf(line), [{ moves: [], score: -10000 }]);
    return this;
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    this.requests.push(request);
    if (this.blindToBlack && request.fen.split(" ")[1] === "b") {
      return { fen: request.fen, bestmove: null, lines: [] };
    }
    const written = this.scripted.get(positionKey(request.fen));
    // Stockfish answers as many lines as MultiPV asks for, and too few would change White's pick.
    const lines = (written ?? forwardMoveLines(request.fen)).slice(0, request.multipv ?? 1);
    return { fen: request.fen, bestmove: lines[0]?.moves[0] ?? null, lines };
  }
}

function forwardMoveLines(fen: string): SearchResult["lines"] {
  const move = forwardMove(fen);
  return move ? [{ moves: [`${move.from}${move.to}${move.promotion ?? ""}`], score: 20 }] : [];
}

const ITALIAN_FIXTURE_NAMES: OpeningNames = parseOpeningTable(
  [
    "eco\tname\tpgn\tuci\tepd",
    `C50\tItalian Game\t-\t-\t${keyOf(SETUP)}`,
    `C50\tItalian Game: Giuoco Piano\t-\t-\t${keyOf(AFTER_BC5)}`,
    `C53\tItalian Game: Classical Variation\t-\t-\t${keyOf(AFTER_C3)}`,
    `C55\tItalian Game: Two Knights Defense\t-\t-\t${keyOf([...SETUP, "Nf6"])}`,
  ].join("\n"),
);

interface RepertoireTestRow {
  id: number;
  repertoire_id: number;
  kind: "own" | "reply";
  position_key: string;
  ply: number;
  line_san: string;
  move_uci: string;
  move_san: string;
  share: number | null;
  reach: number;
  opening_name: string | null;
  idea: string | null;
  source: string;
  cp_loss: number | null;
  eval_cp: number | null;
  wins: number | null;
  draws: number | null;
  losses: number | null;
}

let tmp: string;
let cacheDir: string;
let db: Database;
let clock: FakeClock;
let explorer: RepertoireFakeExplorer;
let engine: RepertoireFakeEngine;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-repertoire-"));
  cacheDir = join(tmp, "explorer-cache");
  db = openDatabase(tmp);
  clock = new FakeClock();
  explorer = new RepertoireFakeExplorer();
  engine = new RepertoireFakeEngine();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const generate = (
  options: RepertoireOptions = {},
  names: OpeningNames = ITALIAN_FIXTURE_NAMES,
): Promise<RepertoireResult> =>
  generateRepertoire(db, engine, explorer, cacheDir, clock, names, options);

const rowsOf = (database: Database): RepertoireTestRow[] =>
  database
    .prepare("SELECT * FROM repertoire_positions ORDER BY ply, kind, position_key, move_uci")
    .all() as RepertoireTestRow[];

const ownAt = (line: string[]): RepertoireTestRow | undefined =>
  rowsOf(db).find((row) => row.kind === "own" && row.position_key === keyOf(line));

const replyAt = (line: string[], san: string): RepertoireTestRow | undefined =>
  rowsOf(db).find(
    (row) => row.kind === "reply" && row.position_key === keyOf(line) && row.move_san === san,
  );

const variationsOf = (database: Database) =>
  database.prepare("SELECT side, group_name, variation_name FROM repertoires").all();

/** The key of the position a stored move leads to, which is where the next move is stored. */
function keyAfterStoredMove(row: RepertoireTestRow): string {
  const game = new Chess(`${row.position_key} 0 1`);
  applyUci(game, row.move_uci);
  return positionKey(game.fen());
}

/** The replies the coverage screen would list as gaps no run can fill: none has a White move after it. */
function repliesWithoutWhiteAnswer(rows: RepertoireTestRow[]): string[] {
  const answered = new Set(rows.filter((row) => row.kind === "own").map((row) => row.position_key));
  return rows
    .filter((row) => row.kind === "reply" && !answered.has(keyAfterStoredMove(row)))
    .map((row) => `${row.move_san} at ply ${row.ply}`);
}

/**
 * The reply an earlier run stored after every White move at ply 29: Black's 15th move, with no
 * White move after it. Returns how many it stored.
 */
function storeRepliesAtOldLimit(): number {
  const variation = findFirstRepertoireVariation(db, "white", "Italian Game");
  if (!variation) throw new Error("no variation is stored");
  const lineEnds = rowsOf(db).filter((row) => row.kind === "own" && row.ply === 29);
  for (const end of lineEnds) {
    const key = keyAfterStoredMove(end);
    const reply = forwardMove(`${key} 0 1`);
    if (!reply) throw new Error(`Black has no reply after ${end.move_san}`);
    upsertRepertoireReply(db, {
      repertoireId: variation.id,
      positionKey: key,
      ply: 30,
      line: [...(JSON.parse(end.line_san) as string[]), end.move_san],
      reach: end.reach,
      openingName: end.opening_name,
      uci: `${reply.from}${reply.to}${reply.promotion ?? ""}`,
      san: reply.san,
      share: 1,
      source: "explorer",
    });
  }
  return lineEnds.length;
}

/** The shares of 3.Bc4 and of 3...Bc5 at 1800 to 2499 are the ones measured on 2026-11-09. */
function writeItalianTree(): void {
  explorer
    .write([], ITALIAN_WHITE_RATINGS, { e4: 5000 }, 10000)
    .write(["e4"], EXPLORER_RATINGS, { e5: 62500, c5: 20000 }, 100000)
    .write(["e4", "e5"], ITALIAN_WHITE_RATINGS, { Nf3: 8000 }, 10000)
    .write(["e4", "e5", "Nf3"], EXPLORER_RATINGS, { Nc6: 50600, d6: 9000 }, 100000)
    .write(BEFORE_BC4, ITALIAN_WHITE_RATINGS, { Bc4: 6000, Bb5: 3000 }, 10000)
    .write(
      SETUP,
      EXPLORER_RATINGS,
      {
        Nf6: 40200,
        Bc5: 22600,
        h6: 8700,
        d6: 7400,
        Nd4: 3700,
        f6: 3000,
        Nh6: 2200,
        a6: 1700,
      },
      100000,
    )
    .write(AFTER_BC5, ITALIAN_WHITE_RATINGS, { c3: 3410, "O-O": 2650, d3: 1380, b4: 1130 }, 10000)
    // Read by nobody: if the student's band chose White's move, the answer would be 4.d3.
    .write(AFTER_BC5, EXPLORER_RATINGS, { d3: 9000, c3: 100 }, 10000)
    .write(AFTER_C3, EXPLORER_RATINGS, { Nf6: 3000, d6: 250 }, 5000)
    .write([...AFTER_C3, "Nf6"], ITALIAN_WHITE_RATINGS, { d4: 6000 }, 8000)
    .write([...AFTER_C3, "Nf6", "d4"], EXPLORER_RATINGS, { exd4: 1000 }, 2000)
    .write([...AFTER_C3, "Nf6", "d4", "exd4"], ITALIAN_WHITE_RATINGS, { cxd4: 5000 }, 6000)
    .write([...SETUP, "Nf6"], ITALIAN_WHITE_RATINGS, { d3: 5000, Ng5: 2000 }, 8000)
    .write([...SETUP, "Nf6", "d3"], EXPLORER_RATINGS, { Be7: 2500 }, 5000);
  engine
    .write([], [["e2e4", 30]])
    .write(["e4", "e5"], [["g1f3", 30]])
    .write(BEFORE_BC4, [
      ["f1b5", 40],
      ["f1c4", 30],
    ])
    .write(AFTER_BC5, [
      ["e1g1", 40],
      ["c2c3", 30],
      ["d2d3", 20],
      ["b2b4", 0],
    ])
    .write([...AFTER_C3, "Nf6"], [["d2d4", 35]])
    .write([...AFTER_C3, "Nf6", "d4", "exd4"], [["c3d4", 45]])
    .write(
      [...SETUP, "Nf6"],
      [
        ["d2d3", 25],
        ["f3g5", 20],
      ],
    );
}

// 6.cxd4 is reached at 6.78% of the games and the biggest reply to it holds 7.5% of those: under
// 1 in 50, so the branching rule ends the line there although the position has thousands of games.
function writeSpreadAfterCxd4(): void {
  explorer.write(
    AFTER_CXD4,
    EXPLORER_RATINGS,
    { "Bb4+": 600, Nxd4: 500, Nxe4: 450, d5: 300, "O-O": 250 },
    8000,
  );
}

const AFTER_BE7 = [...SETUP, "Nf6", "d3", "Be7"];
const AFTER_A3 = [...AFTER_BE7, "a3"];
const MEETING = [...SETUP, "Nf6", "d3", "Bc5"];

// 3...Nf6 4.d3 Bc5 and 3...Bc5 4.d3 Nf6 meet in one position. The first way is the likelier one and
// is kept by the branching rule, replies included; the second has too few games to name a reply, so
// it is a line end whose continuation, the engine's 4...Nf6, leads into the meeting position.
function writeTranspositionIntoLineEnd(): void {
  explorer
    .write(SETUP, EXPLORER_RATINGS, { Nf6: 40000, Bc5: 30000 }, 100000)
    .write(AFTER_BC5, ITALIAN_WHITE_RATINGS, { d3: 9000 }, 10000)
    .write([...SETUP, "Nf6", "d3"], EXPLORER_RATINGS, { Bc5: 4000, Be7: 800 }, 5000)
    .write([...AFTER_BC5, "d3"], EXPLORER_RATINGS, { Nf6: 100 }, 150)
    .write([...MEETING, "a3"], EXPLORER_RATINGS, { a6: 1500, d6: 1000 }, 5000);
  engine
    .write(AFTER_BC5, [["d2d3", 40]])
    .write([...AFTER_BC5, "d3"], [["g8f6", 10]])
    .write(AFTER_BE7, [["a2a3", 20]])
    .write(MEETING, [["a2a3", 20]]);
}

// 5.a3 is reached at 6.4% of the games and the biggest reply holds 7.5% of those: a line end with
// thousands of games, where the continuation takes the most played reply.
function writeSpreadAfterA3(): void {
  explorer.write(
    AFTER_A3,
    EXPLORER_RATINGS,
    { d6: 600, h6: 500, "O-O": 450, a6: 300, d5: 250 },
    8000,
  );
}

// Legal's mate: after 7.Nd5# Black has no legal reply. 7...Ke7 holds 1.6% of the games, so the
// branching rule ends the line one move before the mate.
const LEGAL_MATE = [...SETUP, "d6", "Nc3", "Bg4", "Nxe5", "Bxd1", "Bxf7+", "Ke7", "Nd5#"];

function writeLegalMate(): void {
  const lineTo = (plies: number) => LEGAL_MATE.slice(0, SETUP.length + plies);
  explorer
    .write(lineTo(2), EXPLORER_RATINGS, { Bg4: 3000 }, 5000)
    .write(lineTo(4), EXPLORER_RATINGS, { Bxd1: 3000 }, 5000)
    .write(lineTo(6), EXPLORER_RATINGS, { Ke7: 3000 }, 5000);
  engine
    .write(lineTo(1), [["b1c3", 20]])
    .write(lineTo(3), [["f3e5", 20]])
    .write(lineTo(5), [["c4f7", 20]])
    .write(lineTo(7), [["c3d5", 20]]);
}

const lineOf = (row: RepertoireTestRow): string[] => JSON.parse(row.line_san) as string[];

/** The rows on or below a line: the reply to it, White's answer, and everything after. */
const rowsAfter = (line: string[]): RepertoireTestRow[] =>
  rowsOf(db).filter((row) => line.every((san, index) => lineOf(row)[index] === san));

const digestOf = (rows: RepertoireTestRow[]): string =>
  createHash("sha256").update(JSON.stringify(rows)).digest("hex");

const repliesAt = (line: string[]): RepertoireTestRow[] =>
  rowsOf(db).filter((row) => row.kind === "reply" && row.position_key === keyOf(line));

describe("the repertoire tables", () => {
  const newOwnMove = (repertoireId: number, positionKeyText: string, uci: string) => ({
    repertoireId,
    positionKey: positionKeyText,
    ply: 7,
    line: AFTER_BC5,
    reach: 0.2,
    openingName: null,
    uci,
    san: uci,
    share: null,
    source: "explorer" as const,
    cpLoss: 10,
    evalCp: 25,
    results: null,
  });

  it("has the columns the drill and the statistics read", () => {
    const columnsOf = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
    expect(columnsOf("repertoires")).toEqual(["id", "side", "group_name", "variation_name"]);
    expect(columnsOf("repertoire_positions")).toEqual([
      "id",
      "repertoire_id",
      "kind",
      "position_key",
      "ply",
      "line_san",
      "move_uci",
      "move_san",
      "share",
      "reach",
      "opening_name",
      "idea",
      "source",
      "cp_loss",
      "eval_cp",
      "wins",
      "draws",
      "losses",
    ]);
  });

  it("allows one expected White move per repertoire and position", () => {
    const first = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "A",
    });
    const second = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "B",
    });
    insertRepertoireOwnMove(db, newOwnMove(first.id, "position", "c2c3"));
    expect(() => insertRepertoireOwnMove(db, newOwnMove(first.id, "position", "d2d3"))).toThrow(
      /UNIQUE/,
    );
    // Another variation may expect another move in the same position.
    insertRepertoireOwnMove(db, newOwnMove(second.id, "position", "d2d3"));
    expect(rowsOf(db)).toHaveLength(2);
  });

  it("allows many replies in one position, each stored once", () => {
    const repertoire = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "A",
    });
    const reply = (uci: string) => ({
      repertoireId: repertoire.id,
      positionKey: "position",
      ply: 8,
      line: AFTER_C3,
      reach: 0.1,
      openingName: null,
      uci,
      san: uci,
      share: 0.5,
      source: "explorer" as const,
    });
    upsertRepertoireReply(db, reply("g8f6"));
    upsertRepertoireReply(db, reply("g8f6"));
    upsertRepertoireReply(db, reply("d7d6"));
    expect(rowsOf(db).map((row) => row.move_uci)).toEqual(["d7d6", "g8f6"]);
  });

  const italianVariation = (variationName: string) =>
    createRepertoireVariation(db, { side: "white", groupName: "Italian Game", variationName });

  const insertRawPosition = (
    repertoireId: number,
    kind: string,
    cpLoss: number | null,
    evalCp: number | null,
  ) =>
    db
      .prepare(
        `INSERT INTO repertoire_positions
           (repertoire_id, kind, position_key, ply, line_san, move_uci, move_san, reach, source,
            cp_loss, eval_cp)
         VALUES (?, ?, 'position', 7, '[]', 'c2c3', 'c3', 0.2, 'explorer', ?, ?)`,
      )
      .run(repertoireId, kind, cpLoss, evalCp);

  it("refuses a row whose kind is neither own nor reply", () => {
    const { id } = italianVariation("A");
    expect(() => insertRawPosition(id, "drill", 10, 25)).toThrow(/CHECK/);
    insertRawPosition(id, "own", 10, 25);
    expect(rowsOf(db).map((row) => row.kind)).toEqual(["own"]);
  });

  it("refuses a variation whose side is neither white nor black", () => {
    const insert = db.prepare(
      "INSERT INTO repertoires (side, group_name, variation_name) VALUES (?, 'Italian Game', 'A')",
    );
    expect(() => insert.run("both")).toThrow(/CHECK/);
    insert.run("black");
    expect(variationsOf(db)).toEqual([
      { side: "black", group_name: "Italian Game", variation_name: "A" },
    ]);
  });

  it.each([
    { missing: "centipawn loss", cpLoss: null, evalCp: 25 },
    { missing: "evaluation", cpLoss: 10, evalCp: null },
  ])(
    "refuses a White move without its $missing and allows a reply without either",
    ({ cpLoss, evalCp }) => {
      const { id } = italianVariation("A");
      expect(() => insertRawPosition(id, "own", cpLoss, evalCp)).toThrow(/CHECK/);
      insertRawPosition(id, "reply", null, null);
      expect(rowsOf(db).map((row) => row.kind)).toEqual(["reply"]);
    },
  );

  it("allows one variation of a name per side and group", () => {
    italianVariation("Classical Variation (4.c3)");
    expect(() => italianVariation("Classical Variation (4.c3)")).toThrow(/UNIQUE/);
    const sameName = { variationName: "Classical Variation (4.c3)" };
    createRepertoireVariation(db, { ...sameName, side: "black", groupName: "Italian Game" });
    createRepertoireVariation(db, { ...sameName, side: "white", groupName: "Ruy Lopez" });
    expect(variationsOf(db)).toHaveLength(3);
  });

  it("deletes a variation's positions with the variation", () => {
    const kept = italianVariation("A");
    const deleted = italianVariation("B");
    insertRepertoireOwnMove(db, newOwnMove(kept.id, "position", "c2c3"));
    insertRepertoireOwnMove(db, newOwnMove(deleted.id, "position", "d2d3"));
    db.prepare("DELETE FROM repertoires WHERE id = ?").run(deleted.id);
    expect(rowsOf(db).map((row) => row.repertoire_id)).toEqual([kept.id]);
  });

  it("finds the oldest variation of the side and group", () => {
    createRepertoireVariation(db, {
      side: "black",
      groupName: "Italian Game",
      variationName: "As Black",
    });
    createRepertoireVariation(db, {
      side: "white",
      groupName: "Ruy Lopez",
      variationName: "Another group",
    });
    const oldest = italianVariation("Oldest");
    italianVariation("Newest");
    expect(findFirstRepertoireVariation(db, "white", "Italian Game")).toEqual(oldest);
  });

  describe("a position stored from two lines", () => {
    const likelier = { ply: 9, line: ["likelier"], reach: 0.24, openingName: "Likelier name" };
    const rarer = { ply: 11, line: ["rarer"], reach: 0.1, openingName: "Rarer name" };
    const arrivals = [
      { order: "the likelier line first", first: likelier, second: rarer },
      { order: "the likelier line second", first: rarer, second: likelier },
    ];
    const placeOf = (row: RepertoireTestRow) => ({
      ply: row.ply,
      line: JSON.parse(row.line_san),
      reach: row.reach,
      openingName: row.opening_name,
    });

    it.each(arrivals)("keeps a reply on the likelier line, $order", ({ first, second }) => {
      const { id } = italianVariation("A");
      const reply = (place: typeof likelier) => ({
        repertoireId: id,
        positionKey: "position",
        ...place,
        uci: "g8f6",
        san: "Nf6",
        share: 0.5,
        source: "explorer" as const,
      });
      upsertRepertoireReply(db, reply(first));
      upsertRepertoireReply(db, reply(second));
      expect(rowsOf(db).map(placeOf)).toEqual([likelier]);
    });

    it.each(arrivals)(
      "keeps a White move and its scores on the likelier line, $order",
      ({ first, second }) => {
        const { id } = italianVariation("A");
        insertRepertoireOwnMove(db, {
          ...newOwnMove(id, "position", "c2c3"),
          ...first,
          results: { wins: 5, draws: 1, losses: 4 },
        });
        const stored = rowsOf(db)[0];
        if (!stored) throw new Error("the White move was not stored");
        raiseRepertoireOwnMoveReach(db, stored.id, {
          repertoireId: id,
          positionKey: "position",
          ...second,
        });
        expect(rowsOf(db).map(placeOf)).toEqual([likelier]);
        expect(rowsOf(db)[0]).toMatchObject({
          move_uci: "c2c3",
          cp_loss: 10,
          eval_cp: 25,
          wins: 5,
          draws: 1,
          losses: 4,
        });
      },
    );
  });
});

describe("generateRepertoire", () => {
  it("answers 3...Bc5 with 4.c3 from the White band's numbers and keeps a 3...Nf6 branch", async () => {
    writeItalianTree();
    await generate();
    expect(ownAt(AFTER_BC5)).toMatchObject({
      move_san: "c3",
      move_uci: "c2c3",
      source: "explorer",
    });
    expect(ownAt(AFTER_BC5)?.share).toBeCloseTo(0.341);
    expect(replyAt(SETUP, "Nf6")).toBeDefined();
    expect(ownAt([...SETUP, "Nf6"])).toMatchObject({ move_san: "d3" });
  });

  it("stores the fixed setup from move 1 at reach 1", async () => {
    writeItalianTree();
    await generate();
    const setup = rowsOf(db).filter((row) => row.ply <= 5);
    expect(setup.map((row) => row.move_san)).toEqual(SETUP);
    expect(setup.map((row) => row.kind)).toEqual(["own", "reply", "own", "reply", "own"]);
    for (const row of setup) expect(row).toMatchObject({ reach: 1, source: "setup" });
    expect(JSON.parse(ownAt([])?.line_san ?? "null")).toEqual([]);
    expect(JSON.parse(replyAt(["e4"], "e5")?.line_san ?? "null")).toEqual(["e4"]);
    expect(replyAt(["e4"], "e5")?.share).toBeCloseTo(0.625);
  });

  it("keeps every reply reaching 1 in 50 since 3.Bc4 and none below it", async () => {
    writeItalianTree();
    await generate();
    const replies = rowsOf(db)
      .filter((row) => row.kind === "reply" && row.position_key === keyOf(SETUP))
      .map((row) => row.move_san)
      .sort();
    expect(replies).toEqual(["Bc5", "Nd4", "Nf6", "Nh6", "d6", "f6", "h6"]);
  });

  it("keeps a reply at exactly 1 in 50 and drops one just under", async () => {
    writeItalianTree();
    explorer.write(SETUP, EXPLORER_RATINGS, { Bc5: 60000, f6: 2000, a6: 1999 }, 100000);
    await generate();
    expect(replyAt(SETUP, "f6")?.reach).toBeCloseTo(0.02, 10);
    expect(replyAt(SETUP, "a6")).toBeUndefined();
  });

  it("drops a reply under the floor of 200 games even when its reach clears 1 in 50", async () => {
    writeItalianTree();
    explorer.write(SETUP, EXPLORER_RATINGS, { Bc5: 500, Nf6: 200, h6: 199 }, 1000);
    await generate();
    expect(replyAt(SETUP, "Nf6")).toBeDefined();
    expect(replyAt(SETUP, "h6")).toBeUndefined();
  });

  it("multiplies Black's shares along the line", async () => {
    writeItalianTree();
    await generate();
    // 3...Bc5 holds 22.6%, and 4...d6 is 5% of that: it would clear the goal only at the root.
    expect(replyAt(AFTER_C3, "d6")).toBeUndefined();
    expect(replyAt(AFTER_C3, "Nf6")?.reach).toBeCloseTo(0.226 * 0.6);
    expect(ownAt([...AFTER_C3, "Nf6"])?.reach).toBeCloseTo(0.226 * 0.6);
    expect(replyAt([...AFTER_C3, "Nf6", "d4"], "exd4")?.reach).toBeCloseTo(0.226 * 0.6 * 0.5);
  });

  // Black's 15th move sits at ply 30 and White has no 16th move stored, so a reply there would be
  // a gap the coverage screen lists forever. The forward moves never repeat a position, so every
  // line of these trees runs into the limit.
  it.each([
    { tree: "a single line", write: () => {}, autoplay: true },
    {
      tree: "the Italian tree with every branch running on",
      write: writeItalianTree,
      autoplay: true,
    },
    {
      tree: "a line the branching rule ends, continued by the explorer",
      write: () => {
        writeItalianTree();
        writeSpreadAfterCxd4();
      },
      autoplay: true,
    },
    {
      tree: "the Italian tree with every line continued by the engine",
      write: writeItalianTree,
      autoplay: false,
    },
  ])("ends every line on White's 15th move: $tree", async ({ write, autoplay }) => {
    write();
    explorer.autoplay = autoplay;
    const result = await generate();
    const stored = rowsOf(db);
    const deepestOf = (kind: RepertoireTestRow["kind"]): number =>
      Math.max(...stored.filter((row) => row.kind === kind).map((row) => row.ply));
    expect(REPERTOIRE_MAX_PLY).toBe(30);
    expect(deepestOf("reply")).toBe(28);
    expect(deepestOf("own")).toBe(29);
    expect(result.deepestPly).toBe(29);
    expect(repliesWithoutWhiteAnswer(stored)).toEqual([]);
  });

  it("reads Black's replies in the student's band and White's moves in the White band", async () => {
    writeItalianTree();
    await generate();
    const bandsAt = (line: string[]) =>
      new Set(
        explorer.calls.filter((call) => call.key === keyOf(line)).map((call) => call.ratings),
      );
    expect(bandsAt(SETUP)).toEqual(new Set([EXPLORER_RATINGS]));
    expect(bandsAt(AFTER_BC5)).toEqual(new Set([ITALIAN_WHITE_RATINGS]));
  });

  it("stores the group name and the variation named after White's answer to 3...Bc5", async () => {
    writeItalianTree();
    const result = await generate();
    expect(result.variation).toBe("Classical Variation (4.c3)");
    expect(variationsOf(db)).toEqual([
      { side: "white", group_name: "Italian Game", variation_name: "Classical Variation (4.c3)" },
    ]);
  });

  it("names the variation after the group when the book has no name for the line", async () => {
    writeItalianTree();
    await generate({}, NO_OPENING_NAMES);
    expect(variationsOf(db)).toMatchObject([{ variation_name: "Italian Game (4.c3)" }]);
  });

  it("stores each position's opening name from the last named position on its line", async () => {
    writeItalianTree();
    await generate();
    expect(ownAt([])?.opening_name).toBeNull();
    expect(ownAt(AFTER_BC5)?.opening_name).toBe("Italian Game: Giuoco Piano");
    expect(replyAt(AFTER_C3, "Nf6")?.opening_name).toBe("Italian Game: Classical Variation");
    expect(ownAt([...AFTER_C3, "Nf6"])?.opening_name).toBe("Italian Game: Classical Variation");
    expect(rowsOf(db).every((row) => row.idea === null)).toBe(true);
  });

  it("gives every White move a centipawn loss against the engine's best move", async () => {
    writeItalianTree();
    await generate();
    for (const row of rowsOf(db).filter((row) => row.kind === "own")) {
      expect(row.cp_loss).toEqual(expect.any(Number));
      expect(row.eval_cp).toEqual(expect.any(Number));
    }
    expect(ownAt(BEFORE_BC4)?.cp_loss).toBe(10);
    expect(ownAt(AFTER_BC5)?.cp_loss).toBe(10);
    expect(ownAt([...AFTER_C3, "Nf6"])?.cp_loss).toBe(0);
  });

  it("scores a setup move outside the engine's top lines from the position after it", async () => {
    writeItalianTree();
    engine.write(BEFORE_BC4, [["f1b5", 40]]).write(SETUP, [["g8f6", 15]]);
    await generate();
    expect(ownAt(BEFORE_BC4)?.cp_loss).toBe(55);
  });

  it("stores the score of the chosen move's own line as the evaluation after it", async () => {
    writeItalianTree();
    await generate();
    // 4.O-O is best at 40 and 4.c3 is chosen at 30: the row keeps the score of 4.c3.
    expect(ownAt(AFTER_BC5)).toMatchObject({ move_san: "c3", cp_loss: 10, eval_cp: 30 });
    for (const row of rowsOf(db).filter((candidate) => candidate.kind === "reply")) {
      expect(row.eval_cp).toBeNull();
    }
  });

  it("keeps an evaluation below zero when White's chosen move leaves Black better", async () => {
    writeItalianTree();
    engine.write(AFTER_BC5, [
      ["e1g1", -20],
      ["c2c3", -35],
    ]);
    await generate();
    expect(ownAt(AFTER_BC5)).toMatchObject({ move_san: "c3", cp_loss: 15, eval_cp: -35 });
  });

  it.each([
    { label: "White mating", score: 10000 },
    { label: "White being mated", score: -10000 },
  ])(
    "stores a mate in the chosen move's line as 10000 with its sign: $label",
    async ({ score }) => {
      writeItalianTree();
      engine.write(AFTER_BC5, [["c2c3", score]]);
      await generate();
      expect(ownAt(AFTER_BC5)).toMatchObject({ move_san: "c3", cp_loss: 0, eval_cp: score });
    },
  );

  it.each([
    { label: "Black better", replyScore: 60, evalCp: -60, cpLoss: 100 },
    { label: "White better", replyScore: -25, evalCp: 25, cpLoss: 15 },
    { label: "Black mated", replyScore: -10000, evalCp: 10000, cpLoss: 0 },
    { label: "White mated", replyScore: 10000, evalCp: -10000, cpLoss: 10040 },
  ])(
    "reads a setup move outside the top lines from White's side: $label",
    async ({ replyScore, evalCp, cpLoss }) => {
      writeItalianTree();
      engine.write(BEFORE_BC4, [["f1b5", 40]]).write(SETUP, [["g8f6", replyScore]]);
      await generate();
      expect(ownAt(BEFORE_BC4)).toMatchObject({
        move_san: "Bc4",
        cp_loss: cpLoss,
        eval_cp: evalCp,
      });
    },
  );

  it("searches every White position at depth 16 for five lines within 30 s", async () => {
    writeItalianTree();
    await generate();
    const whiteSearches = engine.requests.filter((request) => request.fen.split(" ")[1] === "w");
    expect(whiteSearches.length).toBeGreaterThan(0);
    for (const request of whiteSearches) {
      expect(request).toMatchObject({ depth: 16, multipv: 5, deadlineMs: 30_000 });
    }
  });

  it("searches every reply of its own at depth 16 for one line within 30 s", async () => {
    writeItalianTree();
    await generate();
    const replySearches = engine.requests.filter((request) => request.fen.split(" ")[1] === "b");
    expect(replySearches.length).toBeGreaterThan(0);
    for (const request of replySearches) {
      expect(request).toMatchObject({ depth: 16, multipv: 1, deadlineMs: 30_000 });
    }
  });

  it("scores a setup move outside the top lines at depth 16 within 30 s as well", async () => {
    writeItalianTree();
    engine.write(BEFORE_BC4, [["f1b5", 40]]).write(SETUP, [["g8f6", 15]]);
    await generate();
    const reply = engine.requests.find((request) => positionKey(request.fen) === keyOf(SETUP));
    expect(reply).toMatchObject({ depth: 16, multipv: 1, deadlineMs: 30_000 });
  });

  it("stores result counts for every White move whose next position has games", async () => {
    writeItalianTree();
    await generate();
    expect(ownAt(AFTER_BC5)).toMatchObject({ wins: 2500, draws: 200, losses: 2300 });
    expect(ownAt([...AFTER_C3, "Nf6", "d4", "exd4"])).toMatchObject({
      wins: null,
      draws: null,
      losses: null,
    });
    for (const row of rowsOf(db).filter((candidate) => candidate.kind === "own")) {
      const game = new Chess(`${row.position_key} 0 1`);
      applyUci(game, row.move_uci);
      const games = explorer.gamesWrittenAt(positionKey(game.fen()), EXPLORER_RATINGS);
      expect(row.wins !== null, `${row.move_san} after ${row.line_san}`).toBe(games > 0);
    }
  });

  it("stores the counts of the position after White's move even at the ply limit", async () => {
    writeItalianTree();
    await generate({ maxPly: 5 });
    expect(rowsOf(db).filter((row) => row.ply > 5)).toEqual([]);
    expect(ownAt(BEFORE_BC4)).toMatchObject({
      move_san: "Bc4",
      wins: 50000,
      draws: 4000,
      losses: 46000,
    });
  });

  it("adds no row on a second run and asks neither the network nor the engine", async () => {
    writeItalianTree();
    const first = await generate();
    const stored = rowsOf(db);
    const searches = engine.requests.length;
    const second = await generate();
    expect(first.created).toBe(stored.length);
    expect(first.removedReplies).toBe(0);
    expect(second).toMatchObject({
      created: 0,
      removedReplies: 0,
      requests: 0,
      truncated: false,
      ownMoves: first.ownMoves,
      replies: first.replies,
      deepestPly: first.deepestPly,
    });
    expect(second.cacheHits).toBeGreaterThan(0);
    expect(engine.requests).toHaveLength(searches);
    expect(rowsOf(db)).toEqual(stored);
    expect(variationsOf(db)).toHaveLength(1);
  });

  it("keeps a stored expected move when the data would now choose another", async () => {
    writeItalianTree();
    await generate();
    rmSync(cacheDir, { recursive: true, force: true });
    explorer.write(AFTER_BC5, ITALIAN_WHITE_RATINGS, { d3: 9000 }, 10000);
    engine.write(AFTER_BC5, [["d2d3", 50]]);
    const second = await generate();
    expect(second.created).toBe(0);
    expect(ownAt(AFTER_BC5)?.move_san).toBe("c3");
    expect(variationsOf(db)).toMatchObject([{ variation_name: "Classical Variation (4.c3)" }]);
  });

  it("resumes a run the request budget cut short and ends like an uninterrupted one", async () => {
    writeItalianTree();
    const cut = await generate({ maxRequests: 9 });
    expect(cut.truncated).toBe(true);
    expect(cut.created).toBeGreaterThan(0);
    const resumed = await generate();
    expect(resumed.truncated).toBe(false);
    const cleanDir = mkdtempSync(join(tmpdir(), "cc-repertoire-clean-"));
    const cleanDb = openDatabase(cleanDir);
    await generateRepertoire(
      cleanDb,
      engine,
      explorer,
      join(cleanDir, "explorer-cache"),
      clock,
      ITALIAN_FIXTURE_NAMES,
    );
    const comparable = (rows: RepertoireTestRow[]) =>
      rows.map(({ id: _id, repertoire_id: _repertoire, ...row }) => row);
    expect(comparable(rowsOf(db))).toEqual(comparable(rowsOf(cleanDb)));
    cleanDb.close();
    rmSync(cleanDir, { recursive: true, force: true });
  });

  it("stores nothing and says so when the budget ends before the variation has a name", async () => {
    writeItalianTree();
    const result = await generate({ maxRequests: 0 });
    expect(result).toMatchObject({
      variation: null,
      ownMoves: 0,
      replies: 0,
      deepestPly: 0,
      created: 0,
      truncated: true,
    });
    expect(variationsOf(db)).toEqual([]);
  });

  it("keeps one row per transposed position, on its likeliest line", async () => {
    writeItalianTree();
    // 3...Nf6 4.d3 Bc5 and 3...Bc5 4.d3 Nf6 meet in one position, the second one at higher reach.
    explorer
      .write(SETUP, EXPLORER_RATINGS, { Nf6: 40000, Bc5: 30000 }, 100000)
      .write(AFTER_BC5, ITALIAN_WHITE_RATINGS, { d3: 9000 }, 10000)
      .write([...SETUP, "Nf6", "d3"], EXPLORER_RATINGS, { Bc5: 1250 }, 5000)
      .write([...AFTER_BC5, "d3"], EXPLORER_RATINGS, { Nf6: 4000 }, 5000);
    engine.write(AFTER_BC5, [["d2d3", 40]]);
    await generate();
    const transposed = [...SETUP, "Nf6", "d3", "Bc5"];
    const own = rowsOf(db).filter(
      (row) => row.kind === "own" && row.position_key === keyOf(transposed),
    );
    expect(own).toHaveLength(1);
    expect(own[0]?.reach).toBeCloseTo(0.3 * 0.8);
    expect(JSON.parse(own[0]?.line_san ?? "null")).toEqual([...SETUP, "Bc5", "d3", "Nf6"]);
  });

  it("labels an engine move and an explorer reply by where they came from", async () => {
    writeItalianTree();
    await generate();
    // Nobody wrote the White band after 3...h6, so the engine's move is the expected one.
    expect(ownAt([...SETUP, "h6"])).toMatchObject({ source: "engine", share: null });
    expect(replyAt(SETUP, "Nf6")).toMatchObject({ source: "explorer" });
    expect(replyAt(SETUP, "Nf6")?.share).toBeCloseTo(0.402);
  });

  it("clamps the loss at zero when a setup move outside the top lines scores above the best", async () => {
    writeItalianTree();
    engine.write(BEFORE_BC4, [["f1b5", 40]]).write(SETUP, [["g8f6", -60]]);
    await generate();
    expect(ownAt(BEFORE_BC4)).toMatchObject({ move_san: "Bc4", cp_loss: 0, eval_cp: 60 });
  });

  // 3...Nd4 4.Nxe5 Qg5 5.Nxf7 Qxg2 6.Rf1 Qxe4+ 7.Be2 Nf3# leaves White mated, with no move to store.
  const MATED = [...SETUP, "Nd4", "Nxe5", "Qg5", "Nxf7", "Qxg2", "Rf1", "Qxe4+", "Be2", "Nf3#"];

  function writeMatingLine(): void {
    const lineTo = (plies: number) => MATED.slice(0, SETUP.length + plies);
    engine
      .write(lineTo(1), [["f3e5", 20]])
      .write(lineTo(3), [["e5f7", 20]])
      .write(lineTo(5), [["h1f1", 20]])
      .write(lineTo(7), [["c4e2", 20]]);
    explorer
      .write(lineTo(2), EXPLORER_RATINGS, { Qg5: 3000 }, 5000)
      .write(lineTo(4), EXPLORER_RATINGS, { Qxg2: 5000 }, 5000)
      .write(lineTo(6), EXPLORER_RATINGS, { "Qxe4+": 5000 }, 5000)
      .write(lineTo(8), EXPLORER_RATINGS, { "Nf3#": 5000 }, 5000);
  }

  it.each([
    { answer: "the engine gives no line", stockfishShape: false },
    { answer: "Stockfish gives a moveless line", stockfishShape: true },
  ])("ends a line where White is mated with no row: $answer", async ({ stockfishShape }) => {
    writeItalianTree();
    writeMatingLine();
    if (stockfishShape) engine.writeMated(MATED);
    await generate();
    expect(new Chess(fenOf(MATED)).isCheckmate()).toBe(true);
    expect(replyAt(MATED.slice(0, -1), "Nf3#")).toBeDefined();
    expect(ownAt(MATED)).toBeUndefined();
  });

  it.each([
    ["a 401", new ExplorerError("unauthorized", "the explorer wants a Lichess API token")],
    ["an upstream error", new ExplorerError("upstream", "the explorer answered 500")],
  ])("rejects on %s instead of reporting a truncated run", async (_label, failure) => {
    writeItalianTree();
    explorer.failAt(AFTER_C3, EXPLORER_RATINGS, failure);
    await expect(generate()).rejects.toBe(failure);
    expect(rowsOf(db).length).toBeGreaterThan(0);
  });

  it("reports zero counts when the budget ends right after the variation is named", async () => {
    writeItalianTree();
    const result = await generate({ maxRequests: 1 });
    expect(result).toMatchObject({
      variation: "Classical Variation (4.c3)",
      ownMoves: 0,
      replies: 0,
      deepestPly: 0,
      created: 0,
      truncated: true,
    });
    expect(rowsOf(db)).toEqual([]);
  });

  it("walks the oldest Italian variation when the group already holds several", async () => {
    writeItalianTree();
    const oldest = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "Oldest",
    });
    createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "Newest",
    });
    const result = await generate();
    expect(result.variation).toBe("Oldest");
    expect(new Set(rowsOf(db).map((row) => row.repertoire_id))).toEqual(new Set([oldest.id]));
  });
});

describe("a line the branching rule ends", () => {
  it("continues with the reply most played at the student's band, marked mainline", async () => {
    writeItalianTree();
    writeSpreadAfterCxd4();
    // The engine would play 6...d5: the stored reply has to come from the explorer's numbers.
    engine.write(AFTER_CXD4, [
      ["d7d5", 50],
      ["c5b4", 0],
    ]);
    await generate();
    expect(repliesAt(AFTER_CXD4).map((row) => row.move_san)).toEqual(["Bb4+"]);
    const reply = replyAt(AFTER_CXD4, "Bb4+");
    expect(reply).toMatchObject({ ply: 12, source: "mainline" });
    expect(reply?.share).toBeCloseTo(0.075, 8);
    expect(reply?.reach).toBeCloseTo(0.226 * 0.6 * 0.5 * 0.075, 8);
    expect(ownAt([...AFTER_CXD4, "Bb4+"])).toMatchObject({ ply: 13 });
    const searched = engine.requests.some(
      (request) => positionKey(request.fen) === keyOf(AFTER_CXD4),
    );
    expect(searched).toBe(false);
  });

  it("goes on to White's 15th move, one reply and one answer at a time, all under the goal", async () => {
    writeItalianTree();
    writeSpreadAfterCxd4();
    explorer.autoplay = true;
    await generate();
    const chain = rowsAfter(AFTER_CXD4);
    const replies = chain.filter((row) => row.kind === "reply");
    const answers = chain.filter((row) => row.kind === "own");
    expect(replies.map((row) => row.ply)).toEqual([12, 14, 16, 18, 20, 22, 24, 26, 28]);
    expect(answers.map((row) => row.ply)).toEqual([13, 15, 17, 19, 21, 23, 25, 27, 29]);
    expect(new Set(replies.map((row) => row.source))).toEqual(new Set(["mainline"]));
    for (const row of chain) expect(row.reach).toBeLessThan(REPERTOIRE_MIN_REACH);
  });

  it.each([
    { games: 200, san: "Bb4+", source: "mainline", share: 0.3 },
    { games: 199, san: "d5", source: "engine", share: null },
  ])(
    "stores a $source reply for a position of $games games",
    async ({ games, san, source, share }) => {
      writeItalianTree();
      // 60 games is under the floor for a reply of its own, so the branching rule keeps nothing here.
      explorer.write(AFTER_CXD4, EXPLORER_RATINGS, { "Bb4+": 60 }, games);
      engine.write(AFTER_CXD4, [["d7d5", 30]]);
      await generate();
      const replies = repliesAt(AFTER_CXD4);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ move_san: san, source });
      expect(replies[0]?.share ?? null).toEqual(share === null ? null : expect.closeTo(share));
    },
  );

  it("stores the engine's best reply with no share and no reach where the explorer has too few games", async () => {
    writeItalianTree();
    explorer.write(AFTER_CXD4, EXPLORER_RATINGS, { "Bb4+": 100 }, 150);
    engine.write(AFTER_CXD4, [
      ["d7d5", 30],
      ["c5b4", 10],
    ]);
    await generate();
    expect(repliesAt(AFTER_CXD4).map((row) => row.move_san)).toEqual(["d5"]);
    expect(replyAt(AFTER_CXD4, "d5")).toMatchObject({
      ply: 12,
      source: "engine",
      share: null,
      reach: 0,
    });
    expect(ownAt([...AFTER_CXD4, "d5"])).toMatchObject({ ply: 13, reach: 0 });
  });

  it("stores nothing past the goal where another reply of the position passes it", async () => {
    writeItalianTree();
    writeSpreadAfterCxd4();
    await generate();
    // 4...d6 is under the goal but 4...Nf6 is not, so the line is not at its end.
    expect(repliesAt(AFTER_C3).map((row) => row.move_san)).toEqual(["Nf6"]);
    expect(repliesAt(AFTER_C3).map((row) => row.source)).toEqual(["explorer"]);
  });

  it("adds the continuation to rows stored without it and changes none of them", async () => {
    writeItalianTree();
    writeTranspositionIntoLineEnd();
    // With no move from the engine for Black and no games at the line ends, the walk stores
    // exactly what the branching rule alone stores.
    engine.blindToBlack = true;
    await generate();
    const earlier = rowsOf(db);
    const continued = (row: RepertoireTestRow): boolean =>
      row.kind === "reply" && (row.source === "mainline" || row.source === "engine");
    expect(earlier.some(continued)).toBe(false);
    expect(Math.min(...earlier.map((row) => row.reach))).toBeGreaterThanOrEqual(
      REPERTOIRE_MIN_REACH,
    );
    // Later the engine answers, and the explorer has games where it had none.
    engine.blindToBlack = false;
    writeSpreadAfterA3();
    rmSync(cacheDir, { recursive: true, force: true });
    const rerun = await generate();
    const kept = new Set(earlier.map((row) => row.id));
    const after = rowsOf(db);
    expect(digestOf(after.filter((row) => kept.has(row.id)))).toBe(digestOf(earlier));
    const added = after.filter((row) => !kept.has(row.id));
    expect(added.length).toBeGreaterThan(0);
    expect(rerun.created).toBe(added.length);
    expect(new Set(added.filter(continued).map((row) => row.source))).toEqual(
      new Set(["mainline", "engine"]),
    );
    expect(replyAt(AFTER_A3, "d6")).toMatchObject({ source: "mainline" });
    expect(rerun.deepestPly).toBe(29);
  });

  it("follows the reply already stored on a second run, whatever the data now says", async () => {
    writeItalianTree();
    writeSpreadAfterCxd4();
    await generate();
    const stored = rowsOf(db);
    const searches = engine.requests.length;
    rmSync(cacheDir, { recursive: true, force: true });
    explorer.write(AFTER_CXD4, EXPLORER_RATINGS, { Nxd4: 900, "Bb4+": 100 }, 8000);
    const second = await generate();
    expect(second.created).toBe(0);
    expect(engine.requests).toHaveLength(searches);
    expect(rowsOf(db)).toEqual(stored);
  });

  it.each([
    { answer: "the engine gives no line", stockfishShape: false },
    { answer: "Stockfish gives a moveless line", stockfishShape: true },
  ])("ends a line where Black is mated with no reply: $answer", async ({ stockfishShape }) => {
    writeItalianTree();
    writeLegalMate();
    if (stockfishShape) engine.writeMated(LEGAL_MATE);
    await generate();
    expect(new Chess(fenOf(LEGAL_MATE)).isCheckmate()).toBe(true);
    expect(replyAt(LEGAL_MATE.slice(0, -2), "Ke7")).toMatchObject({ source: "mainline" });
    expect(ownAt(LEGAL_MATE.slice(0, -1))).toMatchObject({ move_san: "Nd5#" });
    expect(repliesAt(LEGAL_MATE)).toEqual([]);
  });
});

describe("a position the walk reaches by two lines", () => {
  // 3...Nf6 4.d3 Bc5 and 3...Bc5 4.d3 Nf6 meet in one position. The walk takes 3...Nf6 first, being
  // the most played, and the shares after 4.d3 decide which line reaches the meeting likelier.
  const VIA_NF6 = [...SETUP, "Nf6", "d3", "Bc5"];
  const VIA_BC5 = [...SETUP, "Bc5", "d3", "Nf6"];

  function writeTransposition(bc5AfterNf6: number, nf6AfterBc5: number): void {
    writeItalianTree();
    explorer
      .write(SETUP, EXPLORER_RATINGS, { Nf6: 40000, Bc5: 30000 }, 100000)
      .write(AFTER_BC5, ITALIAN_WHITE_RATINGS, { d3: 9000 }, 10000)
      .write([...SETUP, "Nf6", "d3"], EXPLORER_RATINGS, { Bc5: bc5AfterNf6 }, 5000)
      .write([...AFTER_BC5, "d3"], EXPLORER_RATINGS, { Nf6: nf6AfterBc5 }, 5000)
      .write(VIA_NF6, ITALIAN_WHITE_RATINGS, { "O-O": 5000 }, 5000)
      .write([...VIA_NF6, "O-O"], EXPLORER_RATINGS, { d6: 3000 }, 5000);
    engine.write(AFTER_BC5, [["d2d3", 40]]).write(VIA_NF6, [["e1g1", 30]]);
  }

  it.each([
    {
      order: "the likelier line arriving second",
      bc5AfterNf6: 1250,
      nf6AfterBc5: 4000,
      line: VIA_BC5,
      reach: 0.3 * 0.8,
      openingName: "Italian Game: Giuoco Piano",
    },
    {
      order: "the likelier line arriving first",
      bc5AfterNf6: 4000,
      nf6AfterBc5: 1250,
      line: VIA_NF6,
      reach: 0.4 * 0.8,
      openingName: "Italian Game: Two Knights Defense",
    },
  ])(
    "moves the White move and the replies after it to the likelier line, $order",
    async ({ bc5AfterNf6, nf6AfterBc5, line, reach, openingName }) => {
      writeTransposition(bc5AfterNf6, nf6AfterBc5);
      await generate();
      const own = rowsOf(db).filter(
        (row) => row.kind === "own" && row.position_key === keyOf(VIA_NF6),
      );
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({ move_san: "O-O", ply: 9, opening_name: openingName });
      expect(own[0]?.reach).toBeCloseTo(reach);
      expect(JSON.parse(own[0]?.line_san ?? "null")).toEqual(line);
      const reply = replyAt([...VIA_NF6, "O-O"], "d6");
      expect(reply).toMatchObject({ ply: 10, opening_name: openingName });
      expect(reply?.reach).toBeCloseTo(reach * 0.6);
      expect(JSON.parse(reply?.line_san ?? "null")).toEqual([...line, "O-O"]);
    },
  );
});

describe("reply rows an earlier run left at ply 30", () => {
  async function walkAndLeaveRepliesAtOldLimit(): Promise<{
    walked: RepertoireTestRow[];
    left: number;
  }> {
    writeItalianTree();
    explorer.autoplay = true;
    await generate();
    const walked = rowsOf(db);
    const left = storeRepliesAtOldLimit();
    expect(left).toBeGreaterThan(1);
    expect(rowsOf(db)).toHaveLength(walked.length + left);
    return { walked, left };
  }

  it("deletes them, leaves every other row and reports how many", async () => {
    const { walked, left } = await walkAndLeaveRepliesAtOldLimit();
    const result = await generate();
    expect(result).toMatchObject({ removedReplies: left, created: 0, deepestPly: 29 });
    expect(rowsOf(db)).toEqual(walked);
  });

  it("deletes nothing and adds nothing on the run after the one that deleted them", async () => {
    await walkAndLeaveRepliesAtOldLimit();
    await generate();
    const cleaned = rowsOf(db);
    const searches = engine.requests.length;
    const again = await generate();
    expect(again).toMatchObject({ removedReplies: 0, created: 0, requests: 0 });
    expect(rowsOf(db)).toEqual(cleaned);
    expect(engine.requests).toHaveLength(searches);
  });

  it("leaves the rows of a variation the walk does not own", async () => {
    await walkAndLeaveRepliesAtOldLimit();
    const other = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "Newest",
    });
    upsertRepertoireReply(db, {
      repertoireId: other.id,
      positionKey: "position",
      ply: 30,
      line: [],
      reach: 0.1,
      openingName: null,
      uci: "g8f6",
      san: "Nf6",
      share: 0.5,
      source: "explorer",
    });
    await generate();
    expect(rowsOf(db).filter((row) => row.repertoire_id === other.id)).toHaveLength(1);
  });

  // With an odd limit the last row is a White move at the limit itself, where the deletion looks.
  it("never deletes a White move, even one that sits at the limit", async () => {
    writeItalianTree();
    await generate({ maxPly: 5 });
    const stored = rowsOf(db);
    expect(stored.at(-1)).toMatchObject({ kind: "own", ply: 5 });
    const again = await generate({ maxPly: 5 });
    expect(again).toMatchObject({ removedReplies: 0, created: 0 });
    expect(rowsOf(db)).toEqual(stored);
  });

  // The walk would otherwise find the row already stored, at a reach it cannot beat, and leave it
  // there for the deletion to take: the position would be missing until the run after.
  it("stores a position again at its shorter line when an earlier run left it at the limit", async () => {
    writeItalianTree();
    explorer.autoplay = true;
    await generate();
    const walked = rowsOf(db);
    const shorter = walked.find((row) => row.kind === "reply" && row.ply === 28);
    if (!shorter) throw new Error("no reply is stored at ply 28");
    db.prepare("UPDATE repertoire_positions SET ply = 30, reach = 1 WHERE id = ?").run(shorter.id);
    const result = await generate();
    const comparable = (rows: RepertoireTestRow[]) => rows.map(({ id: _id, ...row }) => row);
    expect(result).toMatchObject({ removedReplies: 1, created: 1 });
    expect(comparable(rowsOf(db))).toEqual(comparable(walked));
  });

  it("deletes them even when the request budget cuts the run short", async () => {
    const { walked, left } = await walkAndLeaveRepliesAtOldLimit();
    rmSync(cacheDir, { recursive: true, force: true });
    const result = await generate({ maxRequests: 0 });
    expect(result).toMatchObject({ removedReplies: left, created: 0, truncated: true });
    expect(rowsOf(db)).toEqual(walked);
  });
});

describe("POST /api/openings/generate with the repertoire source", () => {
  it("logs how many reply rows the run deleted at the depth limit", async () => {
    writeItalianTree();
    explorer.autoplay = true;
    await generate();
    const left = storeRepliesAtOldLimit();
    const log = new RecordingLog();
    const app = buildApp({
      db,
      log,
      generateOpenings: async () => ({ positions: 0, created: 0, updated: 0 }),
      generateRepertoireOpenings: () =>
        generateRepertoire(db, engine, explorer, cacheDir, clock, ITALIAN_FIXTURE_NAMES),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/openings/generate",
      payload: { sources: ["repertoire"] },
    });
    await app.close();
    expect(response.statusCode).toBe(200);
    expect(left).toBeGreaterThan(1);
    expect(log.named("openings.generate")[0]?.fields).toMatchObject({
      sources: ["repertoire"],
      result: { repertoire: { removedReplies: left } },
    });
  });

  it("builds the variation, adds no row on a second run and logs the counts", async () => {
    writeItalianTree();
    const log = new RecordingLog();
    const app = buildApp({
      db,
      log,
      generateOpenings: async () => ({ positions: 0, created: 0, updated: 0 }),
      generateRepertoireOpenings: () =>
        generateRepertoire(db, engine, explorer, cacheDir, clock, ITALIAN_FIXTURE_NAMES),
    });
    const post = () =>
      app.inject({
        method: "POST",
        url: "/api/openings/generate",
        payload: { sources: ["repertoire"] },
      });
    const first = await post();
    const stored = rowsOf(db);
    const second = await post();
    await app.close();
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(stored.length).toBeGreaterThan(0);
    expect(rowsOf(db)).toEqual(stored);
    expect(log.named("openings.generate")[0]?.fields).toMatchObject({
      sources: ["repertoire"],
      result: {
        repertoire: {
          ownMoves: stored.filter((row) => row.kind === "own").length,
          replies: stored.filter((row) => row.kind === "reply").length,
          deepestPly: Math.max(...stored.map((row) => row.ply)),
        },
      },
    });
  });

  it("logs how many replies came from the explorer's most played and from the engine, and the deepest ply", async () => {
    writeItalianTree();
    writeSpreadAfterCxd4();
    const log = new RecordingLog();
    const app = buildApp({
      db,
      log,
      generateOpenings: async () => ({ positions: 0, created: 0, updated: 0 }),
      generateRepertoireOpenings: () =>
        generateRepertoire(db, engine, explorer, cacheDir, clock, ITALIAN_FIXTURE_NAMES),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/openings/generate",
      payload: { sources: ["repertoire"] },
    });
    await app.close();
    const stored = rowsOf(db);
    const repliesFrom = (source: string): number =>
      stored.filter((row) => row.kind === "reply" && row.source === source).length;
    expect(response.statusCode).toBe(200);
    // White's engine moves carry the same source, and they must not be counted as replies.
    expect(
      stored.filter((row) => row.kind === "own" && row.source === "engine").length,
    ).toBeGreaterThan(0);
    expect(repliesFrom("mainline")).toBeGreaterThan(0);
    expect(repliesFrom("engine")).toBeGreaterThan(0);
    expect(log.named("openings.generate")[0]?.fields).toMatchObject({
      sources: ["repertoire"],
      result: {
        repertoire: {
          mainlineReplies: repliesFrom("mainline"),
          engineReplies: repliesFrom("engine"),
          deepestPly: 29,
        },
      },
    });
  });

  it("answers 502 when the explorer fails during the walk, never a truncated success", async () => {
    writeItalianTree();
    explorer.failAt(
      AFTER_C3,
      EXPLORER_RATINGS,
      new ExplorerError("unauthorized", "the explorer wants a Lichess API token"),
    );
    const app = buildApp({
      db,
      generateOpenings: async () => ({ positions: 0, created: 0, updated: 0 }),
      generateRepertoireOpenings: () =>
        generateRepertoire(db, engine, explorer, cacheDir, clock, ITALIAN_FIXTURE_NAMES),
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/openings/generate",
      payload: { sources: ["repertoire"] },
    });
    await app.close();
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: "explorer_unavailable" });
  });
});

describe("the documentation of the repertoire source", () => {
  const repositoryRoot = join(import.meta.dirname, "../../../..");

  it("documents the source and its two rating groups under Openings in AGENTS.md", () => {
    const agents = readFileSync(join(repositoryRoot, "AGENTS.md"), "utf8");
    const openings = /- \*\*Openings:\*\*[\s\S]*?(?=\n- \*\*)/.exec(agents)?.[0] ?? "";
    expect(openings).toContain('`POST /api/openings/generate {sources: ["repertoire"]}`');
    expect(openings).toContain("`EXPLORER_RATINGS`");
    expect(openings).toContain("`ITALIAN_WHITE_RATINGS`");
  });

  it("says under Openings that a line continues past the coverage goal up to White's 15th move", () => {
    const agents = readFileSync(join(repositoryRoot, "AGENTS.md"), "utf8");
    const openings = /- \*\*Openings:\*\*[\s\S]*?(?=\n- \*\*)/.exec(agents)?.[0] ?? "";
    expect(openings).toContain(
      "continues past the coverage goal along the most played reply, up to White's 15th move",
    );
    expect(openings).toContain("`mainlineReplies`");
    expect(openings).toContain("`engineReplies`");
  });

  it("never names a rating group the explorer does not have", () => {
    const filesUnder = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          return entry.name === "node_modules" || entry.name === "dist" ? [] : filesUnder(path);
        }
        return entry.isFile() ? [path] : [];
      });
    const files = [
      ...filesUnder(join(repositoryRoot, "packages")),
      join(repositoryRoot, "AGENTS.md"),
    ];
    const forbidden = [["400", "600"].join("-"), ["400", "600"].join(",")];
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((file) =>
      forbidden.some((text) => readFileSync(file, "utf8").includes(text)),
    );
    expect(offenders).toEqual([]);
  });
});
