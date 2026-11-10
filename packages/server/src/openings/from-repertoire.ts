import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repertoireRootText } from "@chess-coach/shared";
import { Chess, type Move } from "chess.js";
import type { Database } from "../db/open.js";
import {
  deleteRepertoireCardsNoVariationPlays,
  type RepertoireCardSweep,
} from "../db/repertoire-cards.js";
import {
  countRepertoireOwnMovesBySan,
  createRepertoireVariation,
  deleteRepertoireGroupVariations,
  deleteRepertoireRepliesAtPly,
  findFirstRepertoireVariation,
  findRepertoireContinuations,
  findRepertoireOwnMove,
  findRepertoireOwnPlace,
  findRepertoireVariationByName,
  findRepertoireVariationPlaying,
  insertRepertoireOwnMove,
  listRepertoireOwnMoveKeys,
  moveRepertoirePositionsOnto,
  type RepertoireCounts,
  type RepertoireMoveSource,
  type RepertoireResultCounts,
  type RepertoireRow,
  type RepertoireRowPlace,
  raiseRepertoireOwnMoveReach,
  renameRepertoireVariation,
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
import { ITALIAN_CP_MARGIN, pickItalianWhiteUci } from "./from-italian.js";
import { OPENING_TABLE_FILE, type OpeningNames, OpeningTableError } from "./names.js";
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
// A rebuild stores its rows under this group until its walk ends, apart from the unit it replaces.
const REPERTOIRE_REBUILD_GROUP_SUFFIX = " (rebuilding)";

export interface RepertoireOptions {
  /**
   * The line to build a unit from, 1.e4 through the Black move that leaves the Italian setup; left
   * out, the run builds the Italian. It is checked again here, whoever called.
   */
  root?: readonly string[] | undefined;
  /**
   * A line of the Italian from 1.e4 through one White move after 3.Bc4: the run builds another
   * variation of the Italian with that move forced in that position, named after it. It takes no
   * root, and is checked again here, whoever called.
   */
  branch?: readonly string[] | undefined;
  /**
   * Replaces the stored unit with a new walk under the current rule, since a rerun never changes a
   * stored move. The unit changes only if that walk ends: one that fails or that the request budget
   * cuts short leaves it as it was.
   */
  rebuild?: boolean | undefined;
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
  /** White moves this run stored where the unit already played a candidate, so the plan rule chose. */
  planChoices: number;
  /** On a rebuild that replaced the unit: the cards of its old White moves that some unit still stores. */
  cardsKept?: number;
  /** On a rebuild that replaced the unit: the cards of its old White moves that no unit stores now. */
  cardsDeleted?: number;
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
  /** True where the unit already played one of the candidates, so the plan rule chose the move. */
  byPlan: boolean;
}

/** What White's choice in one position is made from: the White band's games and the engine's lines. */
interface RepertoireOwnSearch {
  position: ExplorerPosition;
  searched: SearchResult;
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

/**
 * The plan rule's candidates: the engine's lines within the margin of its best whose move, by SAN,
 * the unit already plays most often, in the engine's order. Empty where it plays none of them, and
 * the usual rule then decides. A unit that plays the same few moves against most replies is one the
 * student can carry to the board; strong players adapt the move to each reply instead.
 */
function repertoirePlanLines(
  fen: string,
  lines: SearchResult["lines"],
  usesBySan: ReadonlyMap<string, number>,
): SearchResult["lines"] {
  const best = lines[0];
  if (!best) return [];
  const candidates = lines.flatMap((line) => {
    const uci = line.moves[0];
    const san = uci ? repertoirePlayUci(fen, uci)?.san : undefined;
    if (!san || best.score - line.score > ITALIAN_CP_MARGIN) return [];
    return [{ line, uses: usesBySan.get(san) ?? 0 }];
  });
  const most = Math.max(0, ...candidates.map((candidate) => candidate.uses));
  if (most === 0) return [];
  return candidates.filter((candidate) => candidate.uses === most).map(({ line }) => line);
}

/** White's move in one position of a variation built at a branch point, whatever the data says. */
interface RepertoireForcedMove {
  positionKey: string;
  uci: string;
  san: string;
  /** The name the move gives the variation, by which a rerun finds it. */
  variationName: string;
}

/** What one stored unit is built around: where it starts and what it is called. */
interface RepertoireUnit {
  groupName: string;
  /** The moves of both sides played whatever the data says; reach counts from the end of them. */
  fixed: readonly string[];
  /** The line after whose last move White's answer names the variation. */
  naming: readonly string[];
  forced: RepertoireForcedMove | null;
}

const ITALIAN_UNIT: RepertoireUnit = {
  groupName: REPERTOIRE_GROUP_ITALIAN,
  fixed: ITALIAN_SETUP_SAN,
  naming: [...ITALIAN_SETUP_SAN, ITALIAN_NAMING_REPLY_SAN],
  forced: null,
};

/**
 * A branch the data refuses: no Italian to branch from, a position it never reaches, its own move,
 * or a variation built at a branch point that already holds the name an answer gives another one.
 */
export class RepertoireBranchError extends Error {}

export type RepertoireBranchCheck = { ok: true; branch: string[] } | { ok: false; reason: string };

// As for a root, the longest SAN chess.js writes is well under this; it bounds the parser's work.
const REPERTOIRE_BRANCH_LONGEST_SAN = 12;
// White's first move that the Italian does not fix is the 4th, the seventh ply.
const REPERTOIRE_BRANCH_MIN_PLY = ITALIAN_SETUP_SAN.length + 2;

const refusedBranch = (reason: string): RepertoireBranchCheck => ({ ok: false, reason });

/**
 * A branch is the line from 1.e4 through White's move at a branch point: the Italian setup, then
 * legal moves of both sides, ending on a White move from the 4th to the 15th. It comes from the
 * browser, so it is replayed on a board and every rule it fails is said in words.
 */
export function checkRepertoireBranch(branch: unknown): RepertoireBranchCheck {
  if (!Array.isArray(branch) || branch.some((san) => typeof san !== "string" || san === "")) {
    return refusedBranch("the branch is a list of SAN moves");
  }
  if (branch.length > REPERTOIRE_MAX_PLY - 1) {
    return refusedBranch(`the branch is at most ${REPERTOIRE_MAX_PLY - 1} plies long`);
  }
  if (branch.some((san: string) => san.length > REPERTOIRE_BRANCH_LONGEST_SAN)) {
    return refusedBranch("the branch holds a move that is not SAN");
  }
  const played: string[] = [];
  const board = new Chess();
  for (const san of branch as string[]) {
    try {
      played.push(board.move(san).san);
    } catch {
      return refusedBranch("the branch is not a legal line from the start position");
    }
  }
  if (!lineStartsWith(played, ITALIAN_SETUP_SAN)) {
    return refusedBranch(`the branch starts with ${repertoireRootText(ITALIAN_SETUP_SAN)}`);
  }
  if (played.length % 2 === 0) return refusedBranch("the branch must end on White's move");
  if (played.length < REPERTOIRE_BRANCH_MIN_PLY) {
    return refusedBranch("the branch ends on a White move after 3.Bc4");
  }
  return { ok: true, branch: played };
}

// The variation is named the way the first one is, after White's answer, only the answer is the
// forced move and the reply before it can be any Black move.
function forcedItalianUnit(branch: readonly string[], names: OpeningNames): RepertoireUnit {
  const checked = checkRepertoireBranch(branch);
  if (!checked.ok) throw new RepertoireBranchError(checked.reason);
  const naming = checked.branch.slice(0, -1);
  const step = replayRepertoireLine(naming);
  const move = repertoirePlaySan(step.fen, checked.branch.at(-1) as string) as RepertoirePlayedMove;
  const unit: RepertoireUnit = { ...ITALIAN_UNIT, naming };
  const opening = names.ofGame([...step.fens, move.after])?.name ?? null;
  const variationName = repertoireVariationName(unit, opening, move.san);
  const forced = {
    positionKey: positionKey(step.fen),
    uci: move.uci,
    san: move.san,
    variationName,
  };
  return { ...unit, forced };
}

// The book's name for the root position, else the root as a line: a position the table does not
// name still gets a group of its own.
function repertoireUnitOf(options: RepertoireOptions, names: OpeningNames): RepertoireUnit {
  if (options.root && options.branch) {
    throw new RepertoireBranchError("a branch is a line of the Italian Game and takes no root");
  }
  if (options.branch) return forcedItalianUnit(options.branch, names);
  if (!options.root) return ITALIAN_UNIT;
  const checked = checkRepertoireRoot(options.root);
  if (!checked.ok) throw new RepertoireRootError(checked.reason);
  return {
    groupName: names.ofPosition(checked.fen)?.name ?? repertoireRootText(checked.root),
    fixed: checked.root,
    naming: checked.root,
    forced: null,
  };
}

// The first variation of a group is found as the oldest, whatever today's data would name it; one
// built at a branch point is found by the name its forced move gives it.
function findUnitVariation(db: Database, unit: RepertoireUnit): RepertoireRow | undefined {
  return unit.forced
    ? findRepertoireVariationByName(db, "white", unit.groupName, unit.forced.variationName)
    : findFirstRepertoireVariation(db, "white", unit.groupName);
}

// A new variation plays the usual rule everywhere but the branch point, so it reaches that position
// only if the first variation does, and forcing the first variation's own move there would only
// store a copy of it under another name. A variation the branch already built is carried on.
function assertBranchAddsVariation(db: Database, unit: RepertoireUnit): void {
  const forced = unit.forced;
  if (!forced || findUnitVariation(db, unit)) return;
  const first = findFirstRepertoireVariation(db, "white", unit.groupName);
  if (!first) {
    throw new RepertoireBranchError(
      `build the ${unit.groupName} first; its variations branch from it`,
    );
  }
  const move = `${Math.ceil((unit.naming.length + 1) / 2)}.${forced.san}`;
  const stored = findRepertoireOwnMove(db, first.id, forced.positionKey);
  if (!stored) {
    throw new RepertoireBranchError(
      `${first.variation_name} does not reach the position of ${move}`,
    );
  }
  if (stored.move_uci === forced.uci) {
    throw new RepertoireBranchError(`${move} is already the move of ${first.variation_name}`);
  }
}

const lineStartsWith = (line: readonly string[], start: readonly string[]): boolean =>
  start.length <= line.length && start.every((san, index) => san === line[index]);

// The unit stored under a group is the one a root builds only if it was made from that root: its
// setup is the root, or the start of it while nothing past the setup is stored, which is what a run
// cut short at the beginning leaves. Anything else is the unit of another root that the book gave
// the same name, and walking it would write this root's lines into that unit.
function assertGroupHoldsRoot(db: Database, unit: RepertoireUnit): void {
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

// Only a variation built at a branch point can hold the name already, by forcing the same answer.
// Taking the name would make the two one variation wherever a variation is found by its name.
function renameUnitVariation(
  db: Database,
  groupName: string,
  repertoireId: number,
  name: string,
): void {
  const holder = findRepertoireVariationByName(db, "white", groupName, name);
  if (holder?.id === repertoireId) return;
  if (holder) {
    throw new RepertoireBranchError(`${name} already names another variation of ${groupName}`);
  }
  renameRepertoireVariation(db, repertoireId, name);
}

class RepertoireWalk {
  private repertoireId = 0;
  private readonly freshSearches = new Map<string, RepertoireOwnSearch>();
  private readonly maxPly: number;
  private readonly minGames: number;
  private readonly minReach: number;
  /** The position after the line the variation is named by, where White's answer names it. */
  private readonly namingStep: RepertoireStep;
  private cutSearches = 0;
  private shallowestCut: number | null = null;
  private planChoiceCount = 0;

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
    this.namingStep = replayRepertoireLine([...unit.naming]);
  }

  get planChoices(): number {
    return this.planChoiceCount;
  }

  // Before the walk, so a position the walk reaches again by a shorter line is stored there instead
  // of being found at the limit and left, and before the first count, so `created` never goes
  // negative.
  removeRepliesAtLimit(): number {
    const stored = findUnitVariation(this.db, this.unit);
    return stored ? deleteRepertoireRepliesAtPly(this.db, stored.id, this.maxPly) : 0;
  }

  async run(): Promise<void> {
    const stored = findUnitVariation(this.db, this.unit);
    this.repertoireId = (stored ?? (await this.createVariation())).id;
    await this.visitOwn(replayRepertoireLine([]));
  }

  // What the cap did to this walk's searches, which a rerun over stored moves never starts.
  searchOutcome(): Pick<RepertoireResult, "positionsCutByTime" | "shallowestDepth"> {
    return { positionsCutByTime: this.cutSearches, shallowestDepth: this.shallowestCut };
  }

  private async createVariation(): Promise<RepertoireRow> {
    const forced = this.unit.forced;
    if (forced) {
      return createRepertoireVariation(this.db, {
        side: "white",
        groupName: this.unit.groupName,
        variationName: forced.variationName,
      });
    }
    // Nothing is stored yet, so the plan rule has no say in this first name; once the walk stores
    // its answer here, the name follows that move.
    const choice = await this.computeOwnChoice(this.namingStep);
    if (!choice) {
      const reply = repertoireReplyText(this.unit.naming);
      throw new Error(`the engine found no answer to ${reply} to name the variation`);
    }
    return createRepertoireVariation(this.db, {
      side: "white",
      groupName: this.unit.groupName,
      variationName: this.variationNameAfter(choice.move),
    });
  }

  private variationNameAfter(move: RepertoirePlayedMove): string {
    const opening = this.names.ofGame([...this.namingStep.fens, move.after])?.name ?? null;
    return repertoireVariationName(this.unit, opening, move.san);
  }

  // The most common line is walked first and sets the plan, so the answer stored at the naming
  // position can differ from the one the first name was given from. A forced variation is named by
  // its forced move whatever happens elsewhere.
  private followNamingMove(step: RepertoireStep, move: RepertoirePlayedMove): void {
    if (this.unit.forced || positionKey(step.fen) !== positionKey(this.namingStep.fen)) return;
    renameUnitVariation(
      this.db,
      this.unit.groupName,
      this.repertoireId,
      this.variationNameAfter(move),
    );
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
    const choice = await this.computeOwnChoice(step);
    if (!choice) return null;
    // Fetched even when the walk goes no deeper: the statistics read these counts with no network.
    const after = await this.explorer.position(choice.move.after, EXPLORER_RATINGS);
    this.followNamingMove(step, choice.move);
    if (choice.byPlan) this.planChoiceCount += 1;
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

  // Naming the variation looks at 3...Bc5 before the walk reaches it, so what the choice is made
  // from is kept for the run and the position is searched once. The choice itself is made again
  // when the move is stored, from the moves the plan rule finds stored by then.
  private async ownSearch(step: RepertoireStep): Promise<RepertoireOwnSearch> {
    const key = positionKey(step.fen);
    const known = this.freshSearches.get(key);
    if (known) return known;
    const position = await this.explorer.position(step.fen, ITALIAN_WHITE_RATINGS);
    const searched = await this.searchPosition(step.fen, REPERTOIRE_SEARCH_LINES);
    this.freshSearches.set(key, { position, searched });
    return { position, searched };
  }

  private async computeOwnChoice(step: RepertoireStep): Promise<RepertoireOwnChoice | null> {
    const { position, searched } = await this.ownSearch(step);
    const setupSan = this.unit.fixed[step.ply - 1];
    const picked = setupSan
      ? this.setupOwnPick(step, setupSan)
      : this.ruledOwnPick(step, position, searched);
    if (!picked) return null;
    const move = repertoirePlayUci(step.fen, picked.uci);
    const scores = await this.scoreOwnMove(step.fen, picked.uci, searched);
    if (!move || !scores) return null;
    const share = repertoireShareOf(position, step.fen, picked.uci);
    const source = setupSan ? "setup" : share === null ? "engine" : "explorer";
    return { move, share, ...scores, source, byPlan: picked.byPlan };
  }

  private setupOwnPick(step: RepertoireStep, san: string): { uci: string; byPlan: false } | null {
    const uci = repertoirePlaySan(step.fen, san)?.uci;
    return uci ? { uci, byPlan: false } : null;
  }

  // A forced move is played whatever the data says. Elsewhere the candidate the unit already plays
  // most often wins, ties going to the move the usual rule picks, which pickItalianWhiteUci gives
  // when it is handed the tied lines alone; with no candidate played, the usual rule decides.
  private ruledOwnPick(
    step: RepertoireStep,
    position: ExplorerPosition,
    searched: SearchResult,
  ): { uci: string; byPlan: boolean } | null {
    const forced = this.unit.forced;
    if (forced?.positionKey === positionKey(step.fen)) return { uci: forced.uci, byPlan: false };
    const uses = countRepertoireOwnMovesBySan(this.db, this.repertoireId);
    const planned = repertoirePlanLines(step.fen, searched.lines, uses);
    const byPlan = planned.length > 0;
    const lines = byPlan ? planned : searched.lines;
    const uci = pickItalianWhiteUci(step.fen, position, lines, NO_SETUP_PREFERENCE_TURN);
    return uci ? { uci, byPlan } : null;
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
  const stored = findUnitVariation(db, unit);
  return stored ? repertoireCounts(db, stored.id) : NO_REPERTOIRE_COUNTS;
}

/** What one run of the generator works with. */
interface RepertoireRunDeps {
  db: Database;
  engine: Searcher;
  explorer: CachedExplorer;
  names: OpeningNames;
  options: RepertoireOptions;
}

interface RepertoireWalkOutcome {
  walk: RepertoireWalk;
  removedReplies: number;
  /** The unit's counts before the walk, which `created` is measured from. */
  before: RepertoireCounts;
  truncated: boolean;
}

async function walkRepertoireUnit(
  deps: RepertoireRunDeps,
  unit: RepertoireUnit,
): Promise<RepertoireWalkOutcome> {
  const walk = new RepertoireWalk(
    deps.db,
    deps.engine,
    deps.explorer,
    deps.names,
    unit,
    deps.options,
  );
  const removedReplies = walk.removeRepliesAtLimit();
  const before = unitVariationCounts(deps.db, unit);
  let truncated = false;
  try {
    await walk.run();
  } catch (error) {
    if (!(error instanceof ExplorerError && error.code === "budget")) throw error;
    truncated = true;
  }
  return { walk, removedReplies, before, truncated };
}

function repertoireRunResult(
  deps: RepertoireRunDeps,
  unit: RepertoireUnit,
  outcome: RepertoireWalkOutcome,
): RepertoireResult {
  const after = unitVariationCounts(deps.db, unit);
  return {
    variation: findUnitVariation(deps.db, unit)?.variation_name ?? null,
    ownMoves: after.ownMoves,
    replies: after.replies,
    mainlineReplies: after.mainlineReplies,
    engineReplies: after.engineReplies,
    deepestPly: after.deepestPly,
    created: after.total - outcome.before.total,
    removedReplies: outcome.removedReplies,
    requests: deps.explorer.requests,
    cacheHits: deps.explorer.cacheHits,
    truncated: outcome.truncated,
    planChoices: outcome.walk.planChoices,
    ...outcome.walk.searchOutcome(),
  };
}

// One transaction: the unit takes the new rows and, unless a forced move names it, the name its new
// answer gives, and the cards of its old White moves that no unit stores any more go with the rows.
function swapInRebuiltUnit(
  db: Database,
  unit: RepertoireUnit,
  stored: RepertoireRow,
  built: RepertoireRow,
): RepertoireCardSweep {
  return db.transaction(() => {
    const oldMoves = listRepertoireOwnMoveKeys(db, stored.id);
    if (!unit.forced) renameUnitVariation(db, unit.groupName, stored.id, built.variation_name);
    moveRepertoirePositionsOnto(db, stored.id, built.id);
    return deleteRepertoireCardsNoVariationPlays(db, oldMoves);
  })();
}

// The walk stores its rows under a group of their own, so the unit, its drills and its game reviews
// stay as they are while it runs. Its writes stay outside a transaction: the walk waits minutes on
// the network and the engine, and every other write of the app in that time would join it and be
// undone with it. A walk that fails or that the budget cuts short is thrown away; running the
// rebuild again resumes from the cache.
async function rebuildRepertoireUnit(
  deps: RepertoireRunDeps,
  unit: RepertoireUnit,
  stored: RepertoireRow,
): Promise<RepertoireResult> {
  const apart = { ...unit, groupName: `${unit.groupName}${REPERTOIRE_REBUILD_GROUP_SUFFIX}` };
  const discard = () => deleteRepertoireGroupVariations(deps.db, "white", apart.groupName);
  // What a rebuild that died with the process left behind.
  discard();
  try {
    const outcome = await walkRepertoireUnit(deps, apart);
    const built = findUnitVariation(deps.db, apart);
    if (outcome.truncated || !built) {
      discard();
      const unchanged = { ...outcome, before: unitVariationCounts(deps.db, unit) };
      return { ...repertoireRunResult(deps, unit, unchanged), planChoices: 0 };
    }
    const cards = swapInRebuiltUnit(deps.db, unit, stored, built);
    const result = repertoireRunResult(deps, unit, outcome);
    return { ...result, cardsKept: cards.kept, cardsDeleted: cards.deleted };
  } catch (error) {
    discard();
    throw error;
  }
}

/**
 * Builds the first variation of a unit, the Italian unless `options.root` names another, or with
 * `options.branch` another variation of the Italian, whose White move is forced in one position: one
 * expected White move per position and every Black reply common at the student's rating, from
 * 1.e4 (from the root, for a unit built from one) to White's 15th move, stored row by row so that
 * a run the request budget cuts short resumes by running again. Where no reply is common enough,
 * the line continues with a single one, the most played or else the engine's. A reply is stored only where
 * White's answer can be, and the replies an earlier run left at ply 30 without one are deleted first.
 * A search that is slow stops at the cap and keeps its best line, so a run never fails on one: the
 * depth reached is stored beside each White move's evaluation, and the result counts the cut searches.
 * White's move follows the plan rule: among the engine's lines within the margin, the move the unit
 * already plays most often. With `options.rebuild` a stored unit is walked again from scratch and
 * replaced, keeping the review cards of every White move some unit still stores.
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
  if (options.root) assertGroupHoldsRoot(db, unit);
  assertBranchAddsVariation(db, unit);
  const explorer = new CachedExplorer(fetcher, cacheDir, clock, options.maxRequests);
  const deps: RepertoireRunDeps = { db, engine, explorer, names, options };
  const stored = options.rebuild ? findUnitVariation(db, unit) : undefined;
  if (stored) return rebuildRepertoireUnit(deps, unit, stored);
  return repertoireRunResult(deps, unit, await walkRepertoireUnit(deps, unit));
}

/** One of White's moves the book plays at a branch point. */
export interface RepertoireBookChoice {
  san: string;
  uci: string;
  /** How many of the book's lines go through the move. */
  lines: number;
}

/** A position after 3.Bc4, White to move, where the book's lines go on with more than one move. */
export interface RepertoireBookBranch {
  positionKey: string;
  /** The move most of the book's lines go through first. */
  choices: RepertoireBookChoice[];
}

export type RepertoireBranchBook = readonly RepertoireBookBranch[];

/** Stands in where no table is loaded: the Italian then has no branch point to offer. */
export const NO_REPERTOIRE_BRANCH_BOOK: RepertoireBranchBook = [];

// The table writes a line with its move numbers: "1. e4 e5 2. Nf3".
const sansOfBookLine = (pgn: string): string[] =>
  pgn.split(/\s+/).filter((token) => token !== "" && !/^\d+\.+$/.test(token));

const byBookLines = (a: RepertoireBookChoice, b: RepertoireBookChoice): number =>
  b.lines - a.lines || a.san.localeCompare(b.san);

function addBookLine(
  byKey: Map<string, Map<string, RepertoireBookChoice>>,
  sans: readonly string[],
  where: string,
): void {
  const board = new Chess();
  for (const [index, san] of sans.entries()) {
    const key = positionKey(board.fen());
    let move: Move;
    try {
      move = board.move(san);
    } catch {
      throw new OpeningTableError(`${where}: ${san} is not a legal move of the line`);
    }
    if (index < REPERTOIRE_BRANCH_MIN_PLY - 1 || index % 2 === 1) continue;
    const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
    const choices = byKey.get(key) ?? new Map<string, RepertoireBookChoice>();
    const choice = choices.get(uci) ?? { san: move.san, uci, lines: 0 };
    choice.lines += 1;
    choices.set(uci, choice);
    byKey.set(key, choices);
  }
}

/**
 * The book's branch points after 3.Bc4, read from the line column of the openings table whose
 * names the rest of the repertoire uses: every position where its lines go on with more than one
 * White move. A position is matched whatever the move order, so a transposition joins its lines.
 * A line that does not replay throws with its row, so a bad update fails at boot.
 */
export function parseRepertoireBranchBook(
  table: string,
  label: string = OPENING_TABLE_FILE,
): RepertoireBookBranch[] {
  const byKey = new Map<string, Map<string, RepertoireBookChoice>>();
  table.split(/\r?\n/).forEach((row, index) => {
    if (index === 0 || row === "") return;
    const sans = sansOfBookLine(row.split("\t")[2] ?? "");
    if (lineStartsWith(sans, ITALIAN_SETUP_SAN)) addBookLine(byKey, sans, `${label}:${index + 1}`);
  });
  return [...byKey.entries()].flatMap(([key, choices]) =>
    choices.size < 2
      ? []
      : [{ positionKey: key, choices: [...choices.values()].sort(byBookLines) }],
  );
}

export function loadRepertoireBranchBook(contentDir: string): RepertoireBookBranch[] {
  const file = join(contentDir, OPENING_TABLE_FILE);
  return parseRepertoireBranchBook(readFileSync(file, "utf8"), file);
}

/** A choice at a branch point: the name a variation built with it gets, and the one that holds it. */
export interface RepertoireBranchChoiceListing {
  san: string;
  variationName: string;
  repertoireId: number | null;
}

export interface RepertoireBranchListing {
  groupName: string;
  /** The first variation's line to the position, the likeliest of them. */
  line: string[];
  reach: number;
  choices: RepertoireBranchChoiceListing[];
}

// The variation that plays the move there, else one a run cut short built with it before it got
// that far, which adding it again carries on.
function branchChoiceListing(
  db: Database,
  names: OpeningNames,
  step: RepertoireStep,
  choice: RepertoireBookChoice,
): RepertoireBranchChoiceListing {
  const after = repertoirePlayUci(step.fen, choice.uci);
  const opening = after ? (names.ofGame([...step.fens, after.after])?.name ?? null) : null;
  const unit: RepertoireUnit = { ...ITALIAN_UNIT, naming: step.line };
  const variationName = repertoireVariationName(unit, opening, choice.san);
  const holder =
    findRepertoireVariationPlaying(db, "white", unit.groupName, {
      positionKey: positionKey(step.fen),
      uci: choice.uci,
    }) ?? findRepertoireVariationByName(db, "white", unit.groupName, variationName);
  return { san: choice.san, variationName, repertoireId: holder?.id ?? null };
}

/**
 * The book's branch points that the Italian's first variation reaches, the likeliest first. Only
 * there can a variation forced at one position differ from it, since it plays the usual rule
 * everywhere else; the line is the one the first variation stored, so a choice is named and built
 * from the same moves.
 */
export function listRepertoireBranches(
  db: Database,
  book: RepertoireBranchBook,
  names: OpeningNames,
): RepertoireBranchListing[] {
  const first = findFirstRepertoireVariation(db, "white", REPERTOIRE_GROUP_ITALIAN);
  if (!first) return [];
  const listed = book.flatMap((branch): RepertoireBranchListing[] => {
    const place = findRepertoireOwnPlace(db, first.id, branch.positionKey);
    if (!place) return [];
    const step = replayRepertoireLine(place.line);
    return [
      {
        groupName: REPERTOIRE_GROUP_ITALIAN,
        line: place.line,
        reach: place.reach,
        choices: branch.choices.map((choice) => branchChoiceListing(db, names, step, choice)),
      },
    ];
  });
  return listed.sort(
    (a, b) =>
      b.reach - a.reach ||
      a.line.length - b.line.length ||
      a.line.join(" ").localeCompare(b.line.join(" ")),
  );
}
