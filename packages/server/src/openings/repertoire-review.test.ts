import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../test/fakes/fake-explorer.js";
import type { Clock } from "../clock.js";
import {
  type CoachNotification,
  type RepertoireReviewNotification,
  renderNotifications,
} from "../coach/notify.js";
import { createCoachSession, listUndeliveredNotifications } from "../db/chat.js";
import {
  type GradingState,
  listMoves,
  type PlayerColor,
  recordMoveEvaluation,
  setGrading,
} from "../db/games.js";
import { type Database, openDatabase } from "../db/open.js";
import {
  introduceRepertoireCard,
  rateRepertoireCardFromGame,
  saveRepertoireCardReview,
} from "../db/repertoire-cards.js";
import { syncImportedRepertoireUnit } from "../db/repertoire-import.js";
import {
  createRepertoireVariation,
  deleteRepertoireGroupVariations,
  findFirstRepertoireVariation,
  findGameRepertoireReview,
  findRepertoireOwnMove,
  insertRepertoireOwnMove,
  listMetOpenings,
  REPERTOIRE_REBUILD_GROUP_SUFFIX,
  type RepertoireSide,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { classifyCpLoss, type PlayerMoveEvaluation } from "../engine/evaluate.js";
import type { Searcher, SearchRequest, SearchResult } from "../engine/uci.js";
import { ImportGrader } from "../import/grader.js";
import { importFinishedGame } from "../import/pgn.js";
import { RecordingLog } from "../log.js";
import {
  EXPLORER_RATINGS,
  ExplorerError,
  type ExplorerFetcher,
  ITALIAN_WHITE_RATINGS,
} from "./explorer-client.js";
import { positionKey } from "./from-games.js";
import { REPERTOIRE_SEARCH_CAP_MS } from "./from-repertoire.js";
import { parseOpeningTable } from "./names.js";
import { readPgnRepertoire } from "./pgn-repertoire.js";
import {
  type GameReviewDeps,
  reviewRepertoireGame,
  reviewRepertoireGames,
} from "./repertoire-review.js";
import {
  type GameReviewStoredMove,
  type RepertoireLookup,
  type RootedUnit,
  walkGameAgainstRepertoire,
  walkLongestFollowedUnit,
} from "./repertoire-review-walk.js";

const SETUP = ["e4", "e5", "Nf3", "Nc6", "Bc4"];
const AFTER_BC5 = [...SETUP, "Bc5"];
const AFTER_C3 = [...AFTER_BC5, "c3"];
const AFTER_NF6 = [...AFTER_C3, "Nf6"];
// The line the repertoire teaches against 3...Bc5 and the one it teaches against 3...Nf6.
const MAIN_LINE = [...AFTER_NF6, "d4", "exd4", "cxd4"];
const NF6_LINE = [...SETUP, "Nf6", "d3", "Be7", "O-O"];
// A unit rooted at 1.e4 d5, and a second Italian variation that answers 3...Bc5 with 4.d3.
const SCANDINAVIAN = ["e4", "d5"];
const AFTER_EXD5 = [...SCANDINAVIAN, "exd5"];
const SCANDINAVIAN_LINE = [...AFTER_EXD5, "Qxd5", "Nc3", "Qa5"];
const PIANISSIMO_LINE = [...AFTER_BC5, "d3", "Nf6", "O-O", "d6"];
// A trap that ends with Black mating White on ply 14.
const BLACKBURNE = [...SETUP, "Nd4", "Nxe5", "Qg5", "Nxf7", "Qxg2", "Rf1", "Qxe4+", "Be2", "Nf3#"];

function fenOf(line: string[]): string {
  const game = new Chess();
  for (const san of line) game.move(san);
  return game.fen();
}

const keyOf = (line: string[]): string => positionKey(fenOf(line));

interface LineStep {
  ply: number;
  san: string;
  uci: string;
  keyBefore: string;
  before: string[];
}

function stepsOf(line: string[]): LineStep[] {
  const game = new Chess();
  return line.map((san, index) => {
    const keyBefore = positionKey(game.fen());
    const move = game.move(san);
    const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
    return { ply: index + 1, san, uci, keyBefore, before: line.slice(0, index) };
  });
}

/** A line that never repeats a position: after the Italian moves, quiet pawn moves where it can. */
function deepLine(plies: number): string[] {
  const game = new Chess();
  const line: string[] = [];
  for (const san of AFTER_NF6) {
    game.move(san);
    line.push(san);
  }
  while (line.length < plies) {
    const quiet = game
      .moves({ verbose: true })
      .filter((move) => !move.captured && !move.promotion && !/[+#]|^O-O/.test(move.san));
    const move = quiet.find((candidate) => candidate.piece === "p") ?? quiet[0];
    if (!move) throw new Error(`the line ran out of quiet moves at ply ${line.length}`);
    game.move(move.san);
    line.push(move.san);
  }
  return line;
}

const NAMES = parseOpeningTable(
  [
    "eco\tname\tpgn\tuci\tepd",
    `B00\tKing's Pawn Game\t-\t-\t${keyOf(["e4"])}`,
    `B20\tSicilian Defense\t-\t-\t${keyOf(["e4", "c5"])}`,
    `B01\tScandinavian Defense\t-\t-\t${keyOf(SCANDINAVIAN)}`,
    `C42\tRussian Game\t-\t-\t${keyOf(["e4", "e5", "Nf3", "Nf6"])}`,
    `C60\tRuy Lopez\t-\t-\t${keyOf(["e4", "e5", "Nf3", "Nc6", "Bb5"])}`,
    `C50\tItalian Game\t-\t-\t${keyOf(SETUP)}`,
    `C53\tItalian Game: Classical Variation\t-\t-\t${keyOf(AFTER_C3)}`,
    `C52\tItalian Game: Evans Gambit\t-\t-\t${keyOf([...AFTER_BC5, "b4"])}`,
  ].join("\n"),
);

/** Answers by position and band from numbers a test writes out; anything unwritten has no games. */
class ReviewFakeExplorer implements ExplorerFetcher {
  readonly calls: Array<{ key: string; ratings: string | undefined }> = [];
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

  failAt(line: string[], ratings: string, failure: ExplorerError): this {
    this.failures.set(`${ratings}|${keyOf(line)}`, failure);
    return this;
  }

  recover(): void {
    this.failures.clear();
  }

  async fetch(fen: string, ratings?: string): Promise<string> {
    const key = positionKey(fen);
    this.calls.push({ key, ratings });
    const failure = this.failures.get(`${ratings}|${key}`);
    if (failure) throw failure;
    const empty = { white: 0, draws: 0, black: 0, moves: [] };
    return JSON.stringify(this.answers.get(`${ratings}|${key}`) ?? empty);
  }
}

/** Scores the moves a test writes out; a position nobody wrote has one forward move alone. */
class ReviewFakeEngine implements Searcher {
  readonly requests: SearchRequest[] = [];
  /** The depth every answer reports; a real engine states it, so most tests leave it unset. */
  reachedDepth: number | undefined = undefined;
  private readonly scripted = new Map<string, Array<{ moves: string[]; score: number }>>();

  write(line: string[], scores: Array<[uci: string, score: number]>): this {
    this.scripted.set(
      keyOf(line),
      scores.map(([uci, score]) => ({ moves: [uci], score })),
    );
    return this;
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    this.requests.push(request);
    const written = this.scripted.get(positionKey(request.fen));
    const lines = (written ?? forwardLines(request.fen)).slice(0, request.multipv ?? 1);
    return {
      fen: request.fen,
      bestmove: lines[0]?.moves[0] ?? null,
      lines,
      depth: this.reachedDepth,
    };
  }
}

function forwardLines(fen: string): SearchResult["lines"] {
  const moves = new Chess(fen).moves({ verbose: true });
  const move = moves.find((candidate) => candidate.piece === "p") ?? moves[0];
  return move ? [{ moves: [`${move.from}${move.to}${move.promotion ?? ""}`], score: 20 }] : [];
}

/** The stored rows of a line held in memory, so the walk is tested with no database at all. */
class ScriptedRepertoireLookup implements RepertoireLookup {
  private readonly own = new Map<string, GameReviewStoredMove>();
  private readonly replies = new Set<string>();
  private readonly replyPositions = new Set<string>();

  constructor(line: string[]) {
    for (const step of stepsOf(line)) {
      if (step.ply % 2 === 1) {
        this.own.set(step.keyBefore, {
          id: step.ply,
          move_uci: step.uci,
          move_san: step.san,
          reach: 1,
          opening_name: null,
        });
      } else {
        this.replies.add(`${step.keyBefore}|${step.uci}`);
        this.replyPositions.add(step.keyBefore);
      }
    }
  }

  ownMoveAt(key: string): GameReviewStoredMove | undefined {
    return this.own.get(key);
  }

  hasReplyAt(key: string, uci: string): boolean {
    return this.replies.has(`${key}|${uci}`);
  }

  hasAnyReplyAt(key: string): boolean {
    return this.replyPositions.has(key);
  }
}

interface PositionRow {
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
  source: string;
  cp_loss: number | null;
  eval_cp: number | null;
  eval_depth: number | null;
  wins: number | null;
  draws: number | null;
  losses: number | null;
}

interface CardRow {
  id: number;
  position_key: string;
  move_uci: string;
  introduced_at: string;
  next_review_at: string;
  interval_hours: number;
  fsrs_state: number;
  stability: number | null;
  difficulty: number | null;
  learning_step: number;
  lapses: number;
  reviews: number;
  last_reviewed_at: string | null;
}

interface ReviewRow {
  game_id: number;
  repertoire_id: number;
  reviewed_at: string;
  outcome: string;
  followed_plies: number;
  passed_moves: number;
  left_ply: number | null;
  left_position_key: string | null;
  left_san: string | null;
  left_uci: string | null;
  expected_san: string | null;
  expected_uci: string | null;
  opening_name: string | null;
  added_reply_id: number | null;
  added_answer_id: number | null;
}

const START_TIME = "2026-11-10T12:00:00.000Z";
const HOUR_MS = 3_600_000;

let tmp: string;
let db: Database;
let now: Date;
let appClock: Clock;
let explorerClock: FakeClock;
let explorer: ReviewFakeExplorer;
let engine: ReviewFakeEngine;
let logs: RecordingLog;
let repertoireId: number;
let gameCounter: number;
let coachSessionId: number;
let wakes: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-review-"));
  db = openDatabase(tmp);
  now = new Date(START_TIME);
  appClock = { now: () => now };
  explorerClock = new FakeClock();
  explorer = new ReviewFakeExplorer();
  engine = new ReviewFakeEngine();
  logs = new RecordingLog();
  gameCounter = 0;
  wakes = 0;
  coachSessionId = createCoachSession(db, { promptVersion: "v", tab: "games" }).id;
  repertoireId = createRepertoireVariation(db, {
    side: "white",
    groupName: "Italian Game",
    variationName: "Classical Variation (4.c3)",
  }).id;
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface SeedTarget {
  id: number;
  /** How many plies from the first are the unit's fixed root, stored as setup at reach 1. */
  rootPlies: number;
}

// The rows the generator stores: the fixed root comes first, White's moves and Black's replies, and
// every row after it carries the reach given. `lastPly` cuts the line short, as the depth does.
function seedLine(
  line: string[],
  reach: number,
  lastPly = line.length,
  target: SeedTarget = { id: repertoireId, rootPlies: 5 },
): void {
  for (const step of stepsOf(line)) {
    if (step.ply > lastPly) break;
    const inRoot = step.ply <= target.rootPlies;
    const place = {
      repertoireId: target.id,
      positionKey: step.keyBefore,
      ply: step.ply,
      line: step.before,
      reach: inRoot ? 1 : reach,
      openingName: null,
      uci: step.uci,
      san: step.san,
    };
    if (step.ply % 2 === 0) {
      upsertRepertoireReply(db, {
        ...place,
        share: 0.5,
        source: inRoot ? "setup" : "explorer",
      });
    } else if (!findRepertoireOwnMove(db, target.id, step.keyBefore)) {
      insertRepertoireOwnMove(db, {
        ...place,
        share: null,
        source: inRoot ? "setup" : "explorer",
        cpLoss: 0,
        evalCp: 30,
        results: null,
      });
    }
  }
}

function createUnit(groupName: string, variationName: string): number {
  return createRepertoireVariation(db, { side: "white", groupName, variationName }).id;
}

function seedScandinavian(): number {
  const id = createUnit("Scandinavian Defense", "Mieses-Kotroc Variation (2.exd5)");
  seedLine(SCANDINAVIAN_LINE, 0.4, SCANDINAVIAN_LINE.length, { id, rootPlies: 2 });
  return id;
}

function seedPianissimo(): number {
  const id = createUnit("Italian Game", "Giuoco Pianissimo (4.d3)");
  seedLine(PIANISSIMO_LINE, 0.3, PIANISSIMO_LINE.length, { id, rootPlies: 5 });
  return id;
}

function seedRepertoire(): void {
  seedLine(MAIN_LINE, 0.226);
  seedLine(NF6_LINE, 0.402);
}

function pgnOf(line: string[]): string {
  const text = line
    .map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}. ${san}` : san))
    .join(" ");
  return `[Result "1-0"]\n\n${text} 1-0`;
}

function evaluation(cpLoss: number): PlayerMoveEvaluation {
  return {
    evalBeforeCp: 10,
    evalAfterCp: 10 - cpLoss,
    cpLoss,
    classification: classifyCpLoss(cpLoss),
    bestMoveUci: "d2d4",
    bestMoveSan: "d4",
  };
}

interface GameOptions {
  color?: PlayerColor;
  /** The centipawn loss the grader recorded, by ply. */
  cpLoss?: Record<number, number>;
  grading?: GradingState;
  practice?: boolean;
}

function addGame(line: string[], options: GameOptions = {}): number {
  gameCounter += 1;
  const id = importFinishedGame(db, {
    pgn: pgnOf(line),
    playerColor: options.color ?? "white",
    source: "pgn",
    sourceId: `review-${gameCounter}`,
    ...(options.practice ? { practice: true } : {}),
  }) as number;
  for (const [ply, loss] of Object.entries(options.cpLoss ?? {})) {
    const move = listMoves(db, id).find((candidate) => candidate.ply === Number(ply));
    if (move) recordMoveEvaluation(db, move.id, evaluation(loss));
  }
  if (options.grading !== "pending") setGrading(db, id, options.grading ?? "done");
  return id;
}

const deps = (): GameReviewDeps => ({
  db,
  engine,
  fetcher: explorer,
  cacheDir: join(tmp, "explorer-cache"),
  explorerClock,
  names: NAMES,
  clock: appClock,
  log: logs,
  notifications: { sessionId: () => coachSessionId },
  onNotification: () => {
    wakes += 1;
  },
});

/** The messages waiting for the coach's games conversation, in the order they were written. */
const noticesOf = (): RepertoireReviewNotification[] =>
  listUndeliveredNotifications(db, coachSessionId).map(
    (message) => JSON.parse(message.contentJson) as RepertoireReviewNotification,
  );

const positionsOf = (): PositionRow[] =>
  db.prepare("SELECT * FROM repertoire_positions ORDER BY id").all() as PositionRow[];
const cardsOf = (): CardRow[] =>
  db.prepare("SELECT * FROM repertoire_cards ORDER BY id").all() as CardRow[];
const reviewsOf = (): ReviewRow[] =>
  db.prepare("SELECT * FROM repertoire_game_reviews ORDER BY game_id").all() as ReviewRow[];
const reviewOf = (gameId: number): ReviewRow | undefined =>
  reviewsOf().find((row) => row.game_id === gameId);

function cardAt(before: string[], san: string): CardRow | undefined {
  const step = stepsOf([...before, san]).at(-1) as LineStep;
  return cardsOf().find(
    (card) => card.position_key === step.keyBefore && card.move_uci === step.uci,
  );
}

const snapshot = () => ({ cards: cardsOf(), positions: positionsOf(), reviews: reviewsOf() });
const hoursFromNow = (hours: number): string =>
  new Date(now.getTime() + hours * HOUR_MS).toISOString();
const minutesFromNow = (minutes: number): string =>
  new Date(now.getTime() + minutes * 60_000).toISOString();

// The grades the game review rated, one row for each rating, in the order they were made.
const loggedGrades = (): { key: string; grade: number }[] =>
  (
    db.prepare("SELECT card_key, grade FROM drill_reviews ORDER BY id").all() as {
      card_key: string;
      grade: number;
    }[]
  ).map((row) => ({ key: row.card_key, grade: row.grade }));

/** What the explorer and the engine say about 3...h6, a reply too rare for the generator to store. */
function writeH6Answers(): void {
  explorer
    .write(SETUP, EXPLORER_RATINGS, { Nf6: 40200, Bc5: 22600, h6: 120 }, 100000)
    .write([...SETUP, "h6"], ITALIAN_WHITE_RATINGS, { c3: 3000, d3: 5000, "O-O": 500 }, 10000)
    .write([...SETUP, "h6", "d3"], EXPLORER_RATINGS, { Nf6: 60 }, 200);
  engine.write(
    [...SETUP, "h6"],
    [
      ["c2c3", 40],
      ["d2d3", 30],
      ["e1g1", 10],
      ["b2b4", -50],
    ],
  );
}

describe("a game that follows the repertoire", () => {
  it("rates every move of the student as passed and records the game as in book", async () => {
    seedRepertoire();
    const id = addGame(MAIN_LINE);
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({
      gameId: id,
      outcome: "in_book",
      passed: 6,
      failed: 0,
      added: 0,
    });
    expect(cardsOf().map((card) => card.reviews)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(reviewOf(id)).toMatchObject({
      outcome: "in_book",
      followed_plies: 11,
      passed_moves: 6,
      left_ply: null,
      opening_name: "Italian Game: Classical Variation",
    });
  });

  it("rates the passes up to the first different move and one failure there, then stops", async () => {
    seedRepertoire();
    const id = addGame([...AFTER_NF6, "d3", "d6", "O-O"], { cpLoss: { 9: 20 } });
    const before = positionsOf();
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({
      gameId: id,
      outcome: "departed",
      passed: 4,
      failed: 1,
      added: 0,
    });
    for (const [prefix, san] of [
      [[], "e4"],
      [["e4", "e5"], "Nf3"],
      [["e4", "e5", "Nf3", "Nc6"], "Bc4"],
      [AFTER_BC5, "c3"],
    ] as const) {
      expect(cardAt([...prefix], san)).toMatchObject({
        reviews: 1,
        fsrs_state: 1,
        learning_step: 1,
        interval_hours: 10 / 60,
        next_review_at: minutesFromNow(10),
      });
    }
    // The expected move is the card that fails; the move the student played has none.
    const failed = cardAt(AFTER_NF6, "d4");
    expect(failed).toMatchObject({
      reviews: 1,
      fsrs_state: 1,
      learning_step: 0,
      interval_hours: 1 / 60,
      next_review_at: minutesFromNow(1),
    });
    expect(failed?.difficulty).toBeCloseTo(6.4133, 4);
    expect(cardAt(AFTER_NF6, "d3")).toBeUndefined();
    expect(cardsOf()).toHaveLength(5);
    expect(positionsOf()).toEqual(before);
    // One row for each rating: Good for each stored move the game followed, Again for the one it left.
    expect(loggedGrades()).toEqual([
      { key: `${keyOf([])} e2e4`, grade: 3 },
      { key: `${keyOf(["e4", "e5"])} g1f3`, grade: 3 },
      { key: `${keyOf(["e4", "e5", "Nf3", "Nc6"])} f1c4`, grade: 3 },
      { key: `${keyOf(AFTER_BC5)} c2c3`, grade: 3 },
      { key: `${keyOf(AFTER_NF6)} d2d4`, grade: 1 },
    ]);
    expect(reviewOf(id)).toMatchObject({
      outcome: "departed",
      followed_plies: 8,
      passed_moves: 4,
      left_ply: 9,
      left_san: "d3",
      left_uci: "d2d3",
      left_position_key: keyOf(AFTER_NF6),
      expected_san: "d4",
      expected_uci: "d2d4",
    });
  });

  it("ends the walk where the repertoire holds no White move, without adding one", async () => {
    seedRepertoire();
    upsertRepertoireReply(db, {
      repertoireId,
      positionKey: keyOf(SETUP),
      ply: 6,
      line: SETUP,
      reach: 0.01,
      openingName: null,
      uci: "h7h6",
      san: "h6",
      share: 0.01,
      source: "explorer",
    });
    const before = positionsOf();
    const id = addGame([...SETUP, "h6", "d3"]);
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({
      gameId: id,
      outcome: "in_book",
      passed: 3,
      failed: 0,
      added: 0,
    });
    expect(positionsOf()).toEqual(before);
    expect(explorer.calls).toEqual([]);
    expect(engine.requests).toEqual([]);
  });

  it("counts only plies up to the depth limit", async () => {
    const line = deepLine(34);
    const id = addGame(line);
    const walk = walkGameAgainstRepertoire(listMoves(db, id), new ScriptedRepertoireLookup(line));
    expect(walk.followed).toBe(30);
    expect(walk.passes).toHaveLength(15);
    expect(walk.ending).toEqual({ kind: "game_over" });
  });
});

describe("a Black reply the repertoire lacks", () => {
  it("is stored with White's answer and the source game, and the walk stops there", async () => {
    seedRepertoire();
    writeH6Answers();
    const id = addGame([...SETUP, "h6", "c3", "Nf6", "d4"]);
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({
      gameId: id,
      outcome: "reply_added",
      passed: 3,
      failed: 0,
      added: 2,
    });
    const added = positionsOf().filter((row) => row.source === "game");
    expect(added).toHaveLength(2);
    // The reply is stored although its share is far under 1 in 50 and its games under 200.
    expect(added[0]).toMatchObject({
      kind: "reply",
      position_key: keyOf(SETUP),
      ply: 6,
      move_uci: "h7h6",
      move_san: "h6",
      line_san: JSON.stringify(SETUP),
      opening_name: "Italian Game",
    });
    expect(added[0]?.share).toBeCloseTo(0.0012, 10);
    expect(added[0]?.reach).toBeCloseTo(0.0012, 10);
    // The answer follows the generator's rule: the likeliest move within 50 cp of the engine's best,
    // which is neither the engine's own first choice nor the move the student played.
    expect(added[1]).toMatchObject({
      kind: "own",
      position_key: keyOf([...SETUP, "h6"]),
      ply: 7,
      move_uci: "d2d3",
      move_san: "d3",
      line_san: JSON.stringify([...SETUP, "h6"]),
      share: 0.5,
      cp_loss: 10,
      eval_cp: 30,
      eval_depth: null,
      wins: 100,
      draws: 8,
      losses: 92,
    });
    expect(added[1]?.reach).toBe(added[0]?.reach);
    expect(cardsOf().map((card) => card.move_uci)).toEqual(["e2e4", "g1f3", "f1c4"]);
    expect(reviewOf(id)).toMatchObject({
      outcome: "reply_added",
      followed_plies: 5,
      passed_moves: 3,
      left_ply: 6,
      left_san: "h6",
      added_reply_id: added[0]?.id,
      added_answer_id: added[1]?.id,
    });
  });

  it("is stored as a reply, yet the review read lists only the replies the line already had", async () => {
    seedRepertoire();
    writeH6Answers();
    const id = addGame([...SETUP, "h6", "c3", "Nf6", "d4"]);
    await reviewRepertoireGame(deps(), id);
    const repliesHere = positionsOf().filter(
      (row) => row.kind === "reply" && row.position_key === keyOf(SETUP),
    );
    expect(repliesHere.map((row) => row.move_san).sort()).toEqual(["Bc5", "Nf6", "h6"]);
    const review = findGameRepertoireReview(db, id);
    expect(review?.left).toMatchObject({ by: "opponent", played_san: "h6" });
    expect(review?.left?.stored_replies).toEqual(["Bc5", "Nf6"]);
  });

  it("searches White's answer under the generator's cap and stores the depth it reached", async () => {
    seedRepertoire();
    writeH6Answers();
    engine.reachedDepth = 9;
    await reviewRepertoireGame(deps(), addGame([...SETUP, "h6", "c3", "Nf6", "d4"]));
    expect(engine.requests.map((request) => request.capMs)).toEqual([REPERTOIRE_SEARCH_CAP_MS]);
    const answer = positionsOf().find((row) => row.kind === "own" && row.source === "game");
    expect(answer?.eval_depth).toBe(9);
    // A Black reply has no engine score, so no depth either.
    const reply = positionsOf().find((row) => row.kind === "reply" && row.source === "game");
    expect(reply?.eval_depth).toBeNull();
  });

  it("takes the reach of the move before it times its own share", async () => {
    seedRepertoire();
    explorer
      .write(AFTER_C3, EXPLORER_RATINGS, { Nf6: 3000, d6: 250, Qe7: 10 }, 5000)
      .write([...AFTER_C3, "Qe7"], ITALIAN_WHITE_RATINGS, { d4: 700 }, 1000);
    engine.write([...AFTER_C3, "Qe7"], [["d2d4", 30]]);
    await reviewRepertoireGame(deps(), addGame([...AFTER_C3, "Qe7", "d4"]));
    const reply = positionsOf().find((row) => row.kind === "reply" && row.move_san === "Qe7");
    // 4.c3 is stored at 0.226 and Qe7 is 10 games of 5000.
    expect(reply?.reach).toBeCloseTo(0.226 * (10 / 5000), 10);
  });

  it("is stored with no share and no reach when the explorer does not list it", async () => {
    seedRepertoire();
    explorer.write([...SETUP, "h6"], ITALIAN_WHITE_RATINGS, { d3: 100 }, 100);
    engine.write([...SETUP, "h6"], [["d2d3", 30]]);
    await reviewRepertoireGame(deps(), addGame([...SETUP, "h6", "d3"]));
    const reply = positionsOf().find((row) => row.kind === "reply" && row.move_san === "h6");
    expect(reply).toMatchObject({ share: null, reach: 0, source: "game" });
  });

  it("is stored alone when the position after it already holds a White move", async () => {
    seedRepertoire();
    const whiteAnswer = stepsOf([...SETUP, "h6", "d3"])[6] as LineStep;
    insertRepertoireOwnMove(db, {
      repertoireId,
      positionKey: whiteAnswer.keyBefore,
      ply: 7,
      line: [...SETUP, "h6"],
      reach: 0.3,
      openingName: null,
      uci: "d2d3",
      san: "d3",
      share: null,
      source: "explorer",
      cpLoss: 0,
      evalCp: 20,
      results: null,
    });
    explorer.write(SETUP, EXPLORER_RATINGS, { h6: 1000 }, 10000);
    const result = await reviewRepertoireGame(deps(), addGame([...SETUP, "h6", "c3"]));
    expect(result).toMatchObject({ outcome: "reply_added", added: 1 });
    expect(positionsOf().filter((row) => row.source === "game")).toHaveLength(1);
    expect(engine.requests).toEqual([]);
  });

  it("is not stored when its White answer would fall past the depth limit", async () => {
    seedLine(deepLine(29), 0.1, 29);
    const before = positionsOf();
    const id = addGame(deepLine(30));
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({ outcome: "in_book", added: 0 });
    expect(positionsOf()).toEqual(before);
    expect(reviewOf(id)).toMatchObject({ outcome: "in_book", followed_plies: 29 });
    expect(explorer.calls).toEqual([]);
    expect(engine.requests).toEqual([]);
  });

  it("is not stored when it leaves White no move to answer with", async () => {
    seedLine(BLACKBURNE, 0.01, 13);
    expect(new Chess(fenOf(BLACKBURNE)).isCheckmate()).toBe(true);
    const before = positionsOf();
    const id = addGame(BLACKBURNE);
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({
      gameId: id,
      outcome: "reply_not_stored",
      passed: 7,
      failed: 0,
      added: 0,
    });
    expect(positionsOf()).toEqual(before);
    expect(reviewOf(id)).toMatchObject({
      outcome: "reply_not_stored",
      left_ply: 14,
      left_san: "Nf3#",
    });
    // Only the reply's own share was asked for: no answer was looked up or searched.
    expect(explorer.calls).toHaveLength(1);
    expect(engine.requests).toEqual([]);
  });
});

describe("a game that never reaches the variation", () => {
  it.each([
    {
      why: "Black's first reply is not the one the repertoire teaches",
      line: ["e4", "c5", "Nf3", "d6"],
      followed: 1,
      left: { ply: 2, san: "c5", uci: "c7c5" },
      opening: "Sicilian Defense",
    },
    {
      why: "Black's second reply is not the one the repertoire teaches",
      line: ["e4", "e5", "Nf3", "Nf6", "Nxe5"],
      followed: 3,
      left: { ply: 4, san: "Nf6", uci: "g8f6" },
      opening: "Russian Game",
    },
    {
      why: "the student plays another third move",
      line: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"],
      followed: 4,
      left: { ply: 5, san: "Bb5", uci: "f1b5" },
      opening: "Ruy Lopez",
    },
    {
      why: "the game ends before the variation starts",
      line: ["e4", "e5", "Nf3"],
      followed: 3,
      left: null,
      opening: "King's Pawn Game",
    },
  ])("changes nothing when $why, and records where it left", async (scenario) => {
    seedRepertoire();
    const before = snapshot();
    const id = addGame(scenario.line);
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({
      gameId: id,
      outcome: "not_reached",
      passed: 0,
      failed: 0,
      added: 0,
    });
    expect(positionsOf()).toEqual(before.positions);
    expect(cardsOf()).toEqual([]);
    expect(explorer.calls).toEqual([]);
    expect(engine.requests).toEqual([]);
    expect(reviewOf(id)).toMatchObject({
      outcome: "not_reached",
      followed_plies: scenario.followed,
      passed_moves: 0,
      left_ply: scenario.left?.ply ?? null,
      left_san: scenario.left?.san ?? null,
      left_uci: scenario.left?.uci ?? null,
      opening_name: scenario.opening,
    });
  });

  it("is counted in the log event next to the games that did reach it", async () => {
    seedRepertoire();
    addGame(["e4", "c5"]);
    addGame(["e4", "e5", "Nf3", "Nf6"]);
    addGame(MAIN_LINE);
    addGame([...AFTER_NF6, "d3"]);
    const summary = await reviewRepertoireGames(deps());
    expect(summary.outcomes).toMatchObject({ not_reached: 2, in_book: 1, departed: 1 });
    expect(logs.named("repertoire.review")[0]?.fields).toMatchObject({
      reviewed: 4,
      not_reached: 2,
      reached_start: 2,
    });
  });
});

describe("a game played as Black", () => {
  it("is recorded and changes nothing, and is counted neither way", async () => {
    seedRepertoire();
    const before = positionsOf();
    const id = addGame(MAIN_LINE, { color: "black" });
    const summary = await reviewRepertoireGames(deps());
    expect(summary.outcomes.other_side).toBe(1);
    expect(positionsOf()).toEqual(before);
    expect(cardsOf()).toEqual([]);
    expect(reviewOf(id)).toMatchObject({
      outcome: "other_side",
      followed_plies: 0,
      passed_moves: 0,
      left_ply: null,
    });
    expect(logs.named("repertoire.review")[0]?.fields).toMatchObject({
      other_side: 1,
      not_reached: 0,
      reached_start: 0,
    });
  });
});

describe("a game that reaches the root of another unit", () => {
  it("is compared with that unit, rates its moves and stores that unit's id", async () => {
    seedRepertoire();
    const scandinavianId = seedScandinavian();
    const id = addGame(AFTER_EXD5);
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({
      gameId: id,
      repertoireId: scandinavianId,
      outcome: "in_book",
      passed: 2,
      failed: 0,
      added: 0,
    });
    expect(reviewOf(id)).toMatchObject({
      repertoire_id: scandinavianId,
      outcome: "in_book",
      followed_plies: 3,
      passed_moves: 2,
      opening_name: "Scandinavian Defense",
    });
    expect(cardsOf()).toHaveLength(2);
    expect(cardAt([], "e4")).toMatchObject({ reviews: 1, learning_step: 1 });
    expect(cardAt(SCANDINAVIAN, "exd5")).toMatchObject({ reviews: 1, learning_step: 1 });
  });

  it("fails the move that unit expected where the student left it", async () => {
    seedRepertoire();
    const scandinavianId = seedScandinavian();
    const id = addGame([...AFTER_EXD5, "Qxd5", "Bc4"]);
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({ repertoireId: scandinavianId, outcome: "departed", failed: 1 });
    expect(reviewOf(id)).toMatchObject({
      repertoire_id: scandinavianId,
      outcome: "departed",
      followed_plies: 4,
      left_san: "Bc4",
      expected_san: "Nc3",
    });
    expect(cardAt([...AFTER_EXD5, "Qxd5"], "Nc3")).toMatchObject({
      reviews: 1,
      learning_step: 0,
      interval_hours: 1 / 60,
    });
  });

  it("tells the coach which unit it was compared with", async () => {
    seedRepertoire();
    seedScandinavian();
    await reviewRepertoireGame(deps(), addGame(AFTER_EXD5));
    expect(noticesOf()).toEqual([
      expect.objectContaining({
        outcome: "in_book",
        group: "Scandinavian Defense",
        variation: "Mieses-Kotroc Variation (2.exd5)",
        followed_to: { ply: 3, san: "exd5" },
      }),
    ]);
  });

  it("adds a reply the unit lacks, with White's answer, to that unit and no other", async () => {
    seedRepertoire();
    const scandinavianId = seedScandinavian();
    const italianBefore = positionsOf().filter((row) => row.repertoire_id === repertoireId);
    explorer
      .write(AFTER_EXD5, EXPLORER_RATINGS, { Qxd5: 6000, Nf6: 3000, c6: 100 }, 10000)
      .write([...AFTER_EXD5, "Nf6"], ITALIAN_WHITE_RATINGS, { d4: 700, c4: 50 }, 1000);
    engine.write(
      [...AFTER_EXD5, "Nf6"],
      [
        ["d2d4", 30],
        ["c2c4", 10],
      ],
    );
    const id = addGame([...AFTER_EXD5, "Nf6", "d4"]);
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({
      repertoireId: scandinavianId,
      outcome: "reply_added",
      passed: 2,
      added: 2,
    });
    const added = positionsOf().filter((row) => row.source === "game");
    expect(added.map((row) => [row.repertoire_id, row.kind, row.ply, row.move_san])).toEqual([
      [scandinavianId, "reply", 4, "Nf6"],
      [scandinavianId, "own", 5, "d4"],
    ]);
    // 3.exd5 is stored at 0.4 and Nf6 is 3000 games of 10000.
    expect(added[0]?.reach).toBeCloseTo(0.4 * 0.3, 10);
    expect(positionsOf().filter((row) => row.repertoire_id === repertoireId)).toEqual(
      italianBefore,
    );
    expect(reviewOf(id)).toMatchObject({
      repertoire_id: scandinavianId,
      outcome: "reply_added",
      added_reply_id: added[0]?.id,
      added_answer_id: added[1]?.id,
    });
  });

  it("answers a reply it adds with the move played most within the margin, not the Italian's 3.Bc4", async () => {
    seedRepertoire();
    seedScandinavian();
    // 3.Bc4 is within 50 cp of the engine's best, as it is in the Italian, but d4 is played more.
    explorer
      .write(AFTER_EXD5, EXPLORER_RATINGS, { Qxd5: 6000, Nf6: 3000 }, 10000)
      .write([...AFTER_EXD5, "Nf6"], ITALIAN_WHITE_RATINGS, { d4: 700, Bc4: 200 }, 1000);
    engine.write(
      [...AFTER_EXD5, "Nf6"],
      [
        ["d2d4", 30],
        ["f1c4", 20],
      ],
    );
    await reviewRepertoireGame(deps(), addGame([...AFTER_EXD5, "Nf6", "d4"]));
    const answer = positionsOf().find((row) => row.kind === "own" && row.source === "game");
    expect(answer).toMatchObject({ ply: 5, move_san: "d4" });
  });

  it("is still recorded against the Italian when the student played Black", async () => {
    seedRepertoire();
    seedScandinavian();
    const id = addGame(AFTER_EXD5, { color: "black" });
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({ outcome: "other_side", repertoireId });
    expect(reviewOf(id)).toMatchObject({ repertoire_id: repertoireId, outcome: "other_side" });
    expect(cardsOf()).toEqual([]);
  });

  it("names the unit in the log of each review", async () => {
    seedRepertoire();
    const scandinavianId = seedScandinavian();
    const italian = addGame(MAIN_LINE);
    const scandinavian = addGame(AFTER_EXD5);
    await reviewRepertoireGames(deps());
    expect(
      logs
        .named("repertoire.game_reviewed")
        .map((event) => [event.fields.game_id, event.fields.repertoire_id]),
    ).toEqual([
      [italian, repertoireId],
      [scandinavian, scandinavianId],
    ]);
  });
});

// A unit read from a PGN file is the student's own line: reviews compare games against it
// read-only (never adding rows or calling the explorer or engine), while generated-only lookups
// still exclude it by origin.
describe("an imported unit", () => {
  const LONDON_LINE = [
    "d4",
    "d5",
    "Bf4",
    "Nc6",
    "e3",
    "e6",
    "Nf3",
    "Bd6",
    "Bg3",
    "Nf6",
    "Nbd2",
    "O-O",
    "Bd3",
  ];
  const CARO_KANN_LINE = ["e4", "c6", "d4", "d5", "Nc3", "dxe4"];

  function importUnit(groupName: string, variationName: string, line: string[], rootPlies: number) {
    const id = createUnit(groupName, variationName);
    seedLine(line, 0.4, line.length, { id, rootPlies });
    db.prepare("UPDATE repertoires SET origin = 'pgn' WHERE id = ?").run(id);
    return id;
  }

  function importPgnUnit(
    side: RepertoireSide,
    group: string,
    variation: string,
    pgn: string,
  ): number {
    const parsed = readPgnRepertoire(pgn, side);
    if (!parsed.moves) throw new Error(`fixture PGN failed: ${JSON.stringify(parsed.errors)}`);
    const synced = syncImportedRepertoireUnit(
      db,
      { side, group, variation },
      parsed.moves,
      START_TIME,
      false,
    );
    if (!synced.ok) throw new Error(`fixture sync failed: ${synced.code}: ${synced.message}`);
    return synced.summary.repertoire_id;
  }

  it("reviews the London departure with six Good grades, one Again grade and no added moves", async () => {
    seedRepertoire();
    const londonId = importPgnUnit(
      "white",
      "London System",
      "Main lines",
      "1. d4 d5 2. Bf4 Nc6 3. e3 e6 4. Nf3 Bd6 5. Bg3 Nf6 6. Nbd2 O-O 7. Bd3 *",
    );
    const positionsBefore = positionsOf();
    const gameId = addGame([...LONDON_LINE.slice(0, 12), "c3", "Re8"]);

    const result = await reviewRepertoireGame(deps(), gameId);

    expect(result).toMatchObject({
      gameId,
      repertoireId: londonId,
      outcome: "departed",
      passed: 6,
      failed: 1,
      added: 0,
      notified: true,
    });
    expect(reviewOf(gameId)).toMatchObject({
      repertoire_id: londonId,
      outcome: "departed",
      followed_plies: 12,
      passed_moves: 6,
      left_ply: 13,
      left_position_key: keyOf(LONDON_LINE.slice(0, 12)),
      left_san: "c3",
      left_uci: "c2c3",
      expected_san: "Bd3",
      expected_uci: "f1d3",
      added_reply_id: null,
      added_answer_id: null,
    });
    const grades = loggedGrades();
    expect(grades.filter((row) => row.grade === 3)).toHaveLength(6);
    expect(grades.filter((row) => row.grade === 1)).toHaveLength(1);
    expect(grades.at(-1)).toEqual({
      key: `${keyOf(LONDON_LINE.slice(0, 12))} f1d3`,
      grade: 1,
    });
    expect(positionsOf()).toEqual(positionsBefore);
    expect(explorer.calls).toEqual([]);
    expect(engine.requests).toEqual([]);
  });

  it("records in_book, departed and reply_not_stored for a White imported unit without mutating it", async () => {
    seedRepertoire();
    const londonId = importPgnUnit(
      "white",
      "London System",
      "Main lines",
      "1. d4 d5 2. Bf4 Nc6 3. e3 *",
    );
    const positionsBefore = positionsOf();

    // Game continues past the end of the stored line (no replies stored after 3. e3) -> in_book.
    const inBookGame = addGame(["d4", "d5", "Bf4", "Nc6", "e3", "e6", "Nf3"]);
    // Student departs at 2. c4 where 2. Bf4 is stored -> departed.
    const departedGame = addGame(["d4", "d5", "c4", "e6"]);
    // Opponent departs at 2... c5 where 2... Nc6 is stored -> reply_not_stored.
    const replyMissingGame = addGame(["d4", "d5", "Bf4", "c5", "e3"]);

    const summary = await reviewRepertoireGames(deps());

    expect(summary.outcomes).toMatchObject({
      in_book: 1,
      departed: 1,
      reply_not_stored: 1,
      reply_added: 0,
      not_reached: 0,
      other_side: 0,
    });
    expect(summary.addedPositions).toBe(0);
    expect(reviewOf(inBookGame)).toMatchObject({
      repertoire_id: londonId,
      outcome: "in_book",
      followed_plies: 5,
      passed_moves: 3,
      left_ply: null,
      left_position_key: null,
      left_san: null,
      left_uci: null,
      expected_san: null,
      expected_uci: null,
      added_reply_id: null,
      added_answer_id: null,
    });
    expect(reviewOf(departedGame)).toMatchObject({
      repertoire_id: londonId,
      outcome: "departed",
      followed_plies: 2,
      passed_moves: 1,
      left_ply: 3,
      left_san: "c4",
      left_uci: "c2c4",
      expected_san: "Bf4",
      expected_uci: "c1f4",
      added_reply_id: null,
      added_answer_id: null,
    });
    expect(reviewOf(replyMissingGame)).toMatchObject({
      repertoire_id: londonId,
      outcome: "reply_not_stored",
      followed_plies: 3,
      passed_moves: 2,
      left_ply: 4,
      left_position_key: keyOf(["d4", "d5", "Bf4"]),
      left_san: "c5",
      left_uci: "c7c5",
      expected_san: null,
      expected_uci: null,
      added_reply_id: null,
      added_answer_id: null,
    });
    expect(positionsOf()).toEqual(positionsBefore);
    expect(explorer.calls).toEqual([]);
    expect(engine.requests).toEqual([]);
  });

  it("reviews a Black game against an imported Black unit across all three outcomes instead of other_side", async () => {
    seedRepertoire();
    const caroId = importPgnUnit(
      "black",
      "Caro-Kann Defense",
      "Main lines",
      "1. e4 c6 2. d4 d5 3. Nc3 dxe4 *",
    );
    const positionsBefore = positionsOf();

    // Continues past 3... dxe4 (no replies stored after ply 6) -> in_book.
    const inBookGame = addGame([...CARO_KANN_LINE, "Nxe4", "Bf5"], { color: "black" });
    // Student plays 3... Bf5 where 3... dxe4 is stored -> departed.
    const departedGame = addGame(["e4", "c6", "d4", "d5", "Nc3", "Bf5"], { color: "black" });
    // Opponent plays 3. e5 where 3. Nc3 is stored -> reply_not_stored.
    const replyMissingGame = addGame(["e4", "c6", "d4", "d5", "e5", "Bf5"], { color: "black" });
    // Black plays 1... e5 (did not follow student's first move 1... c6) -> falls through to other_side.
    const otherGame = addGame(["e4", "e5", "Nf3", "Nc6"], { color: "black" });

    const summary = await reviewRepertoireGames(deps());

    expect(summary.outcomes).toMatchObject({
      in_book: 1,
      departed: 1,
      reply_not_stored: 1,
      other_side: 1,
    });
    expect(reviewOf(inBookGame)).toMatchObject({
      repertoire_id: caroId,
      outcome: "in_book",
      followed_plies: 6,
      passed_moves: 3,
      left_ply: null,
      expected_san: null,
      added_reply_id: null,
      added_answer_id: null,
    });
    expect(reviewOf(departedGame)).toMatchObject({
      repertoire_id: caroId,
      outcome: "departed",
      followed_plies: 5,
      passed_moves: 2,
      left_ply: 6,
      left_san: "Bf5",
      left_uci: "c8f5",
      expected_san: "dxe4",
      expected_uci: "d5e4",
      added_reply_id: null,
      added_answer_id: null,
    });
    expect(reviewOf(replyMissingGame)).toMatchObject({
      repertoire_id: caroId,
      outcome: "reply_not_stored",
      followed_plies: 4,
      passed_moves: 2,
      left_ply: 5,
      left_san: "e5",
      left_uci: "e4e5",
      expected_san: null,
      expected_uci: null,
      added_reply_id: null,
      added_answer_id: null,
    });
    expect(reviewOf(otherGame)).toMatchObject({
      repertoire_id: repertoireId,
      outcome: "other_side",
      followed_plies: 0,
      passed_moves: 0,
    });
    expect(cardAt(["e4"], "c6")).toMatchObject({ reviews: 1 });
    expect(cardAt(["e4", "c6", "d4"], "d5")).toMatchObject({ reviews: 1 });
    // 3... dxe4 was passed in the first game (learning step 1), then missed in the second -> back to step 0.
    expect(cardAt(["e4", "c6", "d4", "d5", "Nc3"], "dxe4")).toMatchObject({
      reviews: 2,
      fsrs_state: 1,
      learning_step: 0,
      interval_hours: 1 / 60,
    });
    expect(loggedGrades()).toEqual([
      { key: `${keyOf(["e4"])} c7c6`, grade: 3 },
      { key: `${keyOf(["e4", "c6", "d4"])} d7d5`, grade: 3 },
      { key: `${keyOf(["e4", "c6", "d4", "d5", "Nc3"])} d5e4`, grade: 3 },
      { key: `${keyOf(["e4", "c6", "d4", "d5", "Nc3"])} d5e4`, grade: 1 },
    ]);
    expect(positionsOf()).toEqual(positionsBefore);
    expect(explorer.calls).toEqual([]);
    expect(engine.requests).toEqual([]);
  });

  it("picks the imported unit with the most followed plies and breaks ties by lowest id", async () => {
    seedRepertoire();
    const londonId = importPgnUnit(
      "white",
      "London System",
      "Main lines",
      "1. d4 d5 2. Bf4 Nf6 3. e3 *",
    );
    const englundId = importPgnUnit(
      "white",
      "Englund Gambit",
      "Against 1...e5",
      "1. d4 e5 2. dxe5 Nc6 3. Nf3 *",
    );
    const secondLondonId = importPgnUnit(
      "white",
      "London System",
      "Side lines",
      "1. d4 d5 2. Bf4 c5 3. e3 *",
    );
    expect(londonId).toBeLessThan(englundId);
    expect(englundId).toBeLessThan(secondLondonId);

    const englundGame = addGame(["d4", "e5", "dxe5", "Nc6", "Nf3"]);
    const sideLineGame = addGame(["d4", "d5", "Bf4", "c5", "e3"]);
    // Ties between londonId and secondLondonId at 3 followed plies (1. d4 d5 2. Bf4) -> lowest id wins.
    const tiedGame = addGame(["d4", "d5", "Bf4", "e6", "e3"]);

    await reviewRepertoireGames(deps());

    expect(reviewOf(englundGame)).toMatchObject({
      repertoire_id: englundId,
      outcome: "in_book",
      followed_plies: 5,
    });
    expect(reviewOf(sideLineGame)).toMatchObject({
      repertoire_id: secondLondonId,
      outcome: "in_book",
      followed_plies: 5,
    });
    expect(reviewOf(tiedGame)).toMatchObject({
      repertoire_id: londonId,
      outcome: "reply_not_stored",
      followed_plies: 3,
      left_ply: 4,
      left_san: "e6",
    });
  });

  it("walks an imported unit past ply 30 with no ply limit", async () => {
    db.prepare("DELETE FROM repertoires").run();
    const line36 = deepLine(36);
    const unitId = importPgnUnit(
      "white",
      "Deep Opening",
      "Past ply 30",
      `${line36.map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}. ${san}` : san)).join(" ")} *`,
    );

    const inBookGame = addGame(line36);
    // Diverge at ply 35 (White's 18th move) with another legal move.
    const boardBefore35 = new Chess(fenOf(line36.slice(0, 34)));
    const altWhite = boardBefore35.moves({ verbose: true }).find((move) => move.san !== line36[34]);
    if (!altWhite) throw new Error("expected an alternative move at ply 35");
    const departedGame = addGame([...line36.slice(0, 34), altWhite.san]);

    // Diverge at ply 32 (Black's 16th move) with another legal reply.
    const boardBefore32 = new Chess(fenOf(line36.slice(0, 31)));
    const altBlack = boardBefore32.moves({ verbose: true }).find((move) => move.san !== line36[31]);
    if (!altBlack) throw new Error("expected an alternative reply at ply 32");
    const replyMissingGame = addGame([...line36.slice(0, 31), altBlack.san]);

    await reviewRepertoireGames(deps());

    expect(reviewOf(inBookGame)).toMatchObject({
      repertoire_id: unitId,
      outcome: "in_book",
      followed_plies: 36,
      passed_moves: 18,
      left_ply: null,
    });
    expect(reviewOf(departedGame)).toMatchObject({
      repertoire_id: unitId,
      outcome: "departed",
      followed_plies: 34,
      passed_moves: 17,
      left_ply: 35,
      left_san: altWhite.san,
      expected_san: line36[34],
    });
    expect(reviewOf(replyMissingGame)).toMatchObject({
      repertoire_id: unitId,
      outcome: "reply_not_stored",
      followed_plies: 31,
      passed_moves: 16,
      left_ply: 32,
      left_san: altBlack.san,
      expected_san: null,
    });
  });

  it("runs in a database with no generated unit at all and leaves non-matching games unreviewed", async () => {
    db.prepare("DELETE FROM repertoires").run();
    const londonId = importPgnUnit("white", "London System", "Main lines", "1. d4 d5 2. Bf4 *");
    const caroId = importPgnUnit("black", "Caro-Kann Defense", "Main lines", "1. e4 c6 2. d4 d5 *");

    const londonGame = addGame(["d4", "d5", "Bf4"]);
    const caroGame = addGame(["e4", "c6", "d4", "d5"], { color: "black" });
    const unrelatedWhite = addGame(["e4", "e5", "Nf3", "Nc6"]);
    const unrelatedBlack = addGame(["e4", "e5", "Nf3", "Nc6"], { color: "black" });

    const summary = await reviewRepertoireGames(deps());

    expect(summary.reviewed).toBe(2);
    expect(summary.outcomes).toMatchObject({ in_book: 2 });
    expect(reviewOf(londonGame)).toMatchObject({
      repertoire_id: londonId,
      outcome: "in_book",
      followed_plies: 3,
      passed_moves: 2,
    });
    expect(reviewOf(caroGame)).toMatchObject({
      repertoire_id: caroId,
      outcome: "in_book",
      followed_plies: 4,
      passed_moves: 2,
    });
    expect(reviewOf(unrelatedWhite)).toBeUndefined();
    expect(reviewOf(unrelatedBlack)).toBeUndefined();
    expect(explorer.calls).toEqual([]);
    expect(engine.requests).toEqual([]);
  });

  it("leaves games that follow no imported unit on the exact existing generated path", async () => {
    seedRepertoire();
    const italianBefore = addGame(MAIN_LINE);
    const sicilianBefore = addGame(["e4", "c5", "Nf3", "d6"]);
    await reviewRepertoireGames(deps());
    const expectedItalian = reviewOf(italianBefore);
    const expectedSicilian = reviewOf(sicilianBefore);

    // Re-run in a clean state with imported White and Black units present alongside the Italian.
    db.prepare("DELETE FROM repertoire_game_reviews").run();
    db.prepare("DELETE FROM repertoire_cards").run();
    db.prepare("DELETE FROM drill_reviews").run();
    importPgnUnit("white", "London System", "Main lines", "1. d4 d5 2. Bf4 *");
    importPgnUnit("black", "Caro-Kann Defense", "Main lines", "1. e4 c6 2. d4 d5 *");

    await reviewRepertoireGames(deps());

    expect(reviewOf(italianBefore)).toEqual(expectedItalian);
    expect(reviewOf(sicilianBefore)).toEqual(expectedSicilian);
  });

  it("does not review a game again once it already has a review row", async () => {
    db.prepare("DELETE FROM repertoires").run();
    importPgnUnit("white", "London System", "Main lines", "1. d4 d5 2. Bf4 Nc6 3. e3 *");
    const gameId = addGame(["d4", "d5", "c4", "e6"]);

    expect((await reviewRepertoireGames(deps())).reviewed).toBe(1);
    const afterFirst = snapshot();
    const gradesAfterFirst = loggedGrades();
    const noticesAfterFirst = noticesOf();

    expect((await reviewRepertoireGames(deps())).reviewed).toBe(0);
    expect(await reviewRepertoireGame(deps(), gameId)).toBeNull();
    expect(snapshot()).toEqual(afterFirst);
    expect(loggedGrades()).toEqual(gradesAfterFirst);
    expect(noticesOf()).toEqual(noticesAfterFirst);
  });

  it("writes coach notifications naming the imported unit without saying the repertoire changed", async () => {
    db.prepare("DELETE FROM repertoires").run();
    importPgnUnit("white", "London System", "Main lines", "1. d4 d5 2. Bf4 Nc6 3. e3 *");
    importPgnUnit("black", "Caro-Kann Defense", "Main lines", "1. e4 c6 2. d4 d5 3. Nc3 dxe4 *");

    addGame(["d4", "d5", "Bf4", "Nc6", "e3"]);
    addGame(["d4", "d5", "c4", "e6"]);
    addGame(["e4", "c6", "d4", "d5", "e5", "Bf5"], { color: "black" });

    await reviewRepertoireGames(deps());

    const notices = noticesOf();
    expect(notices).toEqual([
      expect.objectContaining({
        group: "London System",
        variation: "Main lines",
        origin: "pgn",
        outcome: "in_book",
        followed_to: { ply: 5, san: "e3" },
      }),
      expect.objectContaining({
        group: "London System",
        variation: "Main lines",
        origin: "pgn",
        outcome: "departed",
        played: { ply: 3, san: "c4" },
        expected: { ply: 3, san: "Bf4" },
      }),
      expect.objectContaining({
        group: "Caro-Kann Defense",
        variation: "Main lines",
        origin: "pgn",
        outcome: "reply_not_stored",
        reply: { ply: 5, san: "e5" },
      }),
    ]);
    const rendered = notices.map((notice) => renderNotifications([notice as CoachNotification]));
    expect(rendered[0]).toContain("London System");
    expect(rendered[0]).toContain("Main lines");
    expect(rendered[0]).toContain("stayed in the line");
    expect(rendered[1]).toContain("2. c4");
    expect(rendered[1]).toContain("2. Bf4");
    expect(rendered[2]).toContain("Caro-Kann Defense");
    expect(rendered[2]).toContain("3. e5");
    expect(rendered[2]).toContain("no answer to");
    for (const text of rendered) {
      expect(text).not.toMatch(/was added|repertoire changed/i);
    }
  });

  it("is not the variation that the lookups of a group find, whatever its id", () => {
    db.prepare("DELETE FROM repertoires").run();
    const importedId = importUnit("Italian Game", "Imported line", MAIN_LINE, 5);
    repertoireId = createUnit("Italian Game", "Classical Variation (4.c3)");

    expect(importedId).toBeLessThan(repertoireId);
    expect(findFirstRepertoireVariation(db, "white", "Italian Game")).toMatchObject({
      id: repertoireId,
      variation_name: "Classical Variation (4.c3)",
    });
  });

  it("is not named the unit of a root met in games, whatever its id", async () => {
    seedRepertoire();
    await reviewRepertoireGame(deps(), addGame(AFTER_EXD5));
    const importedId = importUnit("Scandinavian Defense", "Imported line", SCANDINAVIAN_LINE, 2);
    const met = (repertoire: number | null) => [
      {
        root: SCANDINAVIAN,
        openingName: "Scandinavian Defense",
        games: 1,
        repertoireId: repertoire,
      },
    ];

    expect(listMetOpenings(db)).toEqual(met(null));

    const generatedId = seedScandinavian();
    expect(importedId).toBeLessThan(generatedId);
    expect(listMetOpenings(db)).toEqual(met(generatedId));
  });
});

describe("two variations that share a root", () => {
  it("reviews the game against the one it followed for more plies", async () => {
    seedRepertoire();
    const pianissimoId = seedPianissimo();
    const id = addGame(PIANISSIMO_LINE);
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({
      repertoireId: pianissimoId,
      outcome: "in_book",
      passed: 5,
      failed: 0,
    });
    expect(reviewOf(id)).toMatchObject({
      repertoire_id: pianissimoId,
      outcome: "in_book",
      followed_plies: 10,
      passed_moves: 5,
    });
    // The first three moves are stored by both variations and share their cards, so each is rated
    // once, and the move the Classical variation expected there is not rated at all.
    expect(cardsOf().map((card) => card.reviews)).toEqual([1, 1, 1, 1, 1]);
    expect(cardAt(AFTER_BC5, "c3")).toBeUndefined();
    expect(explorer.calls).toEqual([]);
    expect(engine.requests).toEqual([]);
  });

  it("keeps the lower id when both followed the game for as many plies", async () => {
    seedRepertoire();
    seedPianissimo();
    const id = addGame([...AFTER_BC5, "b4", "Bxb4"], { cpLoss: { 7: 25 } });
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({ repertoireId, outcome: "departed", passed: 3, failed: 1 });
    expect(reviewOf(id)).toMatchObject({
      repertoire_id: repertoireId,
      followed_plies: 6,
      left_san: "b4",
      expected_san: "c3",
    });
    expect(cardAt(AFTER_BC5, "c3")).toMatchObject({ reviews: 1, learning_step: 0 });
    expect(cardAt(AFTER_BC5, "d3")).toBeUndefined();
  });

  it("asks the explorer and the engine for the variation it chose only", async () => {
    seedRepertoire();
    // The Classical variation stops at 6.cxd4 and lacks the reply 6...Bb4+ that the game plays, so
    // planning it would ask for an answer; this variation holds the reply and is the one chosen.
    const longer = [...MAIN_LINE, "Bb4+", "Bd2"];
    const longerId = createUnit("Italian Game", "Giuoco Piano (6...Bb4+)");
    seedLine(longer, 0.2, longer.length, { id: longerId, rootPlies: 5 });
    const result = await reviewRepertoireGame(deps(), addGame(longer));
    expect(result).toMatchObject({ repertoireId: longerId, outcome: "in_book", added: 0 });
    expect(reviewOf(result?.gameId as number)).toMatchObject({ followed_plies: 13 });
    expect(explorer.calls).toEqual([]);
    expect(engine.requests).toEqual([]);
  });

  it("lets the first variation keep a game that stays in its own line", async () => {
    seedRepertoire();
    seedPianissimo();
    const id = addGame(MAIN_LINE);
    await reviewRepertoireGame(deps(), id);
    expect(reviewOf(id)).toMatchObject({ repertoire_id: repertoireId, outcome: "in_book" });
  });
});

describe("a game graded while a rebuild's copy exists", () => {
  const COPY_GROUP = `Italian Game${REPERTOIRE_REBUILD_GROUP_SUFFIX}`;

  it("gets one review row, against the unit, which the copy's removal leaves in place", async () => {
    seedRepertoire();
    // The rebuild already answers 3...Bc5 with the game's 4.d3, so the copy follows the game furthest.
    const copy = createUnit(COPY_GROUP, "Giuoco Pianissimo (4.d3)");
    seedLine(PIANISSIMO_LINE, 0.3, PIANISSIMO_LINE.length, { id: copy, rootPlies: 5 });
    const id = addGame(PIANISSIMO_LINE, { cpLoss: { 7: 25 } });

    expect((await reviewRepertoireGames(deps())).reviewed).toBe(1);
    expect(reviewsOf()).toEqual([
      expect.objectContaining({ game_id: id, repertoire_id: repertoireId, outcome: "departed" }),
    ]);
    // No card is made from a move only the copy stores.
    expect(cardAt(AFTER_BC5, "d3")).toBeUndefined();

    // The rebuild ends and its copy goes: the game was never the copy's, so it is not reviewed again.
    deleteRepertoireGroupVariations(db, "white", COPY_GROUP);
    expect((await reviewRepertoireGames(deps())).reviewed).toBe(0);
    expect(reviewsOf()).toEqual([
      expect.objectContaining({ game_id: id, repertoire_id: repertoireId }),
    ]);
    expect(logs.named("repertoire.game_reviewed")).toHaveLength(1);
  });
});

describe("a game that reaches no unit's root", () => {
  it("stays not reached against the Italian", async () => {
    seedRepertoire();
    seedScandinavian();
    const before = positionsOf();
    const id = addGame(["e4", "c5", "Nf3", "d6"]);
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({ outcome: "not_reached", repertoireId });
    expect(reviewOf(id)).toMatchObject({
      repertoire_id: repertoireId,
      outcome: "not_reached",
      followed_plies: 1,
      left_ply: 2,
      left_san: "c5",
      opening_name: "Sicilian Defense",
    });
    expect(cardsOf()).toEqual([]);
    expect(positionsOf()).toEqual(before);
  });

  it("is not claimed by a unit stored before the Italian that it never reached", async () => {
    // A tie on the plies followed goes to the lowest id, and 1.e4 c5 follows the first move of
    // this unit as far as it follows the Italian's, so only its root keeps it out.
    db.prepare("DELETE FROM repertoires").run();
    seedScandinavian();
    repertoireId = createUnit("Italian Game", "Classical Variation (4.c3)");
    seedRepertoire();
    const before = positionsOf();
    const result = await reviewRepertoireGame(deps(), addGame(["e4", "c5", "Nf3", "d6"]));
    expect(result).toMatchObject({ outcome: "not_reached", repertoireId });
    expect(positionsOf()).toEqual(before);
    expect(explorer.calls).toEqual([]);
  });

  it("is still listed as an opening met", async () => {
    seedRepertoire();
    seedScandinavian();
    await reviewRepertoireGame(deps(), addGame(["e4", "c5", "Nf3", "d6"]));
    expect(listMetOpenings(db)).toEqual([
      { root: ["e4", "c5"], openingName: "Sicilian Defense", games: 1, repertoireId: null },
    ]);
  });

  it("is not listed for an opening whose unit the game reached", async () => {
    seedRepertoire();
    seedScandinavian();
    addGame(AFTER_EXD5);
    addGame(["e4", "c5"]);
    await reviewRepertoireGames(deps());
    expect(listMetOpenings(db).map((met) => met.root)).toEqual([["e4", "c5"]]);
  });

  it("still reviews practice games against the repertoire but leaves them out of listMetOpenings", async () => {
    seedRepertoire();
    const countedSicilian = addGame(["e4", "c5", "Nf3", "d6"]);
    const practiceSicilian = addGame(["e4", "c5", "Nf3", "Nc6"], { practice: true });
    const practiceScandinavian = addGame(["e4", "d5", "exd5"], { practice: true });
    const practiceItalian = addGame(MAIN_LINE, { practice: true });

    const summary = await reviewRepertoireGames(deps());
    expect(summary.reviewed).toBe(4);
    expect(reviewOf(countedSicilian)?.outcome).toBe("not_reached");
    expect(reviewOf(practiceSicilian)?.outcome).toBe("not_reached");
    expect(reviewOf(practiceScandinavian)?.outcome).toBe("not_reached");
    expect(reviewOf(practiceItalian)?.outcome).toBe("in_book");

    expect(listMetOpenings(db)).toEqual([
      { root: ["e4", "c5"], openingName: "Sicilian Defense", games: 1, repertoireId: null },
    ]);
  });

  it.each([
    {
      why: "a run stopped with only the first move of its root",
      rows: (id: number) =>
        insertRepertoireOwnMove(db, {
          repertoireId: id,
          positionKey: keyOf([]),
          ply: 1,
          line: [],
          reach: 1,
          openingName: null,
          uci: "e2e4",
          san: "e4",
          share: null,
          source: "setup",
          cpLoss: 0,
          evalCp: 30,
          results: null,
        }),
    },
    { why: "a run stopped before it stored a move", rows: () => undefined },
    {
      why: "its rows say nothing of a root",
      rows: (id: number) =>
        insertRepertoireOwnMove(db, {
          repertoireId: id,
          positionKey: keyOf([]),
          ply: 1,
          line: [],
          reach: 1,
          openingName: null,
          uci: "e2e4",
          san: "e4",
          share: null,
          source: "explorer",
          cpLoss: 0,
          evalCp: 30,
          results: null,
        }),
    },
  ])("is not compared with a unit left unfinished: $why", async ({ rows }) => {
    seedRepertoire();
    rows(createUnit("Scandinavian Defense", "Mieses-Kotroc Variation (2.exd5)"));
    const before = positionsOf();
    const id = addGame(["e4", "c5", "Nf3"]);
    const result = await reviewRepertoireGame(deps(), id);
    expect(result).toMatchObject({ outcome: "not_reached", repertoireId });
    expect(positionsOf()).toEqual(before);
    expect(explorer.calls).toEqual([]);
    expect(engine.requests).toEqual([]);
  });
});

describe("a game graded before its unit existed", () => {
  it("keeps its review and changes nothing when the unit is stored later", async () => {
    seedRepertoire();
    const early = addGame(AFTER_EXD5);
    await reviewRepertoireGames(deps());
    const reviewed = reviewOf(early);
    expect(reviewed).toMatchObject({
      repertoire_id: repertoireId,
      outcome: "not_reached",
      left_san: "d5",
    });
    const scandinavianId = seedScandinavian();
    const after = snapshot();
    const messages = noticesOf();
    expect((await reviewRepertoireGames(deps())).reviewed).toBe(0);
    expect(await reviewRepertoireGame(deps(), early)).toBeNull();
    expect(reviewOf(early)).toEqual(reviewed);
    expect(snapshot()).toEqual(after);
    expect(cardsOf()).toEqual([]);
    expect(noticesOf()).toEqual(messages);
    // The next game of that opening is compared with the unit, and the old one keeps counting.
    const late = addGame(AFTER_EXD5);
    await reviewRepertoireGames(deps());
    expect(reviewOf(late)).toMatchObject({ repertoire_id: scandinavianId, outcome: "in_book" });
    expect(reviewOf(early)).toEqual(reviewed);
    expect(listMetOpenings(db)).toEqual([
      {
        root: SCANDINAVIAN,
        openingName: "Scandinavian Defense",
        games: 1,
        repertoireId: scandinavianId,
      },
    ]);
  });
});

describe("choosing the unit a game followed", () => {
  const unitOf = (id: number, line: string[], rootPlies: number): RootedUnit => ({
    id,
    root: stepsOf(line)
      .slice(0, rootPlies)
      .map((step) => step.uci),
    lookup: new ScriptedRepertoireLookup(line),
  });
  const movesOf = (line: string[]) => listMoves(db, addGame(line));

  it("ignores a unit whose root the game does not play, however long the unit follows it", () => {
    const italian = unitOf(1, MAIN_LINE, 5);
    const scandinavian = unitOf(2, SCANDINAVIAN_LINE, 2);
    const chosen = walkLongestFollowedUnit(movesOf(AFTER_EXD5), [italian, scandinavian]);
    expect(chosen?.unit.id).toBe(2);
    expect(chosen?.walk.followed).toBe(3);
    expect(
      walkLongestFollowedUnit(movesOf(["e4", "c5", "Nf3"]), [italian, scandinavian]),
    ).toBeNull();
  });

  it("does not take a unit for a game that ends before the unit's root does", () => {
    expect(
      walkLongestFollowedUnit(movesOf(["e4", "e5", "Nf3"]), [unitOf(1, MAIN_LINE, 5)]),
    ).toBeNull();
    expect(walkLongestFollowedUnit(movesOf(MAIN_LINE), [])).toBeNull();
  });

  it("takes the unit that matched more plies wherever it sits in the list", () => {
    const classical = unitOf(1, MAIN_LINE, 5);
    const pianissimo = unitOf(2, PIANISSIMO_LINE, 5);
    const moves = movesOf(PIANISSIMO_LINE);
    for (const units of [
      [classical, pianissimo],
      [pianissimo, classical],
    ]) {
      const chosen = walkLongestFollowedUnit(moves, units);
      expect(chosen?.unit.id).toBe(2);
      expect(chosen?.walk.followed).toBe(10);
    }
  });

  it("takes the lowest id on a tie wherever it sits in the list", () => {
    const classical = unitOf(1, MAIN_LINE, 5);
    const pianissimo = unitOf(2, PIANISSIMO_LINE, 5);
    const moves = movesOf([...AFTER_BC5, "b4"]);
    for (const units of [
      [classical, pianissimo],
      [pianissimo, classical],
    ]) {
      const chosen = walkLongestFollowedUnit(moves, units);
      expect(chosen?.unit.id).toBe(1);
      expect(chosen?.walk.followed).toBe(6);
    }
  });
});

describe("processing a game twice", () => {
  it("changes nothing the second time", async () => {
    seedRepertoire();
    writeH6Answers();
    const departed = addGame([...AFTER_NF6, "d3", "d6"]);
    const added = addGame([...SETUP, "h6", "c3"]);
    expect((await reviewRepertoireGames(deps())).reviewed).toBe(2);
    const after = snapshot();
    const messages = noticesOf();
    const fetches = explorer.calls.length;
    const searches = engine.requests.length;
    expect((await reviewRepertoireGames(deps())).reviewed).toBe(0);
    expect(await reviewRepertoireGame(deps(), departed)).toBeNull();
    expect(await reviewRepertoireGame(deps(), added)).toBeNull();
    expect(snapshot()).toEqual(after);
    expect(noticesOf()).toEqual(messages);
    expect(explorer.calls).toHaveLength(fetches);
    expect(engine.requests).toHaveLength(searches);
  });

  it("leaves a reviewed game alone even after the positions it added were deleted", async () => {
    seedRepertoire();
    writeH6Answers();
    const id = addGame([...SETUP, "h6", "c3"]);
    await reviewRepertoireGame(deps(), id);
    db.prepare("DELETE FROM repertoire_positions WHERE source = 'game'").run();
    const after = snapshot();
    const searches = engine.requests.length;
    expect(await reviewRepertoireGame(deps(), id)).toBeNull();
    expect((await reviewRepertoireGames(deps())).reviewed).toBe(0);
    expect(snapshot()).toEqual(after);
    expect(engine.requests).toHaveLength(searches);
  });

  it("applies a game once when two reviews of it overlap", async () => {
    seedRepertoire();
    const id = addGame([...AFTER_NF6, "d3", "d6"]);
    const results = await Promise.all([
      reviewRepertoireGame(deps(), id),
      reviewRepertoireGame(deps(), id),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(cardAt(AFTER_NF6, "d4")).toMatchObject({ reviews: 1, learning_step: 0 });
    expect(reviewsOf()).toHaveLength(1);
    expect(noticesOf()).toHaveLength(1);
  });
});

describe("choosing the games to review", () => {
  it("takes finished imports the grader is done with, oldest first, and no others", async () => {
    seedRepertoire();
    const first = addGame([...AFTER_NF6, "d3"]);
    addGame([...AFTER_NF6, "d3"], { grading: "pending" });
    addGame([...AFTER_NF6, "d3"], { grading: "failed" });
    const live = addGame([...AFTER_NF6, "d3"]);
    db.prepare("UPDATE games SET source = 'coach' WHERE id = ?").run(live);
    const last = addGame([...AFTER_NF6, "d3"]);
    const summary = await reviewRepertoireGames(deps());
    expect(summary.reviewed).toBe(2);
    expect(reviewsOf().map((row) => row.game_id)).toEqual([first, last]);
    expect(logs.named("repertoire.game_reviewed").map((event) => event.fields.game_id)).toEqual([
      first,
      last,
    ]);
  });

  it("waits for a repertoire to exist and records nothing before then", async () => {
    db.prepare("DELETE FROM repertoires").run();
    addGame(MAIN_LINE);
    const summary = await reviewRepertoireGames(deps());
    expect(summary.reviewed).toBe(0);
    expect(reviewsOf()).toEqual([]);
    expect(logs.named("repertoire.review_skipped")[0]?.fields).toEqual({ reason: "no_repertoire" });
  });

  it("waits while the variation holds no move yet", async () => {
    addGame(MAIN_LINE);
    expect((await reviewRepertoireGames(deps())).reviewed).toBe(0);
    expect(reviewsOf()).toEqual([]);
  });
});

describe("rating a repertoire card from a game", () => {
  const move = { positionKey: keyOf([]), uci: "e2e4" };
  const moveKey = `${move.positionKey} e2e4`;
  const cardNow = (): CardRow => cardsOf()[0] as CardRow;

  // A card learned well: due in three days.
  function knownCard(): void {
    introduceRepertoireCard(db, move, START_TIME);
    saveRepertoireCardReview(db, {
      cardId: cardNow().id,
      move,
      grade: 3,
      schedule: {
        fsrs_state: 2,
        stability: 3,
        difficulty: 2.1181,
        learning_step: 0,
        lapses: 0,
        interval_hours: 72,
        last_reviewed_at: START_TIME,
        next_review_at: hoursFromNow(72),
      },
    });
    db.exec("DELETE FROM drill_reviews");
  }

  it("creates the card of a move never shown and rates it as a first pass", () => {
    rateRepertoireCardFromGame(db, move, true, now);
    expect(cardNow()).toMatchObject({
      introduced_at: START_TIME,
      reviews: 1,
      fsrs_state: 1,
      learning_step: 1,
      interval_hours: 10 / 60,
      next_review_at: minutesFromNow(10),
    });
    expect(loggedGrades()).toEqual([{ key: moveKey, grade: 3 }]);
  });

  it("keeps the schedule of a right move that is not due yet, and logs nothing", () => {
    knownCard();
    const before = cardNow();
    rateRepertoireCardFromGame(db, move, true, now);
    expect(cardNow()).toEqual(before);
    expect(loggedGrades()).toEqual([]);
  });

  it("stretches a right move's interval once it is due, and logs it as Good", () => {
    knownCard();
    now = new Date(now.getTime() + 80 * HOUR_MS);
    rateRepertoireCardFromGame(db, move, true, now);
    expect(cardNow()).toMatchObject({ reviews: 2, fsrs_state: 2, lapses: 0 });
    expect(cardNow().interval_hours).toBeGreaterThan(72);
    expect(loggedGrades()).toEqual([{ key: moveKey, grade: 3 }]);
  });

  it("fails a missed move even when it is not due yet, and logs it as Again", () => {
    knownCard();
    rateRepertoireCardFromGame(db, move, false, now);
    expect(cardNow()).toMatchObject({
      reviews: 2,
      fsrs_state: 3,
      lapses: 1,
      interval_hours: 10 / 60,
      next_review_at: minutesFromNow(10),
    });
    expect(loggedGrades()).toEqual([{ key: moveKey, grade: 1 }]);
  });
});

describe("the review hook after grading", () => {
  it("runs after a game is graded and logs a failed review without stopping the next game", async () => {
    seedRepertoire();
    writeH6Answers();
    explorer.failAt(
      SETUP,
      EXPLORER_RATINGS,
      new ExplorerError("upstream", "the explorer answered 500"),
    );
    const needsExplorer = addGame([...SETUP, "h6", "c3"], { grading: "pending" });
    const needsNothing = addGame([...AFTER_NF6, "d3"], { grading: "pending" });
    const grader = new ImportGrader({
      db,
      log: logs,
      evaluate: async () => evaluation(10),
      onGraded: () => reviewRepertoireGames(deps()),
    });
    grader.kick();
    await grader.idle();
    expect(reviewOf(needsExplorer)).toBeUndefined();
    expect(reviewOf(needsNothing)).toMatchObject({ outcome: "departed" });
    // The failed game is tried again after each later game, and each failure names it.
    const failures = logs.named("repertoire.review_failed");
    expect(failures.map((event) => event.fields.game_id)).toEqual([needsExplorer, needsExplorer]);
    expect(String(failures[0]?.fields.error_message)).toMatch(/answered 500/);
    expect(logs.named("import.after_grade")).toHaveLength(2);
    expect(logs.named("import.after_grade_failed")).toEqual([]);
    const at = (event: string, gameId: number): number =>
      logs.events.findIndex((entry) => entry.event === event && entry.fields.game_id === gameId);
    expect(at("import.graded", needsNothing)).toBeGreaterThan(-1);
    expect(at("import.graded", needsNothing)).toBeLessThan(
      at("repertoire.game_reviewed", needsNothing),
    );
    // Once the explorer answers again the next run catches the failed game up.
    explorer.recover();
    const caughtUp = await reviewRepertoireGames(deps());
    expect(caughtUp.outcomes.reply_added).toBe(1);
    expect(reviewOf(needsExplorer)).toMatchObject({ outcome: "reply_added" });
  });
});

describe("a move that leaves the repertoire but is sound", () => {
  const EVANS = [...AFTER_BC5, "b4"];

  it("is reported by the other book name it reaches, and its card still fails", async () => {
    seedRepertoire();
    const id = addGame([...EVANS, "Bxb4"], { cpLoss: { 7: 25 } });
    await reviewRepertoireGame(deps(), id);
    expect(noticesOf()).toEqual([
      expect.objectContaining({
        outcome: "departed",
        alternative_opening: "Italian Game: Evans Gambit",
      }),
    ]);
    expect(cardAt(AFTER_BC5, "c3")).toMatchObject({
      reviews: 1,
      learning_step: 0,
      interval_hours: 1 / 60,
    });
    expect(cardAt(AFTER_BC5, "b4")).toBeUndefined();
    const [notice] = noticesOf();
    expect(renderNotifications([notice as CoachNotification])).toMatch(
      /Evans Gambit.*Do not call it a mistake/s,
    );
  });

  it.each([
    { why: "a loss of 50 cp is within the margin", cpLoss: 50, named: true },
    { why: "a loss of 51 cp is past it", cpLoss: 51, named: false },
    { why: "the grader never rated the move", cpLoss: null, named: false },
  ])(
    "names the other opening only when it is close to the best: $why",
    async ({ cpLoss, named }) => {
      seedRepertoire();
      const id = addGame([...EVANS, "Bxb4"], cpLoss === null ? {} : { cpLoss: { 7: cpLoss } });
      await reviewRepertoireGame(deps(), id);
      const [notice] = noticesOf();
      expect(notice).toMatchObject({
        outcome: "departed",
        alternative_opening: named ? "Italian Game: Evans Gambit" : null,
      });
      expect(cardAt(AFTER_BC5, "c3")).toMatchObject({ reviews: 1, learning_step: 0 });
    },
  );

  it("is not reported when the position it reaches has no book name", async () => {
    seedRepertoire();
    await reviewRepertoireGame(deps(), addGame([...AFTER_NF6, "d3"], { cpLoss: { 9: 10 } }));
    expect(noticesOf()[0]).toMatchObject({ outcome: "departed", alternative_opening: null });
  });

  it("is not reported when it reaches the name the expected line already has", async () => {
    seedRepertoire();
    const sameName = parseOpeningTable(
      [
        "eco\tname\tpgn\tuci\tepd",
        `C50\tItalian Game\t-\t-\t${keyOf(SETUP)}`,
        `C53\tItalian Game: Classical Variation\t-\t-\t${keyOf(AFTER_C3)}`,
        `C53\tItalian Game: Classical Variation\t-\t-\t${keyOf([...AFTER_BC5, "d3"])}`,
      ].join("\n"),
    );
    const id = addGame([...AFTER_BC5, "d3", "Nf6"], { cpLoss: { 7: 10 } });
    await reviewRepertoireGame({ ...deps(), names: sameName }, id);
    expect(noticesOf()[0]).toMatchObject({ outcome: "departed", alternative_opening: null });
  });
});

describe("what the coach is told about a game", () => {
  const texts = (): string[] =>
    noticesOf().map((notice) => renderNotifications([notice as CoachNotification]));

  it("names the last move followed and the move expected where the student left", async () => {
    seedRepertoire();
    await reviewRepertoireGame(deps(), addGame([...AFTER_NF6, "d3", "d6"]));
    expect(noticesOf()).toEqual([
      expect.objectContaining({
        type: "repertoire_review",
        outcome: "departed",
        group: "Italian Game",
        variation: "Classical Variation (4.c3)",
        followed_to: { ply: 8, san: "Nf6" },
        expected: { ply: 9, san: "d4" },
        played: { ply: 9, san: "d3" },
      }),
    ]);
    const [text] = texts();
    expect(text).toContain("followed it through 4... Nf6");
    expect(text).toContain("played 5. d3 where the repertoire expects 5. d4");
    expect(text).not.toContain("Do not call it a mistake");
  });

  it("names the opening a game became when it left before the variation started", async () => {
    seedRepertoire();
    await reviewRepertoireGame(deps(), addGame(["e4", "c5", "Nf3"]));
    expect(noticesOf()).toEqual([
      expect.objectContaining({
        outcome: "not_reached",
        followed_to: { ply: 1, san: "e4" },
        left: { ply: 2, san: "c5" },
        opening: "Sicilian Defense",
      }),
    ]);
    const [text] = texts();
    expect(text).toContain("never reached the Italian Game");
    expect(text).toContain("left the line at 1... c5 and became the Sicilian Defense");
    expect(text).toContain("Nothing in the repertoire changed");
  });

  it("says a game that ended before the variation started became the opening it had reached", async () => {
    seedRepertoire();
    await reviewRepertoireGame(deps(), addGame(["e4", "e5", "Nf3"]));
    expect(noticesOf()[0]).toMatchObject({ outcome: "not_reached", left: null });
    expect(texts()[0]).toContain("ended before the line began, as the King's Pawn Game");
  });

  it("names the reply that was added and the answer it was given", async () => {
    seedRepertoire();
    writeH6Answers();
    await reviewRepertoireGame(deps(), addGame([...SETUP, "h6", "c3"]));
    expect(noticesOf()).toEqual([
      expect.objectContaining({
        outcome: "reply_added",
        followed_to: { ply: 5, san: "Bc4" },
        reply: { ply: 6, san: "h6" },
        answer: { ply: 7, san: "d3" },
      }),
    ]);
    expect(texts()[0]).toContain("Black then replied 3... h6, which the repertoire did not have");
    expect(texts()[0]).toContain("added with the answer 4. d3");
  });

  it("names the answer a position already held when the reply is stored alone", async () => {
    seedRepertoire();
    const whiteAnswer = stepsOf([...SETUP, "h6", "d3"])[6] as LineStep;
    insertRepertoireOwnMove(db, {
      repertoireId,
      positionKey: whiteAnswer.keyBefore,
      ply: 7,
      line: [...SETUP, "h6"],
      reach: 0.3,
      openingName: null,
      uci: "d2d3",
      san: "d3",
      share: null,
      source: "explorer",
      cpLoss: 0,
      evalCp: 20,
      results: null,
    });
    await reviewRepertoireGame(deps(), addGame([...SETUP, "h6", "c3"]));
    expect(noticesOf()[0]).toMatchObject({ outcome: "reply_added", answer: { ply: 7, san: "d3" } });
  });

  it("says nothing was added when no answer could follow the reply", async () => {
    seedLine(BLACKBURNE, 0.01, 13);
    await reviewRepertoireGame(deps(), addGame(BLACKBURNE));
    expect(noticesOf()[0]).toMatchObject({
      outcome: "reply_not_stored",
      reply: { ply: 14, san: "Nf3#" },
    });
    expect(texts()[0]).toContain("no answer could follow it, so nothing was added");
  });

  it("says a game that stayed in the repertoire to its end followed all of it", async () => {
    seedRepertoire();
    await reviewRepertoireGame(deps(), addGame(MAIN_LINE));
    expect(noticesOf()[0]).toMatchObject({
      outcome: "in_book",
      followed_to: { ply: 11, san: "cxd4" },
    });
    expect(texts()[0]).toContain("Every move of the game stayed in the repertoire");
    expect(texts()[0]).toContain("followed it through 6. cxd4");
  });

  it("writes one message per game with the review, and wakes the coach once per run", async () => {
    seedRepertoire();
    addGame([...AFTER_NF6, "d3"]);
    addGame(["e4", "c5"]);
    addGame(MAIN_LINE);
    const summary = await reviewRepertoireGames(deps());
    expect(summary.notified).toBe(3);
    expect(noticesOf().map((notice) => notice.outcome)).toEqual([
      "departed",
      "not_reached",
      "in_book",
    ]);
    expect(wakes).toBe(1);
    // Folded into one message, each game keeps its own account.
    const folded = renderNotifications(noticesOf());
    expect(folded).toContain("Several updates arrived");
    expect(folded.match(/was compared with the student's Italian Game repertoire/g)).toHaveLength(
      3,
    );
  });

  it.each([
    { games: 5, earlier: null },
    { games: 6, earlier: "1 earlier game was compared with the repertoire as well" },
    { games: 12, earlier: "7 earlier games were compared with the repertoire as well" },
  ])(
    "shows the coach only the latest five of $games games folded together",
    ({ games, earlier }) => {
      const notices = Array.from(
        { length: games },
        (_, index): RepertoireReviewNotification => ({
          type: "repertoire_review",
          game_id: index + 1,
          group: "Italian Game",
          variation: "Classical Variation (4.c3)",
          followed_to: null,
          outcome: "in_book",
        }),
      );
      const text = renderNotifications(notices);
      const shown = (text.match(/Game \d+ was compared/g) ?? []).map((line) => line.split(" ")[1]);
      expect(shown).toEqual(Array.from({ length: 5 }, (_, index) => String(games - 4 + index)));
      if (earlier) expect(text).toContain(earlier);
      else expect(text).not.toContain("earlier");
    },
  );

  it("writes no message for a game played as Black or when nobody is listening", async () => {
    seedRepertoire();
    addGame(MAIN_LINE, { color: "black" });
    expect((await reviewRepertoireGames(deps())).notified).toBe(0);
    addGame(MAIN_LINE);
    const { notifications: _sink, ...quiet } = deps();
    expect((await reviewRepertoireGames(quiet)).notified).toBe(0);
    expect(noticesOf()).toEqual([]);
    expect(wakes).toBe(0);
  });

  it("writes no message for a review that failed, and wakes nobody", async () => {
    seedRepertoire();
    explorer.failAt(
      SETUP,
      EXPLORER_RATINGS,
      new ExplorerError("upstream", "the explorer answered 500"),
    );
    addGame([...SETUP, "h6", "c3"]);
    const summary = await reviewRepertoireGames(deps());
    expect(summary.failed).toBe(1);
    expect(noticesOf()).toEqual([]);
    expect(wakes).toBe(0);
  });
});

describe("the review table", () => {
  const insertReview = (gameId: number, outcome: string) =>
    db
      .prepare(
        `INSERT INTO repertoire_game_reviews
           (game_id, repertoire_id, reviewed_at, outcome, followed_plies, passed_moves)
         VALUES (?, ?, ?, ?, 0, 0)`,
      )
      .run(gameId, repertoireId, START_TIME, outcome);

  it("refuses an outcome it does not know", () => {
    const id = addGame(["e4"]);
    expect(() => insertReview(id, "forgotten")).toThrow(/CHECK/);
    insertReview(id, "in_book");
    expect(() => insertReview(id, "in_book")).toThrow(/UNIQUE/);
  });

  it("keeps a game's review when the positions it added are deleted", async () => {
    seedRepertoire();
    writeH6Answers();
    const generated = positionsOf().length;
    const id = addGame([...SETUP, "h6", "c3"]);
    await reviewRepertoireGame(deps(), id);
    db.prepare("DELETE FROM repertoire_positions WHERE source = 'game'").run();
    expect(positionsOf()).toHaveLength(generated);
    expect(reviewOf(id)).toMatchObject({
      outcome: "reply_added",
      added_reply_id: null,
      added_answer_id: null,
    });
  });
});
