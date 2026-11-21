import { Chess, type Move } from "chess.js";
// The key is the generator's own function and never a copy: a repertoire card is scheduled by
// position key and move, so a key written another way would orphan every schedule.
import { positionKey } from "./from-games.js";

/**
 * Reads the PGN a student keeps one side of their opening lines in, with variations inside
 * variations and, in time, a comment after a move saying why it is played, and turns it into the
 * moves of one repertoire unit. Pure: no database, no network, no file.
 *
 * Every move is replayed with chess.js from the starting position, along the path of the line
 * that holds it, on one shared board that steps back at a variation and forward again after it.
 * The first problem in the PGN stops the reading and no moves are returned, so a unit is never
 * half of a file; problems that only show once the whole text is read (two answers to one
 * position, a weights text that does not parse) are all reported.
 */

export type PgnRepertoireSide = "white" | "black";

/** One row of `repertoire_positions`: the student's move in a position, or a reply to it. */
export interface PgnRepertoireMove {
  kind: "own" | "reply";
  /** The position before the move, written by the same function as the generator's. */
  position_key: string;
  ply: number;
  /** The SAN moves played before this one, from move 1. */
  line_san: string[];
  move_uci: string;
  /** The SAN chess.js writes for the move, whatever spelling the file used. */
  move_san: string;
  reach: number;
  /** The student's reason for an own move, from the comments after it; null on a reply. */
  reason: string | null;
  cp_loss: number | null;
}

export interface PgnRepertoireCounts {
  games: number;
  own_moves: number;
  replies: number;
  reasons: number;
  comments_ignored: number;
  unanswered_replies: number;
  deepest_ply: number;
  weights_matched: number;
  weights_unmatched: number;
}

/** One of the two moves a text gives to a position, with the line that led there. */
export interface PgnRepertoireAnswer {
  game: number;
  line_san: string[];
  move_san: string;
}

export type PgnRepertoireError =
  | { code: "too_large"; message: string }
  | { code: "not_from_start"; message: string; game: number }
  | { code: "invalid_pgn"; message: string; game: number | null; line: number }
  | {
      code: "illegal_move";
      message: string;
      game: number;
      line: number;
      move: string;
      line_san: string[];
    }
  | {
      code: "two_answers";
      message: string;
      position_key: string;
      answers: [PgnRepertoireAnswer, PgnRepertoireAnswer];
    }
  | { code: "invalid_weights"; message: string; line: number | null }
  | { code: "no_moves"; message: string };

export type PgnRepertoireResult =
  | { moves: PgnRepertoireMove[]; counts: PgnRepertoireCounts; errors?: never }
  | { errors: PgnRepertoireError[]; moves?: never; counts?: never };

const MAX_TEXT_BYTES = 500_000;
// A broken text shows its pattern in the first few problems, and the cap bounds the answer.
const MAX_REPORTED_ERRORS = 20;
// The longest move chess.js reads, long algebraic and annotation included, is well under this; the
// bound keeps one junk token from reaching the move parser.
const LONGEST_MOVE_TOKEN = 12;
const RESULT_TOKENS: ReadonlySet<string> = new Set(["*", "1-0", "0-1", "1/2-1/2"]);
const START_KEY = positionKey(new Chess().fen());

// ---------------------------------------------------------------- scanning

type PgnToken = { line: number } & (
  | { kind: "header"; name: string }
  | { kind: "comment"; text: string; braced: boolean }
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "word"; text: string }
  | { kind: "error"; text: string }
);

// Alternatives in priority order, the group that matched naming the token. The last one takes any
// character the others refuse: a { with no }, a } with no {, a [ that opens no tag pair.
const PGN_TOKEN = new RegExp(
  [
    String.raw`\s+`,
    // A % in the first column escapes the whole line; anywhere else it starts a word.
    String.raw`(?<![^\n])%[^\n]*`,
    String.raw`\{(?<brace>[^}]*)\}`,
    String.raw`;(?<semi>[^\n]*)`,
    String.raw`(?<open>\()`,
    String.raw`(?<close>\))`,
    String.raw`\[\s*(?<tag>[A-Za-z0-9_]+)\s+"(?:[^"\\]|\\.)*"\s*\]`,
    String.raw`(?<word>[^\s{}()[;][^\s{}();]*)`,
    String.raw`(?<stray>[\s\S])`,
  ].join("|"),
  "y",
);

const STRAY_MESSAGES: Readonly<Record<string, string>> = {
  "{": "a { comment is never closed",
  "}": "a } closes no comment",
  "[": 'a tag pair is not written as [Name "value"]',
};

function tokenOf(groups: Record<string, string | undefined>, line: number): PgnToken | null {
  if (groups.brace !== undefined)
    return { kind: "comment", text: groups.brace, braced: true, line };
  if (groups.semi !== undefined) return { kind: "comment", text: groups.semi, braced: false, line };
  if (groups.tag !== undefined) return { kind: "header", name: groups.tag, line };
  if (groups.open !== undefined) return { kind: "open", line };
  if (groups.close !== undefined) return { kind: "close", line };
  if (groups.word !== undefined) return { kind: "word", text: groups.word, line };
  if (groups.stray === undefined) return null;
  const message = STRAY_MESSAGES[groups.stray] ?? "an unexpected character";
  return { kind: "error", text: message, line };
}

// Yields a token as soon as it is read, so a problem further on never hides what came before it.
function* scanPgn(text: string): Generator<PgnToken> {
  const pattern = new RegExp(PGN_TOKEN);
  let line = 1;
  while (pattern.lastIndex < text.length) {
    const match = pattern.exec(text) as RegExpExecArray;
    const token = tokenOf(match.groups ?? {}, line);
    line += match[0].split("\n").length - 1;
    if (token) yield token;
    if (token?.kind === "error") return;
  }
}

type PgnWord = { kind: "result" | "nag" | "number" } | { kind: "move"; written: string };

// A move number may be glued to its move (1.e4, 1...e5) or stand alone (1. ... e5).
function classifyWord(word: string): PgnWord {
  if (RESULT_TOKENS.has(word)) return { kind: "result" };
  if (/^\$\d+$/.test(word)) return { kind: "nag" };
  const numbered = /^(?:\d+\.+|\.+)(.*)$/.exec(word);
  if (!numbered) return { kind: "move", written: word };
  return numbered[1] ? { kind: "move", written: numbered[1] } : { kind: "number" };
}

// chess.js takes the check and annotation marks off a move itself, and a spelling with more
// disambiguation than needed (Nbd2 where Nd2 does), and refuses one with less than needed.
function playWritten(board: Chess, written: string): Move | null {
  const san = written.replace(/[+#!?]+$/, "");
  if (san === "" || written.length > LONGEST_MOVE_TOKEN) return null;
  try {
    return board.move(san);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- reading the games

interface Occurrence {
  order: number;
  game: number;
  kind: "own" | "reply";
  keyBefore: string;
  keyAfter: string;
  ply: number;
  parent: Occurrence | null;
  uci: string;
  san: string;
  reasons: string[];
  // Set once the whole text is read, since they depend on the other lines.
  denominatorAfter: number;
  reach: number;
  cpLoss: number | null;
}

// One line of a game, the main line or one variation, on the shared board.
interface LineFrame {
  applied: number;
  last: Occurrence | null;
  // The move of the line above that this variation replaces, played again when it closes.
  replaced: Occurrence | null;
}

const newFrame = (replaced: Occurrence | null): LineFrame => ({ applied: 0, last: null, replaced });

type GamePhase = "none" | "headers" | "movetext" | "ended";

const sansOf = (occurrence: Occurrence | null): string[] => {
  const sans: string[] = [];
  for (let step = occurrence; step; step = step.parent) sans.push(step.san);
  return sans.reverse();
};

const formatMoves = (sans: readonly string[]): string =>
  sans.length === 0
    ? "the starting position"
    : sans.map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}. ${san}` : san)).join(" ");

// The commands in square brackets that tools write into comments ([%cal Gd2d4], [%clk 0:03:00])
// are drawings and clocks, not the student's words.
const cleanReason = (text: string): string =>
  text
    .replace(/\[%[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

class PgnRepertoireReader {
  readonly occurrences: Occurrence[] = [];
  readonly errors: PgnRepertoireError[] = [];
  games = 0;
  commentsIgnored = 0;
  private readonly ownColor: "w" | "b";
  private phase: GamePhase = "none";
  private stopped = false;
  private line = 1;
  private board = new Chess();
  private chain: Occurrence[] = [];
  private frames: LineFrame[] = [newFrame(null)];
  // The own move a brace comment read now would be the reason of.
  private target: Occurrence | null = null;

  constructor(side: PgnRepertoireSide) {
    this.ownColor = side === "white" ? "w" : "b";
  }

  read(text: string): void {
    for (const token of scanPgn(text)) {
      this.line = token.line;
      this.take(token);
      if (this.stopped) return;
    }
    if (this.frames.length > 1) this.invalid("a variation is never closed");
  }

  private take(token: PgnToken): void {
    if (token.kind === "header") this.onHeader(token.name);
    else if (token.kind === "comment") this.onComment(token.text, token.braced);
    else if (token.kind === "open") this.onOpen();
    else if (token.kind === "close") this.onClose();
    else if (token.kind === "word") this.onWord(token.text);
    else this.invalid(token.text);
  }

  private fail(error: PgnRepertoireError): void {
    this.errors.push(error);
    this.stopped = true;
  }

  private invalid(message: string): void {
    this.fail({
      code: "invalid_pgn",
      message: `line ${this.line}: ${message}`,
      game: this.games === 0 ? null : this.games,
      line: this.line,
    });
  }

  private frame(): LineFrame {
    return this.frames[this.frames.length - 1] as LineFrame;
  }

  private startGame(): void {
    this.games++;
    this.board = new Chess();
    this.chain = [];
    this.frames = [newFrame(null)];
    this.target = null;
  }

  private enterMovetext(): void {
    if (this.phase === "none" || this.phase === "ended") this.startGame();
    this.phase = "movetext";
  }

  private onHeader(name: string): void {
    if (this.frames.length > 1) {
      this.invalid("a tag pair inside a variation");
      return;
    }
    if (this.phase !== "headers") this.startGame();
    this.phase = "headers";
    if (!/^(?:setup|fen)$/i.test(name)) return;
    // Its moves would be replayed from a position they do not start from.
    this.fail({
      code: "not_from_start",
      message: `game ${this.games} has a ${name} tag, so it may not start from the first position`,
      game: this.games,
    });
  }

  private onComment(text: string, braced: boolean): void {
    if (!braced || !this.target) {
      this.commentsIgnored++;
      return;
    }
    const reason = cleanReason(text);
    if (reason !== "") this.target.reasons.push(reason);
  }

  private onWord(text: string): void {
    const word = classifyWord(text);
    // An annotation glyph belongs to the move before it, so a comment after it still follows it.
    if (word.kind === "nag") return;
    this.enterMovetext();
    this.target = null;
    if (word.kind === "result") this.onResult();
    else if (word.kind === "move") this.onMove(word.written);
  }

  private onResult(): void {
    if (this.frames.length > 1) this.invalid("a result inside a variation");
    else this.phase = "ended";
  }

  private onMove(written: string): void {
    const move = playWritten(this.board, written);
    if (move) {
      this.place(move);
      return;
    }
    const lineSan = sansOf(this.chain[this.chain.length - 1] ?? null);
    this.fail({
      code: "illegal_move",
      message: `game ${this.games}, line ${this.line}: ${written} is not a legal move after ${formatMoves(lineSan)}`,
      game: this.games,
      line: this.line,
      move: written,
      line_san: lineSan,
    });
  }

  private place(move: Move): void {
    const parent = this.chain[this.chain.length - 1] ?? null;
    const occurrence: Occurrence = {
      order: this.occurrences.length,
      game: this.games,
      kind: move.color === this.ownColor ? "own" : "reply",
      keyBefore: parent ? parent.keyAfter : START_KEY,
      keyAfter: positionKey(this.board.fen()),
      ply: this.chain.length + 1,
      parent,
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      san: move.san,
      reasons: [],
      denominatorAfter: 1,
      reach: 1,
      cpLoss: null,
    };
    this.occurrences.push(occurrence);
    this.chain.push(occurrence);
    const frame = this.frame();
    frame.applied++;
    frame.last = occurrence;
    this.target = occurrence.kind === "own" ? occurrence : null;
  }

  // A variation is the other move at the position before the move it follows.
  private onOpen(): void {
    this.enterMovetext();
    this.target = null;
    const parent = this.frame();
    if (!parent.last) {
      this.invalid("a variation must follow a move");
      return;
    }
    this.stepBack(parent, 1);
    this.frames.push(newFrame(parent.last));
  }

  private onClose(): void {
    this.target = null;
    const frame = this.frames.length > 1 ? this.frames.pop() : undefined;
    if (!frame?.last) {
      this.invalid(frame ? "a variation holds no move" : "a ) closes no variation");
      return;
    }
    this.stepBack(frame, frame.applied);
    if (!frame.replaced) return;
    this.board.move(frame.replaced.san);
    this.chain.push(frame.replaced);
    this.frame().applied++;
  }

  private stepBack(frame: LineFrame, count: number): void {
    for (let step = 0; step < count; step++) {
      this.board.undo();
      this.chain.pop();
      frame.applied--;
    }
  }
}

// ---------------------------------------------------------------- weights

interface WeightsRow {
  reach: number;
  cpLoss: number;
  matched: boolean;
}

interface WeightsTable {
  rows: Map<string, WeightsRow>;
  total: number;
  errors: PgnRepertoireError[];
}

type WeightsColumns = Record<"reach" | "loss_cp" | "line", number>;

// The line of a row is plain movetext, replayed so that a spelling chess.js writes another way
// still finds its move. A line that does not replay finds nothing.
function canonicalLine(movetext: string): string[] | null {
  const board = new Chess();
  const sans: string[] = [];
  for (const token of scanPgn(movetext)) {
    if (token.kind !== "word") return null;
    const word = classifyWord(token.text);
    if (word.kind === "number" || word.kind === "nag") continue;
    const move = word.kind === "move" ? playWritten(board, word.written) : null;
    if (!move) return null;
    sans.push(move.san);
  }
  return sans.length === 0 ? null : sans;
}

const numberOfCell = (cell: string | undefined): number | null => {
  const trimmed = (cell ?? "").trim();
  const value = trimmed === "" ? Number.NaN : Number(trimmed);
  return Number.isFinite(value) ? value : null;
};

type WeightsRowReading = { key: string; row: WeightsRow } | { problem: string } | null;

function readWeightsRow(cells: readonly string[], at: WeightsColumns): WeightsRowReading {
  const reach = numberOfCell(cells[at.reach]);
  const loss = numberOfCell(cells[at.loss_cp]);
  const movetext = (cells[at.line] ?? "").trim();
  if (reach === null || reach < 0 || reach > 1)
    return { problem: "reach is not a number from 0 to 1" };
  if (loss === null) return { problem: "loss_cp is not a number" };
  if (movetext === "") return { problem: "the line column is empty" };
  const sans = canonicalLine(movetext);
  return sans && { key: sans.join(" "), row: { reach, cpLoss: Math.round(loss), matched: false } };
}

function readWeights(text: string): WeightsTable {
  const table: WeightsTable = { rows: new Map(), total: 0, errors: [] };
  const fail = (message: string, line: number | null): void => {
    if (table.errors.length < MAX_REPORTED_ERRORS) {
      table.errors.push({ code: "invalid_weights", message, line });
    }
  };
  const lines = text.split("\n");
  const headerAt = lines.findIndex((line) => line.trim() !== "");
  const names = (lines[headerAt] ?? "").split("\t").map((name) => name.trim());
  const missing = (["reach", "loss_cp", "line"] as const).filter((name) => !names.includes(name));
  if (missing.length > 0) {
    fail(
      headerAt === -1
        ? "the weights text is empty"
        : `the header has no ${missing.join(", ")} column`,
      headerAt + 1 || null,
    );
    return table;
  }
  const at = {
    reach: names.indexOf("reach"),
    loss_cp: names.indexOf("loss_cp"),
    line: names.indexOf("line"),
  };
  for (let index = headerAt + 1; index < lines.length; index++) {
    const row = (lines[index] as string).replace(/\r$/, "");
    if (row.trim() === "") continue;
    table.total++;
    const reading = readWeightsRow(row.split("\t"), at);
    if (reading === null) continue;
    if ("problem" in reading) fail(`line ${index + 1}: ${reading.problem}`, index + 1);
    else if (table.rows.has(reading.key))
      fail(`line ${index + 1}: the same line as an earlier row`, index + 1);
    else table.rows.set(reading.key, reading.row);
  }
  return table;
}

// ---------------------------------------------------------------- reach and the unit

// Reach is 1 over the product of the reply counts met on the way, kept as that integer product so
// that two lines of equal reach compare equal, which a chain of float divisions does not promise.
function placeOccurrences(occurrences: readonly Occurrence[], weights: WeightsTable | null): void {
  const repliesAt = new Map<string, Set<string>>();
  for (const occurrence of occurrences) {
    if (occurrence.kind !== "reply") continue;
    const replies = repliesAt.get(occurrence.keyBefore) ?? new Set<string>();
    repliesAt.set(occurrence.keyBefore, replies.add(occurrence.uci));
  }
  for (const occurrence of occurrences) {
    const before = occurrence.parent ? occurrence.parent.denominatorAfter : 1;
    const replies = repliesAt.get(occurrence.keyBefore)?.size ?? 1;
    occurrence.denominatorAfter = occurrence.kind === "reply" ? before * replies : before;
    occurrence.reach = 1 / occurrence.denominatorAfter;
    const row =
      occurrence.kind === "own" ? weights?.rows.get(sansOf(occurrence).join(" ")) : undefined;
    if (!row) continue;
    occurrence.reach = row.reach;
    occurrence.cpLoss = row.cpLoss;
    row.matched = true;
  }
}

function twoAnswersErrors(occurrences: readonly Occurrence[]): PgnRepertoireError[] {
  const first = new Map<string, Occurrence>();
  const reported = new Set<string>();
  const errors: PgnRepertoireError[] = [];
  for (const occurrence of occurrences) {
    if (occurrence.kind !== "own") continue;
    const seen = first.get(occurrence.keyBefore);
    if (!seen) first.set(occurrence.keyBefore, occurrence);
    else if (seen.uci !== occurrence.uci && !reported.has(occurrence.keyBefore)) {
      reported.add(occurrence.keyBefore);
      errors.push(twoAnswersError(seen, occurrence));
    }
  }
  return errors;
}

function twoAnswersError(one: Occurrence, other: Occurrence): PgnRepertoireError {
  const answer = (occurrence: Occurrence): PgnRepertoireAnswer => ({
    game: occurrence.game,
    line_san: sansOf(occurrence.parent),
    move_san: occurrence.san,
  });
  const lineOf = (occurrence: Occurrence): string => formatMoves(sansOf(occurrence));
  return {
    code: "two_answers",
    message: `one position has two answers: ${lineOf(one)} (game ${one.game}) and ${lineOf(other)} (game ${other.game})`,
    position_key: one.keyBefore,
    answers: [answer(one), answer(other)],
  };
}

// A position and move reached by two lines is one row, kept with the line of higher reach and the
// earlier one at a tie, with that line's reason and figures.
function keepBestLines(occurrences: readonly Occurrence[]): Occurrence[] {
  const best = new Map<string, Occurrence>();
  for (const occurrence of occurrences) {
    const key = `${occurrence.kind} ${occurrence.keyBefore} ${occurrence.uci}`;
    const kept = best.get(key);
    if (!kept || occurrence.reach > kept.reach) best.set(key, occurrence);
  }
  return [...best.values()].sort((a, b) => b.reach - a.reach || a.ply - b.ply || a.order - b.order);
}

function toMove(occurrence: Occurrence): PgnRepertoireMove {
  return {
    kind: occurrence.kind,
    position_key: occurrence.keyBefore,
    ply: occurrence.ply,
    line_san: sansOf(occurrence.parent),
    move_uci: occurrence.uci,
    move_san: occurrence.san,
    reach: occurrence.reach,
    reason: occurrence.reasons.length > 0 ? occurrence.reasons.join(" ") : null,
    cp_loss: occurrence.cpLoss,
  };
}

function countMoves(
  kept: readonly Occurrence[],
  reader: PgnRepertoireReader,
  weights: WeightsTable | null,
): PgnRepertoireCounts {
  const own = kept.filter((occurrence) => occurrence.kind === "own");
  const answered = new Set(own.map((occurrence) => occurrence.keyBefore));
  const replies = kept.filter((occurrence) => occurrence.kind === "reply");
  const matched = weights ? [...weights.rows.values()].filter((row) => row.matched).length : 0;
  return {
    games: reader.games,
    own_moves: own.length,
    replies: replies.length,
    reasons: own.filter((occurrence) => occurrence.reasons.length > 0).length,
    comments_ignored: reader.commentsIgnored,
    unanswered_replies: replies.filter((reply) => !answered.has(reply.keyAfter)).length,
    deepest_ply: kept.reduce((deepest, occurrence) => Math.max(deepest, occurrence.ply), 0),
    weights_matched: matched,
    weights_unmatched: weights ? weights.total - matched : 0,
  };
}

function oversizeErrors(texts: Readonly<Record<string, string | undefined>>): PgnRepertoireError[] {
  return Object.entries(texts).flatMap(([name, text]) => {
    const bytes = Buffer.byteLength(text ?? "", "utf8");
    if (bytes <= MAX_TEXT_BYTES) return [];
    return [
      { code: "too_large", message: `the ${name} is ${bytes} bytes, over ${MAX_TEXT_BYTES}` },
    ];
  });
}

/**
 * Reads the PGN `pgn` for the student's `side`. An own move is a move of that side and a reply any
 * other. `weights`, when given, is the tab-separated text of the generator beside the file, whose
 * `reach`, `loss_cp` and `line` columns replace the reach of the own move at that line and give it
 * its centipawn loss.
 */
export function readPgnRepertoire(
  pgn: string,
  side: PgnRepertoireSide,
  weights?: string,
): PgnRepertoireResult {
  const oversize = oversizeErrors({ "PGN text": pgn, "weights text": weights });
  if (oversize.length > 0) return { errors: oversize };

  const reader = new PgnRepertoireReader(side);
  reader.read(pgn);
  const table = weights === undefined ? null : readWeights(weights);
  const errors = [...reader.errors, ...(table?.errors ?? [])];
  if (reader.occurrences.length === 0 && errors.length === 0) {
    errors.push({ code: "no_moves", message: "the text holds no moves" });
  }
  placeOccurrences(reader.occurrences, table);
  errors.push(...twoAnswersErrors(reader.occurrences));
  if (errors.length > 0) return { errors: errors.slice(0, MAX_REPORTED_ERRORS) };

  const kept = keepBestLines(reader.occurrences);
  return { moves: kept.map(toMove), counts: countMoves(kept, reader, table) };
}
