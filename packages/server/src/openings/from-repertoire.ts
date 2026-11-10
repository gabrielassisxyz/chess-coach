import { repertoireRootText } from "@chess-coach/shared";
import { Chess } from "chess.js";
import type { Database } from "../db/open.js";
import {
  createRepertoireVariation,
  deleteRepertoireRepliesAtPly,
  findFirstRepertoireVariation,
  findRepertoireContinuations,
  findRepertoireOwnMove,
  insertRepertoireOwnMove,
  type RepertoireCounts,
  type RepertoireMoveSource,
  type RepertoireResultCounts,
  type RepertoireRow,
  type RepertoireRowPlace,
  raiseRepertoireOwnMoveReach,
  repertoireCounts,
  repertoireHoldsMovesBeyondSetup,
  repertoireSetupLine,
  type StoredRepertoireContinuation,
  type StoredRepertoireOwnMove,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { EVALUATION_DEPTH } from "../engine/evaluate.js";
import { applyUci } from "../engine/moves.js";
import type { Searcher, SearchResult } from "../engine/uci.js";
import {
  CachedExplorer,
  EXPLORER_RATINGS,
  type ExplorerClock,
  ExplorerError,
  type ExplorerFetcher,
  type ExplorerMove,
  type ExplorerPosition,
  gamesOf,
  ITALIAN_WHITE_RATINGS,
} from "./explorer-client.js";
import { MIN_POSITION_GAMES } from "./from-explorer.js";
import { positionKey } from "./from-games.js";
import { pickItalianWhiteUci } from "./from-italian.js";
import type { OpeningNames } from "./names.js";
import {
  checkRepertoireRoot,
  ITALIAN_SETUP_SAN,
  RepertoireRootConflictError,
  RepertoireRootError,
} from "./repertoire-root.js";

export const REPERTOIRE_GROUP_ITALIAN = "Italian Game";
// A Black reply is stored only where White's answer fits under the limit, so a line ends on White's
// 15th move at ply 29, never on a reply.
export const REPERTOIRE_MAX_PLY = 30;
export const REPERTOIRE_MIN_REACH = 1 / 50;
const REPERTOIRE_SEARCH_LINES = 5;
// A search still short of its depth at the cap is stopped and keeps its best line so far. Failing
// would end the walk at the same position on every rerun, and a batch can afford to wait for a slow
// position where a live game cannot.
export const REPERTOIRE_SEARCH_CAP_MS = 30_000;

// White's answer to this reply is the choice the variation is named after.
const ITALIAN_NAMING_REPLY_SAN = "Bc5";
// pickItalianWhiteUci prefers the Italian setup move on turns 1 to 3. The walk plays those plies
// from its fixed line, so the preference could only choose White's answer after a root, where the
// rule is the most played move within the margin. No turn has no setup move.
const NO_SETUP_PREFERENCE_TURN = 0;

export interface RepertoireOptions {
  /**
   * The line to build a unit from, 1.e4 through the Black move that leaves the Italian setup; left
   * out, the run builds the Italian. It is checked again here, whoever called.
   */
  root?: readonly string[] | undefined;
  maxPly?: number;
  minGames?: number;
  minReach?: number;
  /** Requests allowed to reach the network in this run. */
  maxRequests?: number;
}

export interface RepertoireResult {
  /** Null when the run ended before the variation could be named. */
  variation: string | null;
  ownMoves: number;
  replies: number;
  /** The replies stored past the coverage goal as the most played one at the student's rating. */
  mainlineReplies: number;
  /** The replies stored past the coverage goal as the engine's best, where the explorer lacked games. */
  engineReplies: number;
  deepestPly: number;
  /** Rows this run added; running again over the same data adds none. */
  created: number;
  /** Reply rows an earlier run left at the depth limit, with no White answer, that this run deleted. */
  removedReplies: number;
  requests: number;
  cacheHits: number;
  /** True when the request budget ended the run early; running again resumes from the cache. */
  truncated: boolean;
  /** Searches the cap stopped short of their depth, each keeping the best line it had reached. */
  positionsCutByTime: number;
  /** The shallowest depth a search the cap stopped had reached; null when it stopped none. */
  shallowestDepth: number | null;
}

interface RepertoirePlayedMove {
  uci: string;
  san: string;
  after: string;
}

interface RepertoireStep {
  fen: string;
  /** The half-move about to be played, counted from 1. */
  ply: number;
  line: string[];
  /** The position after each ply of `line`, for the opening name. */
  fens: string[];
  /** The product of Black's shares since 3.Bc4. */
  reach: number;
}

interface RepertoireOwnScores {
  cpLoss: number;
  /** The position after the move, in centipawns from White's side; a mate is 10000. */
  evalCp: number;
  /** The depth the engine reached for both numbers, the shallowest of the searches behind them. */
  evalDepth: number | null;
}

interface RepertoireOwnChoice extends RepertoireOwnScores {
  move: RepertoirePlayedMove;
  share: number | null;
  source: RepertoireMoveSource;
}

interface RepertoirePlayedOwnMove {
  move: RepertoirePlayedMove;
  /** The position after the move, in the student's band: its result counts and Black's replies. */
  after: ExplorerPosition;
}

interface RepertoireKeptReply {
  move: RepertoirePlayedMove;
  share: number | null;
  reach: number;
  source: RepertoireMoveSource;
}

function repertoirePlayUci(fen: string, uci: string): RepertoirePlayedMove | null {
  const game = new Chess(fen);
  try {
    const move = applyUci(game, uci);
    return { uci, san: move.san, after: game.fen() };
  } catch {
    return null;
  }
}

function repertoirePlaySan(fen: string, san: string): RepertoirePlayedMove | null {
  const game = new Chess(fen);
  try {
    const move = game.move(san);
    return {
      uci: `${move.from}${move.to}${move.promotion ?? ""}`,
      san: move.san,
      after: game.fen(),
    };
  } catch {
    return null;
  }
}

const advanceRepertoireStep = (
  step: RepertoireStep,
  move: RepertoirePlayedMove,
  reach: number,
): RepertoireStep => ({
  fen: move.after,
  ply: step.ply + 1,
  line: [...step.line, move.san],
  fens: [...step.fens, move.after],
  reach,
});

function replayRepertoireLine(sans: string[]): RepertoireStep {
  let step: RepertoireStep = { fen: new Chess().fen(), ply: 1, line: [], fens: [], reach: 1 };
  for (const san of sans) {
    const move = repertoirePlaySan(step.fen, san);
    if (!move) throw new Error(`${san} is not legal after ${step.line.join(" ")}`);
    step = advanceRepertoireStep(step, move, 1);
  }
  return step;
}

// Moves are matched by playing the SAN: the explorer writes castling as king-takes-rook in UCI.
function repertoireShareOf(position: ExplorerPosition, fen: string, uci: string): number | null {
  const total = gamesOf(position);
  const listed = position.moves.find((move) => repertoirePlaySan(fen, move.san)?.uci === uci);
  return listed && total > 0 ? gamesOf(listed) / total : null;
}

// Ties go to the alphabet so that two runs over one answer rank the same.
const rankRepertoireByGames = (moves: ExplorerMove[]): ExplorerMove[] =>
  [...moves].sort((a, b) => gamesOf(b) - gamesOf(a) || a.san.localeCompare(b.san));

const repertoireResultsOf = (position: ExplorerPosition): RepertoireResultCounts | null =>
  gamesOf(position) > 0
    ? { wins: position.white, draws: position.draws, losses: position.black }
    : null;

// Unknown when either is: the number then rests on a search whose depth nobody can state.
function repertoireShallowerDepth(
  first: number | undefined,
  second: number | undefined,
): number | undefined {
  return first === undefined || second === undefined ? undefined : Math.min(first, second);
}

/** What one stored unit is built around: where it starts and what it is called. */
interface RepertoireUnit {
  groupName: string;
  /** The moves of both sides played whatever the data says; reach counts from the end of them. */
  fixed: readonly string[];
  /** The line after whose last move White's answer names the variation. */
  naming: readonly string[];
}

const ITALIAN_UNIT: RepertoireUnit = {
  groupName: REPERTOIRE_GROUP_ITALIAN,
  fixed: ITALIAN_SETUP_SAN,
  naming: [...ITALIAN_SETUP_SAN, ITALIAN_NAMING_REPLY_SAN],
};

// The book's name for the root position, else the root as a line: a position the table does not
// name still gets a group of its own.
function repertoireUnitOf(options: RepertoireOptions, names: OpeningNames): RepertoireUnit {
  if (!options.root) return ITALIAN_UNIT;
  const checked = checkRepertoireRoot(options.root);
  if (!checked.ok) throw new RepertoireRootError(checked.reason);
  return {
    groupName: names.ofPosition(checked.fen)?.name ?? repertoireRootText(checked.root),
    fixed: checked.root,
    naming: checked.root,
  };
}

const lineStartsWith = (line: readonly string[], start: readonly string[]): boolean =>
  start.length <= line.length && start.every((san, index) => san === line[index]);

// The unit stored under a group is the one a root builds only if it was made from that root: its
// setup is the root, or the start of it while nothing past the setup is stored, which is what a run
// cut short at the beginning leaves. Anything else is the unit of another root that the book gave
// the same name, and walking it would write this root's lines into that unit.
function assertGroupHoldsRoot(db: Database, unit: RepertoireUnit): void {
  if (unit === ITALIAN_UNIT) return;
  const stored = findFirstRepertoireVariation(db, "white", unit.groupName);
  if (!stored) return;
  const setup = repertoireSetupLine(db, stored.id);
  const isStartOfRoot = lineStartsWith(unit.fixed, setup);
  const isRoot = isStartOfRoot && setup.length === unit.fixed.length;
  const cutShort = isStartOfRoot && !repertoireHoldsMovesBeyondSetup(db, stored.id);
  if (isRoot || cutShort) return;
  const other = repertoireRootText(setup);
  throw new RepertoireRootConflictError(
    `${unit.groupName} already holds the unit of ${other}, another root the book gives the same name`,
  );
}

function repertoireVariationName(
  unit: RepertoireUnit,
  openingName: string | null,
  san: string,
): string {
  const afterColon = openingName?.split(":")[1]?.trim();
  const answerMove = Math.ceil((unit.naming.length + 1) / 2);
  return `${afterColon || openingName || unit.groupName} (${answerMove}.${san})`;
}

// "3...Bc5": the reply the variation is named after, as the book writes it.
function repertoireReplyText(naming: readonly string[]): string {
  const dots = naming.length % 2 === 0 ? "..." : ".";
  return `${Math.ceil(naming.length / 2)}${dots}${naming.at(-1)}`;
}

class RepertoireWalk {
  private repertoireId = 0;
  private readonly freshChoices = new Map<string, RepertoireOwnChoice | null>();
  private readonly maxPly: number;
  private readonly minGames: number;
  private readonly minReach: number;
  private cutSearches = 0;
  private shallowestCut: number | null = null;

  constructor(
    private readonly db: Database,
    private readonly engine: Searcher,
    private readonly explorer: CachedExplorer,
    private readonly names: OpeningNames,
    private readonly unit: RepertoireUnit,
    options: RepertoireOptions,
  ) {
    this.maxPly = options.maxPly ?? REPERTOIRE_MAX_PLY;
    this.minGames = options.minGames ?? MIN_POSITION_GAMES;
    this.minReach = options.minReach ?? REPERTOIRE_MIN_REACH;
  }

  // Before the walk, so a position the walk reaches again by a shorter line is stored there instead
  // of being found at the limit and left, and before the first count, so `created` never goes
  // negative.
  removeRepliesAtLimit(): number {
    const stored = findFirstRepertoireVariation(this.db, "white", this.unit.groupName);
    return stored ? deleteRepertoireRepliesAtPly(this.db, stored.id, this.maxPly) : 0;
  }

  async run(): Promise<void> {
    const stored = findFirstRepertoireVariation(this.db, "white", this.unit.groupName);
    this.repertoireId = (stored ?? (await this.createVariation())).id;
    await this.visitOwn(replayRepertoireLine([]));
  }

  // What the cap did to this walk's searches, which a rerun over stored moves never starts.
  searchOutcome(): Pick<RepertoireResult, "positionsCutByTime" | "shallowestDepth"> {
    return { positionsCutByTime: this.cutSearches, shallowestDepth: this.shallowestCut };
  }

  private async createVariation(): Promise<RepertoireRow> {
    const step = replayRepertoireLine([...this.unit.naming]);
    const choice = await this.freshOwnChoice(step);
    if (!choice) {
      const reply = repertoireReplyText(this.unit.naming);
      throw new Error(`the engine found no answer to ${reply} to name the variation`);
    }
    const opening = this.names.ofGame([...step.fens, choice.move.after])?.name ?? null;
    return createRepertoireVariation(this.db, {
      side: "white",
      groupName: this.unit.groupName,
      variationName: repertoireVariationName(this.unit, opening, choice.move.san),
    });
  }

  private async visitOwn(step: RepertoireStep): Promise<void> {
    if (step.ply > this.maxPly) return;
    const stored = findRepertoireOwnMove(this.db, this.repertoireId, positionKey(step.fen));
    const played = stored
      ? await this.followStoredOwnMove(step, stored)
      : await this.storeFreshOwnMove(step);
    if (played) {
      await this.visitReplies(advanceRepertoireStep(step, played.move, step.reach), played.after);
    }
  }

  // A stored position keeps its expected move, loss and counts: a rerun or a transposition follows
  // them rather than asking the engine again, whose answer could differ from what was memorized.
  private async followStoredOwnMove(
    step: RepertoireStep,
    stored: StoredRepertoireOwnMove,
  ): Promise<RepertoirePlayedOwnMove | null> {
    raiseRepertoireOwnMoveReach(this.db, stored.id, this.placeOf(step, step.reach));
    const move = repertoirePlayUci(step.fen, stored.move_uci);
    if (!move) return null;
    return { move, after: await this.explorer.position(move.after, EXPLORER_RATINGS) };
  }

  private async storeFreshOwnMove(step: RepertoireStep): Promise<RepertoirePlayedOwnMove | null> {
    const choice = await this.freshOwnChoice(step);
    if (!choice) return null;
    // Fetched even when the walk goes no deeper: the statistics read these counts with no network.
    const after = await this.explorer.position(choice.move.after, EXPLORER_RATINGS);
    insertRepertoireOwnMove(this.db, {
      ...this.placeOf(step, step.reach),
      uci: choice.move.uci,
      san: choice.move.san,
      share: choice.share,
      source: choice.source,
      cpLoss: choice.cpLoss,
      evalCp: choice.evalCp,
      evalDepth: choice.evalDepth,
      results: repertoireResultsOf(after),
    });
    return { move: choice.move, after };
  }

  private placeOf(step: RepertoireStep, reach: number): RepertoireRowPlace {
    return {
      repertoireId: this.repertoireId,
      positionKey: positionKey(step.fen),
      ply: step.ply,
      line: step.line,
      reach,
      openingName: this.names.ofGame(step.fens)?.name ?? null,
    };
  }

  private async visitReplies(step: RepertoireStep, position: ExplorerPosition): Promise<void> {
    // White's answer sits one ply later. A reply stored where that answer cannot be would read as a
    // gap in the coverage that no later run could fill.
    if (step.ply + 1 > this.maxPly) return;
    const branching = this.repliesToKeep(step, position);
    // Where no reply is common enough to prepare for, the line still goes on with one, so that the
    // student can memorize it to the end. Reach keeps its usual product, which puts that reply under
    // the goal, so it is not a requirement.
    const replies =
      branching.length > 0 ? branching : await this.continuationReplies(step, position);
    for (const reply of replies) {
      upsertRepertoireReply(this.db, {
        ...this.placeOf(step, reply.reach),
        uci: reply.move.uci,
        san: reply.move.san,
        share: reply.share,
        source: reply.source,
      });
      await this.visitOwn(advanceRepertoireStep(step, reply.move, reply.reach));
    }
  }

  private repliesToKeep(step: RepertoireStep, position: ExplorerPosition): RepertoireKeptReply[] {
    const setupSan = this.unit.fixed[step.ply - 1];
    return setupSan
      ? this.setupReply(step, position, setupSan)
      : this.popularReplies(step, position);
  }

  private setupReply(
    step: RepertoireStep,
    position: ExplorerPosition,
    san: string,
  ): RepertoireKeptReply[] {
    const move = repertoirePlaySan(step.fen, san);
    if (!move) return [];
    const share = repertoireShareOf(position, step.fen, move.uci);
    return [{ move, share, reach: step.reach, source: "setup" }];
  }

  private popularReplies(step: RepertoireStep, position: ExplorerPosition): RepertoireKeptReply[] {
    const total = gamesOf(position);
    if (total === 0) return [];
    const ranked = rankRepertoireByGames(position.moves);
    return ranked.flatMap((candidate) => this.keptReply(step, candidate, total));
  }

  private async continuationReplies(
    step: RepertoireStep,
    position: ExplorerPosition,
  ): Promise<RepertoireKeptReply[]> {
    const stored = findRepertoireContinuations(this.db, this.repertoireId, positionKey(step.fen));
    if (stored.length > 0) return stored.flatMap((row) => this.storedContinuation(step, row));
    const fresh = this.mostPlayedReply(step, position) ?? (await this.engineReply(step));
    return fresh ? [fresh] : [];
  }

  private storedContinuation(
    step: RepertoireStep,
    stored: StoredRepertoireContinuation,
  ): RepertoireKeptReply[] {
    const move = repertoirePlayUci(step.fen, stored.move_uci);
    const share = stored.share;
    return move ? [{ move, share, reach: step.reach * (share ?? 0), source: stored.source }] : [];
  }

  // The position's own count decides, not the reply's: with the games to say what is played, the
  // most played reply is the one to memorize even when it holds a small share of them.
  private mostPlayedReply(
    step: RepertoireStep,
    position: ExplorerPosition,
  ): RepertoireKeptReply | null {
    const total = gamesOf(position);
    if (total < this.minGames) return null;
    for (const candidate of rankRepertoireByGames(position.moves)) {
      const move = repertoirePlaySan(step.fen, candidate.san);
      if (!move) continue;
      const share = gamesOf(candidate) / total;
      return { move, share, reach: step.reach * share, source: "mainline" };
    }
    return null;
  }

  // There is no share to multiply by and no evidence that anyone plays it, so its reach is 0: it can
  // never count as a requirement, and a line that reaches the same position through played moves
  // takes the place over. A mated or stalemated side has no best move, which ends the line.
  private async engineReply(step: RepertoireStep): Promise<RepertoireKeptReply | null> {
    const searched = await this.searchPosition(step.fen, 1);
    const uci = searched.lines[0]?.moves[0];
    const move = uci ? repertoirePlayUci(step.fen, uci) : null;
    return move ? { move, share: null, reach: 0, source: "engine" } : null;
  }

  private keptReply(
    step: RepertoireStep,
    candidate: ExplorerMove,
    total: number,
  ): RepertoireKeptReply[] {
    const share = gamesOf(candidate) / total;
    const reach = step.reach * share;
    if (gamesOf(candidate) < this.minGames || reach < this.minReach) return [];
    const move = repertoirePlaySan(step.fen, candidate.san);
    return move ? [{ move, share, reach, source: "explorer" }] : [];
  }

  // Naming the variation decides the answer to 3...Bc5 before the walk reaches it, and the memo
  // makes the walk store that same move later in the run. It lasts one run only: a run cut short
  // before 3...Bc5 chooses again when resumed, and the stored move can then differ from the name.
  private async freshOwnChoice(step: RepertoireStep): Promise<RepertoireOwnChoice | null> {
    const key = positionKey(step.fen);
    const known = this.freshChoices.get(key);
    if (known !== undefined) return known;
    const choice = await this.computeOwnChoice(step);
    this.freshChoices.set(key, choice);
    return choice;
  }

  private async computeOwnChoice(step: RepertoireStep): Promise<RepertoireOwnChoice | null> {
    const position = await this.explorer.position(step.fen, ITALIAN_WHITE_RATINGS);
    const searched = await this.searchPosition(step.fen, REPERTOIRE_SEARCH_LINES);
    const setupSan = this.unit.fixed[step.ply - 1];
    const uci = setupSan
      ? repertoirePlaySan(step.fen, setupSan)?.uci
      : pickItalianWhiteUci(step.fen, position, searched.lines, NO_SETUP_PREFERENCE_TURN);
    if (!uci) return null;
    const move = repertoirePlayUci(step.fen, uci);
    const scores = await this.scoreOwnMove(step.fen, uci, searched);
    if (!move || !scores) return null;
    const share = repertoireShareOf(position, step.fen, uci);
    const source = setupSan ? "setup" : share === null ? "engine" : "explorer";
    return { move, share, ...scores, source };
  }

  private async searchPosition(fen: string, multipv: number): Promise<SearchResult> {
    const searched = await this.engine.search({
      fen,
      depth: EVALUATION_DEPTH,
      multipv,
      capMs: REPERTOIRE_SEARCH_CAP_MS,
    });
    if (searched.cutByTime) this.noteCutSearch(searched.depth);
    return searched;
  }

  private noteCutSearch(depth: number | undefined): void {
    this.cutSearches += 1;
    if (depth !== undefined) this.shallowestCut = Math.min(this.shallowestCut ?? depth, depth);
  }

  // The lines are scored from the side to move, White here, so the chosen move's line already
  // evaluates the position after it from White's side.
  private async scoreOwnMove(
    fen: string,
    uci: string,
    searched: SearchResult,
  ): Promise<RepertoireOwnScores | null> {
    const best = searched.lines[0];
    if (!best) return null;
    const scored = searched.lines.find((line) => line.moves[0] === uci);
    if (scored) {
      const cpLoss = Math.max(0, best.score - scored.score);
      return { cpLoss, evalCp: scored.score, evalDepth: searched.depth ?? null };
    }
    const outside = await this.scoreOutsideLines(fen, uci);
    const evalCp = outside?.evalCp ?? best.score;
    const depth = outside
      ? repertoireShallowerDepth(searched.depth, outside.depth)
      : searched.depth;
    return { cpLoss: Math.max(0, best.score - evalCp), evalCp, evalDepth: depth ?? null };
  }

  // A setup move is played whatever the engine thinks, so it can miss the engine's top lines. The
  // search after it has Black to move, so its score is negated to read from White's side. Null where
  // the move or the engine's answer is missing, which leaves the best line's score to stand in.
  private async scoreOutsideLines(
    fen: string,
    uci: string,
  ): Promise<{ evalCp: number; depth: number | undefined } | null> {
    const move = repertoirePlayUci(fen, uci);
    if (!move) return null;
    const searched = await this.searchPosition(move.after, 1);
    const reply = searched.lines[0];
    return reply ? { evalCp: -reply.score, depth: searched.depth } : null;
  }
}

const NO_REPERTOIRE_COUNTS: RepertoireCounts = {
  ownMoves: 0,
  replies: 0,
  mainlineReplies: 0,
  engineReplies: 0,
  deepestPly: 0,
  total: 0,
};

function unitVariationCounts(db: Database, unit: RepertoireUnit): RepertoireCounts {
  const stored = findFirstRepertoireVariation(db, "white", unit.groupName);
  return stored ? repertoireCounts(db, stored.id) : NO_REPERTOIRE_COUNTS;
}

/**
 * Builds the first variation of a unit, the Italian unless `options.root` names another: one
 * expected White move per position and every Black reply common at the student's rating, from
 * 1.e4 (from the root, for a unit built from one) to White's 15th move, stored row by row so that
 * a run the request budget cuts short resumes by running again. Where no reply is common enough,
 * the line continues with a single one, the most played or else the engine's. A reply is stored only where
 * White's answer can be, and the replies an earlier run left at ply 30 without one are deleted first.
 * A search that is slow stops at the cap and keeps its best line, so a run never fails on one: the
 * depth reached is stored beside each White move's evaluation, and the result counts the cut searches.
 */
export async function generateRepertoire(
  db: Database,
  engine: Searcher,
  fetcher: ExplorerFetcher,
  cacheDir: string,
  clock: ExplorerClock,
  names: OpeningNames,
  options: RepertoireOptions = {},
): Promise<RepertoireResult> {
  const unit = repertoireUnitOf(options, names);
  assertGroupHoldsRoot(db, unit);
  const explorer = new CachedExplorer(fetcher, cacheDir, clock, options.maxRequests);
  const walk = new RepertoireWalk(db, engine, explorer, names, unit, options);
  const removedReplies = walk.removeRepliesAtLimit();
  const before = unitVariationCounts(db, unit);
  let truncated = false;
  try {
    await walk.run();
  } catch (error) {
    if (!(error instanceof ExplorerError && error.code === "budget")) throw error;
    truncated = true;
  }
  const after = unitVariationCounts(db, unit);
  return {
    variation: findFirstRepertoireVariation(db, "white", unit.groupName)?.variation_name ?? null,
    ownMoves: after.ownMoves,
    replies: after.replies,
    mainlineReplies: after.mainlineReplies,
    engineReplies: after.engineReplies,
    deepestPly: after.deepestPly,
    created: after.total - before.total,
    removedReplies,
    requests: explorer.requests,
    cacheHits: explorer.cacheHits,
    truncated,
    ...walk.searchOutcome(),
  };
}
