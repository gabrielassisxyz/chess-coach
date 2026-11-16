import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Database, Statement } from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { Chess, type Square } from "chess.js";
import { type Log, silentLog } from "../log.js";
import { applyUci } from "./moves.js";
import { MATE_SCORE_CP } from "./parse.js";
import type { SearchResult } from "./uci.js";

// The reader of the file `tools/build_eval_cache.py` writes; the binary format is described in
// tools/README.md and pinned by tools/testdata/eval_cache_golden.json, which the tests read. The
// writer further down adds the rows of local analysis to the same file.

const FORMAT_VERSION = 1;
const PIECES = "PNBRQKpnbrqk";
const CASTLING_LETTERS = "KQkq";
const PROMOTION_LETTERS = ["", "n", "b", "r", "q"];
const NO_EN_PASSANT = 15;
// A line's first byte holds its move count in the low 7 bits and the mate flag in the top one.
const MOVE_COUNT_MASK = 127;
const MATE_FLAG = 128;

/** What a caller needs from a stored position: this many lines, searched at least this deep. */
export interface EvalWant {
  lines: number;
  depth: number;
}

/** The lines of one stored set, scored from the side to move as a search's lines are. */
export interface CachedAnalysis {
  depth: number;
  lines: Array<{ moves: string[]; score: number }>;
}

export interface EvalCache {
  /** A miss is null: the position is not stored, or not stored with enough lines and depth. */
  lookup(fen: string, want: EvalWant): CachedAnalysis | null;
  close(): void;
}

/** A lookup that found nothing to answer with, as a caller that wants the position searched needs it. */
export interface EvalMiss {
  /** The position as chess.js writes it, which is the one the key was made from. */
  fen: string;
  /** The file's key for the position, so a row written under it is the one the next lookup reads. */
  key: Buffer;
  /** The depth of the deepest set stored for the position; null when nothing is stored for it. */
  storedDepth: number | null;
}

export type EvalMissListener = (miss: EvalMiss) => void;

/** One line as the file holds it: castling written as the king taking its rook, scored from White. */
export interface StoredLine {
  mate: boolean;
  /** Centipawns, or moves to mate when `mate` is set. */
  score: number;
  moves: string[];
}

export interface StoredSet {
  depth: number;
  knodes: number;
  lines: StoredLine[];
}

/** A position the key cannot hold exactly; the builder refuses the same ones. */
export class UnrepresentablePosition extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrepresentablePosition";
  }
}

function castlingMasks(): ReadonlyMap<string, number> {
  const masks = new Map<string, number>();
  for (let mask = 0; mask < 16; mask++) {
    const letters = [...CASTLING_LETTERS].filter((_, bit) => (mask >> bit) & 1).join("");
    masks.set(letters === "" ? "-" : letters, mask);
  }
  return masks;
}

const CASTLING_MASKS = castlingMasks();

function scanPlacement(placement: string): { occupancy: bigint; nibbles: number[] } {
  const ranks = placement.split("/");
  if (ranks.length !== 8) throw new UnrepresentablePosition(`placement of ${ranks.length} ranks`);
  let occupancy = 0n;
  const nibbles: number[] = [];
  let index = 0;
  for (const rank of ranks) {
    let width = 0;
    let previousWasDigit = false;
    for (const char of rank) {
      if ("12345678".includes(char)) {
        if (previousWasDigit) throw new UnrepresentablePosition(`adjacent digits in ${placement}`);
        width += Number(char);
        index += Number(char);
        previousWasDigit = true;
        continue;
      }
      const piece = PIECES.indexOf(char);
      if (piece < 0) throw new UnrepresentablePosition(`piece ${char} in ${placement}`);
      occupancy |= 1n << BigInt(index);
      nibbles.push(piece);
      width += 1;
      index += 1;
      previousWasDigit = false;
    }
    if (width !== 8) throw new UnrepresentablePosition(`rank ${rank} is not 8 wide`);
  }
  return { occupancy, nibbles };
}

// The key keeps the file only: the rank follows from the side to move, so another rank could not
// be restored and is refused.
function enPassantFile(enPassant: string, side: string): number {
  if (enPassant === "-") return NO_EN_PASSANT;
  const file = enPassant.charCodeAt(0) - 97;
  const rank = side === "w" ? "6" : "3";
  if (enPassant.length !== 2 || file < 0 || file > 7 || enPassant[1] !== rank) {
    throw new UnrepresentablePosition(`en passant ${enPassant} with ${side} to move`);
  }
  return file;
}

/** The first four FEN fields as the file's key: occupancy, a nibble per piece, then the state. */
export function packKey(epd: string): Buffer {
  const fields = epd.split(" ");
  const [placement, side, castling, enPassant] = fields;
  if (
    fields.length !== 4 ||
    placement === undefined ||
    side === undefined ||
    castling === undefined ||
    enPassant === undefined
  ) {
    throw new UnrepresentablePosition(`expected 4 fields: ${epd}`);
  }
  if (side !== "w" && side !== "b") throw new UnrepresentablePosition(`side to move ${side}`);
  const castlingMask = CASTLING_MASKS.get(castling);
  if (castlingMask === undefined) throw new UnrepresentablePosition(`castling ${castling}`);
  const { occupancy, nibbles } = scanPlacement(placement);
  const state =
    (side === "b" ? 1 : 0) | (castlingMask << 1) | (enPassantFile(enPassant, side) << 5);
  const occupied = Buffer.alloc(8);
  occupied.writeBigUInt64LE(occupancy);
  const packed: number[] = [];
  for (let start = 0; start < nibbles.length; start += 2) {
    packed.push((nibbles[start] ?? 0) | ((nibbles[start + 1] ?? 15) << 4));
  }
  const stateBytes = Buffer.alloc(2);
  stateBytes.writeUInt16LE(state);
  return Buffer.concat([occupied, Buffer.from(packed), stateBytes]);
}

/**
 * The one way a FEN becomes the file's key, for the reader and the writer alike: chess.js writes an
 * en passant square only where a capture is possible, as the file does, so two spellings of one
 * position get one key.
 */
function evalKeyOf(fen: string): { board: Chess; normalized: string; key: Buffer } {
  const board = new Chess(fen);
  const normalized = board.fen();
  return { board, normalized, key: packKey(normalized.split(" ").slice(0, 4).join(" ")) };
}

function squareName(square: number): string {
  return `${String.fromCharCode(97 + (square % 8))}${(square >> 3) + 1}`;
}

function unpackMove(packed: number): string {
  const promotion = PROMOTION_LETTERS[(packed >> 12) & 7];
  if (promotion === undefined) throw new Error(`promotion code ${(packed >> 12) & 7}`);
  return squareName(packed & 63) + squareName((packed >> 6) & 63) + promotion;
}

/** Every set a value holds, deepest first, with moves as the file writes them. */
export function decodeValue(value: Uint8Array): StoredSet[] {
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  if (value.length < 2 || view.getUint8(0) !== FORMAT_VERSION) {
    throw new Error(`unknown value version ${value[0]}`);
  }
  let offset = 2;
  const sets: StoredSet[] = [];
  for (let setIndex = 0; setIndex < view.getUint8(1); setIndex++) {
    const depth = view.getUint8(offset);
    const knodes = view.getUint32(offset + 1, true);
    const lineCount = view.getUint8(offset + 5);
    offset += 6;
    const lines: StoredLine[] = [];
    for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
      const head = view.getUint8(offset);
      const score = view.getInt16(offset + 1, true);
      offset += 3;
      const moves: string[] = [];
      for (let moveIndex = 0; moveIndex < (head & MOVE_COUNT_MASK); moveIndex++) {
        moves.push(unpackMove(view.getUint16(offset, true)));
        offset += 2;
      }
      lines.push({ mate: (head & MATE_FLAG) !== 0, score, moves });
    }
    sets.push({ depth, knodes, lines });
  }
  if (offset !== value.length) throw new Error(`${value.length - offset} trailing bytes`);
  return sets;
}

/** The deepest set with at least `want.lines` lines and at least `want.depth` depth, or null. */
export function chooseSet(sets: readonly StoredSet[], want: EvalWant): StoredSet | null {
  let chosen: StoredSet | null = null;
  for (const set of sets) {
    if (set.lines.length < want.lines || set.depth < want.depth) continue;
    if (chosen === null || set.depth > chosen.depth) chosen = set;
  }
  return chosen;
}

// The file writes castling as the king taking its own rook. Only a king on its square makes the
// text castling: a rook on e1 playing to h1 is an ordinary move, which is why this reads the board.
const KING_TAKES_ROOK_AS_CASTLING: Readonly<Record<string, string>> = {
  e1h1: "e1g1",
  e1a1: "e1c1",
  e8h8: "e8g8",
  e8a8: "e8c8",
};

function standardUci(board: Chess, uci: string): string {
  const castling = KING_TAKES_ROOK_AS_CASTLING[uci];
  if (castling === undefined) return uci;
  return board.get(uci.slice(0, 2) as Square)?.type === "k" ? castling : uci;
}

// A line ends at the first move the position does not allow, so a stale or odd row never reaches
// the board as a move that cannot be played.
function replayLine(fen: string, stored: readonly string[]): string[] {
  const board = new Chess(fen);
  const replayed: string[] = [];
  for (const move of stored) {
    const uci = standardUci(board, move);
    try {
      applyUci(board, uci);
    } catch {
      break;
    }
    replayed.push(uci);
  }
  return replayed;
}

// The file scores every line from White's side, mates included: a Black mate in 1 is stored as
// -1. The search's lines are scored from the side to move, which is what the callers flip.
function sideToMoveScore(line: StoredLine, whiteToMove: boolean): number {
  const fromWhite = line.mate ? whiteMateScore(line.score, whiteToMove) : line.score;
  return whiteToMove ? fromWhite : -fromWhite;
}

// A mate in 0 has no sign of its own: the side to move is the one mated.
function whiteMateScore(movesToMate: number, whiteToMove: boolean): number {
  if (movesToMate === 0) return whiteToMove ? -MATE_SCORE_CP : MATE_SCORE_CP;
  return movesToMate > 0 ? MATE_SCORE_CP : -MATE_SCORE_CP;
}

type ValueRow = { value: Buffer };

class SqliteEvalCache implements EvalCache {
  constructor(
    private readonly db: Database,
    private readonly find: Statement<[Buffer], ValueRow>,
    private readonly log: Log,
    private readonly onMiss: EvalMissListener | undefined,
  ) {}

  lookup(fen: string, want: EvalWant): CachedAnalysis | null {
    const startedAt = performance.now();
    const elapsed = (): number => Math.round((performance.now() - startedAt) * 100) / 100;
    try {
      return this.read(fen, want, elapsed);
    } catch (error) {
      // A damaged file must cost the engine's answer, never the request.
      this.log.error("eval_cache.failed", error, { fen, lines: want.lines, depth: want.depth });
      return null;
    }
  }

  close(): void {
    this.db.close();
  }

  private read(fen: string, want: EvalWant, elapsed: () => number): CachedAnalysis | null {
    const { board, normalized, key } = evalKeyOf(fen);
    const row = this.find.get(key);
    const request = { fen, lines: want.lines, depth: want.depth };
    if (row === undefined) {
      this.log.info("eval_cache.miss", {
        ...request,
        reason: "not_stored",
        duration_ms: elapsed(),
      });
      this.onMiss?.({ fen: normalized, key, storedDepth: null });
      return null;
    }
    const sets = decodeValue(row.value);
    const chosen = chooseSet(sets, want);
    if (chosen === null) {
      const stored = sets.map((set) => ({ depth: set.depth, lines: set.lines.length }));
      this.log.info("eval_cache.miss", {
        ...request,
        reason: "insufficient",
        stored,
        duration_ms: elapsed(),
      });
      const storedDepth = sets.reduce((deepest, set) => Math.max(deepest, set.depth), 0);
      this.onMiss?.({ fen: normalized, key, storedDepth });
      return null;
    }
    const whiteToMove = board.turn() === "w";
    const lines = chosen.lines.slice(0, want.lines).map((line) => ({
      moves: replayLine(normalized, line.moves),
      score: sideToMoveScore(line, whiteToMove),
    }));
    this.log.info("eval_cache.hit", {
      ...request,
      stored_depth: chosen.depth,
      stored_lines: chosen.lines.length,
      duration_ms: elapsed(),
    });
    return { depth: chosen.depth, lines };
  }
}

const NO_EVAL_CACHE: EvalCache = {
  lookup: () => null,
  close: () => {},
};

/**
 * Opens the file read-only, or answers every lookup with a miss when there is none to open. One
 * `eval_cache.unavailable` event says which, so a boot without a cache is a line in the log and
 * not a silence; the lookups themselves then log nothing, since they never consulted a file.
 * `onMiss` hears every lookup that found nothing to answer with, and never one when there is no
 * file: a position that cannot be stored afterwards is not worth asking for.
 */
export function openEvalCache(
  path: string | null,
  log: Log = silentLog,
  onMiss?: EvalMissListener,
): EvalCache {
  if (path === null) {
    log.info("eval_cache.unavailable", { reason: "unset" });
    return NO_EVAL_CACHE;
  }
  if (!existsSync(path)) {
    log.warn("eval_cache.unavailable", { reason: "missing", path });
    return NO_EVAL_CACHE;
  }
  let db: Database | null = null;
  try {
    db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
    // Preparing the lookup is what checks that the file has the table the reader expects.
    const find = db.prepare<[Buffer], ValueRow>("SELECT value FROM evals WHERE key = ?");
    return new SqliteEvalCache(db, find, log, onMiss);
  } catch (error) {
    db?.close();
    const reason = error instanceof Error ? error.message : String(error);
    log.warn("eval_cache.unavailable", { reason: "unreadable", path, error_message: reason });
    return NO_EVAL_CACHE;
  }
}

// The write side. A search of this app goes into the file as a set of its own, labelled source 1,
// in the format the builder writes, so the reader above answers it exactly as it answers a row of
// the Lichess file.

const LOCAL_ANALYSIS_SOURCE = 1;
// The widths of the format: a depth is a byte, knodes four, a score two (signed) and a line's move
// count seven bits.
const MAX_DEPTH = 255;
const MAX_KNODES = 4294967295;
const MIN_SCORE = -32768;
const MAX_SCORE = 32767;
const MAX_LINE_MOVES = 127;

// The inverse of `KING_TAKES_ROOK_AS_CASTLING`, so the two tables cannot disagree.
const CASTLING_AS_KING_TAKES_ROOK: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(KING_TAKES_ROOK_AS_CASTLING).map(([kingTakesRook, castling]) => [
    castling,
    kingTakesRook,
  ]),
);

function squareIndex(name: string): number {
  return name.charCodeAt(0) - 97 + (Number(name[1]) - 1) * 8;
}

function packMove(uci: string): number {
  const promotion = PROMOTION_LETTERS.indexOf(uci.slice(4));
  if (promotion < 0) throw new Error(`promotion in ${uci}`);
  return squareIndex(uci.slice(0, 2)) | (squareIndex(uci.slice(2, 4)) << 6) | (promotion << 12);
}

/** The value bytes the builder writes for these sets; the golden fixture pins the two to each other. */
export function encodeValue(sets: readonly StoredSet[]): Buffer {
  const parts: Buffer[] = [Buffer.from([FORMAT_VERSION, sets.length])];
  for (const set of sets) {
    const head = Buffer.alloc(6);
    head.writeUInt8(set.depth, 0);
    head.writeUInt32LE(set.knodes, 1);
    head.writeUInt8(set.lines.length, 5);
    parts.push(head);
    for (const line of set.lines) {
      const lineHead = Buffer.alloc(3);
      lineHead.writeUInt8(line.moves.length | (line.mate ? MATE_FLAG : 0), 0);
      lineHead.writeInt16LE(line.score, 1);
      parts.push(lineHead);
      for (const move of line.moves) {
        const packed = Buffer.alloc(2);
        packed.writeUInt16LE(packMove(move));
        parts.push(packed);
      }
    }
  }
  return Buffer.concat(parts);
}

// The file writes castling as the king taking its rook; a search writes it as the king's two
// steps. Only a king on its square makes the second a castling, as `standardUci` reads it back.
// A line ends at the first move the position does not allow, as when it is read.
function fileMoves(fen: string, moves: readonly string[]): string[] {
  const board = new Chess(fen);
  const written: string[] = [];
  for (const uci of moves.slice(0, MAX_LINE_MOVES)) {
    const kingTakesRook = CASTLING_AS_KING_TAKES_ROOK[uci];
    const asWritten =
      kingTakesRook !== undefined && board.get(uci.slice(0, 2) as Square)?.type === "k"
        ? kingTakesRook
        : uci;
    try {
      applyUci(board, uci);
    } catch {
      break;
    }
    written.push(asWritten);
  }
  return written;
}

function clampScore(score: number): number {
  return Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(score)));
}

// A search keeps no mate distance, only the +-10000 it maps a mate to, so a mate is stored as that
// many centipawns, which reads back as the score the search had. The file scores from White's side.
// A position with no move to search, a checkmate or a stalemate, has nothing to store.
function storedSetOf(fen: string, result: SearchResult): StoredSet | null {
  if (result.bestmove === null || result.depth === undefined || result.lines.length === 0) {
    return null;
  }
  const whiteToMove = new Chess(fen).turn() === "w";
  return {
    depth: Math.min(result.depth, MAX_DEPTH),
    knodes: Math.min(result.knodes ?? 0, MAX_KNODES),
    lines: result.lines.map((line) => ({
      mate: false,
      score: clampScore(whiteToMove ? line.score : -line.score),
      moves: fileMoves(fen, line.moves),
    })),
  };
}

/**
 * The sets of the row that replaces `existing` once `fresh` is deeper than all of them. A row with
 * more lines than the fresh set must not lose them to it, so the best of those, the most lines and
 * then the deepest, stays as the second set the format allows.
 */
export function mergeSets(existing: readonly StoredSet[], fresh: StoredSet): StoredSet[] {
  let carried: StoredSet | null = null;
  for (const set of existing) {
    if (set.lines.length <= fresh.lines.length) continue;
    const better =
      carried === null ||
      set.lines.length > carried.lines.length ||
      (set.lines.length === carried.lines.length && set.depth > carried.depth);
    if (better) carried = set;
  }
  return carried === null ? [fresh] : [fresh, carried];
}

/** `empty` is a position the engine had no move in; `unchanged` a result no deeper than the row. */
export type StoreOutcome = "stored" | "unchanged" | "empty";

export interface EvalCacheWriter {
  /** Opens the file for writing now, so a file that cannot be written is found before a search is spent on it. */
  ensureOpen(): void;
  /**
   * Stores a finished search of `fen` as source 1 when it is deeper than the row, and otherwise
   * changes nothing. The sets of the row that have more lines than the result are carried over.
   */
  store(fen: string, result: SearchResult): StoreOutcome;
  close(): void;
}

type StoredRow = { depth: number; value: Buffer };

// The write the file's owner specified: the conditional update is what stops a result from ever
// replacing a deeper row, even if a row changed between the read and the write.
const UPSERT_LOCAL_ANALYSIS = `INSERT INTO evals (key, source, depth, value) VALUES (?, ${LOCAL_ANALYSIS_SOURCE}, ?, ?)
  ON CONFLICT(key) DO UPDATE SET source = ${LOCAL_ANALYSIS_SOURCE}, depth = excluded.depth, value = excluded.value
  WHERE excluded.depth > evals.depth`;

interface WriterConnection {
  db: Database;
  read: Statement<[Buffer], StoredRow>;
  write: Statement<[Buffer, number, Buffer]>;
}

// A damaged row has nothing worth carrying over; the deeper result replaces it.
function setsOf(value: Buffer): StoredSet[] {
  try {
    return decodeValue(value);
  } catch {
    return [];
  }
}

class SqliteEvalCacheWriter implements EvalCacheWriter {
  private connection: WriterConnection | null = null;

  constructor(private readonly path: string) {}

  ensureOpen(): void {
    this.open();
  }

  store(fen: string, result: SearchResult): StoreOutcome {
    const set = storedSetOf(fen, result);
    if (set === null) return "empty";
    const { key } = evalKeyOf(fen);
    const { db, read, write } = this.open();
    // One writer at a time and the read inside the transaction, so the sets carried over are the
    // ones the row holds when the write lands. Whether the result is deep enough to replace the row
    // is decided in one place only, the WHERE of the write, and a refused write changes no row.
    return db
      .transaction((): StoreOutcome => {
        const existing = read.get(key);
        const sets = mergeSets(existing === undefined ? [] : setsOf(existing.value), set);
        return write.run(key, set.depth, encodeValue(sets)).changes > 0 ? "stored" : "unchanged";
      })
      .immediate();
  }

  close(): void {
    this.connection?.db.close();
    this.connection = null;
  }

  // The file is built with the journal off, which a writer cannot use: it is switched to WAL, with
  // the lighter sync that mode allows, before anything is written. The reader keeps its own
  // read-only connection and sees every commit.
  private open(): WriterConnection {
    if (this.connection) return this.connection;
    const db = new BetterSqlite3(this.path, { fileMustExist: true });
    try {
      if (db.pragma("journal_mode = WAL", { simple: true }) !== "wal") {
        throw new Error("the evaluation cache file cannot be written in WAL mode");
      }
      db.pragma("synchronous = NORMAL");
      this.connection = {
        db,
        read: db.prepare<[Buffer], StoredRow>("SELECT depth, value FROM evals WHERE key = ?"),
        write: db.prepare<[Buffer, number, Buffer]>(UPSERT_LOCAL_ANALYSIS),
      };
      return this.connection;
    } catch (error) {
      db.close();
      throw error;
    }
  }
}

/**
 * A writer for the file, or null when there is no file or the app cannot write to it. The file
 * itself is not opened until the first write: a boot must not switch a file of tens of gigabytes
 * to another journal mode before anything has asked for a search. Opening it for writing makes
 * journal files beside it, so the directory has to be writable as well.
 */
export function openEvalCacheWriter(
  path: string | null,
  log: Log = silentLog,
): EvalCacheWriter | null {
  // The reader says why there is no file, once; saying it again here would be two lines for one fact.
  if (path === null || !existsSync(path)) return null;
  try {
    accessSync(path, constants.W_OK);
    accessSync(dirname(path), constants.W_OK);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn("eval_cache.unavailable", { reason: "not_writable", path, error_message: reason });
    return null;
  }
  return new SqliteEvalCacheWriter(path);
}
