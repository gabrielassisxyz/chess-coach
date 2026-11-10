import type {
  PausedTraining,
  PlayedMove,
  QueueOutcome,
  RepertoireDrill,
  RepertoireDrillResult,
  RepertoireHint,
  RepertoireLevel,
  RepertoireScope,
  RepertoireScopeCounts,
  TrainingActivity,
  TrainingStatus,
} from "@chess-coach/shared";
import { Chess, type Move } from "chess.js";
import { type Clock, systemClock } from "../clock.js";
import type { TrainingSummaryNotification } from "../coach/notify.js";
import { appendChatMessage } from "../db/chat.js";
import {
  countRepertoireCardsIntroducedSince,
  findDrillRepertoire,
  findRepertoireCard,
  introduceRepertoireCard,
  listDrillRepertoires,
  listRepertoireDrillMoves,
  type RepertoireCardSchedule,
  type RepertoireDrillMove,
  saveRepertoireCardReview,
} from "../db/repertoire-cards.js";
import { listMetOpenings, type MetOpeningRow, type RepertoireRow } from "../db/repertoires.js";
import {
  closeTrainingItem,
  endOpenTrainingRuns,
  endTrainingRun,
  type ItemOutcome,
  insertTrainingRun,
  insertTrainingTry,
  linkItemMessage,
  listTrainingTries,
  openTrainingItem,
  type RunEndReason,
  saveTrainingRun,
  setTrainingItemHinted,
  type TrainingRunRow,
} from "../db/training.js";
import { evaluatePlayerMove } from "../engine/evaluate.js";
import { applyUci } from "../engine/moves.js";
import type { Searcher } from "../engine/uci.js";
import { legalMoves } from "../game/snapshot.js";
import { positionKey } from "../openings/from-games.js";
import type { OpeningNames } from "../openings/names.js";
import { currentPuzzleRating } from "../puzzles/rating.js";
import { sanFor } from "../srs/cards.js";
import { SrsError } from "../srs/errors.js";
import { dueAt, type Quality, review as reviewSchedule } from "../srs/sm2.js";
import { ActivityError } from "./errors.js";
import { type PracticeRunPort, pausedTrainingOf, type TrainingDeps } from "./training.js";

/** The `recommended` scope serves at most this many due moves, the likeliest first. */
export const REPERTOIRE_RECOMMENDED_SIZE = 10;
/** A new move waits while a sibling holds a card whose interval is shorter than this. */
const REPERTOIRE_SIBLING_STABLE_HOURS = 72;
/** At most this many new moves are introduced in any 24 hours. */
const REPERTOIRE_NEW_MOVES_PER_DAY = 5;
const REPERTOIRE_NEW_MOVE_WINDOW_MS = 24 * 3_600_000;
/** A wrong try this close to the engine's best that reaches another named opening is flagged. */
export const REPERTOIRE_FLAG_CP = 50;
/** How long a try waits for the engine before it is left unflagged. */
export const REPERTOIRE_FLAG_BUDGET_MS = 4000;
/** What the first hint says when the position stores no idea. */
export const REPERTOIRE_NO_IDEA = "No idea is stored for this position yet.";
// The qualities a review card's first try pre-selects in training.ts: right is 4, a miss is 2.
const REPERTOIRE_PASS_QUALITY: Quality = 4;
const REPERTOIRE_FAIL_QUALITY: Quality = 2;
const REPERTOIRE_START_FEN = new Chess().fen();

export interface RepertoireDrillInput {
  repertoireId?: number | undefined;
  scope?: RepertoireScope | undefined;
  /**
   * Widens the drill from that repertoire to its group, to its side or, for a unit found in games,
   * to every unit found in games; left out, it is the variation.
   */
  level?: RepertoireLevel | undefined;
}

/** A move of a drill, with the variation it is served under. */
export interface RepertoireLevelMove extends RepertoireDrillMove {
  variation: RepertoireRow;
}

/** The moves of one variation, as the drill reads them. */
export interface RepertoireUnitMoves {
  variation: RepertoireRow;
  moves: readonly RepertoireDrillMove[];
}

const NO_FOUND_REPERTOIRE_IDS: ReadonlySet<number> = new Set();

/**
 * The units a drill at the found level covers: those built from an opening the student's games
 * met, which is every unit whose id a met opening names. Nothing else marks a unit as found.
 */
export function foundRepertoireIdsOf(
  met: readonly Pick<MetOpeningRow, "repertoireId">[],
): Set<number> {
  const ids = new Set<number>();
  for (const { repertoireId } of met) if (repertoireId !== null) ids.add(repertoireId);
  return ids;
}

/**
 * The variations a level covers, in the order given: the anchor alone, its group, its side, or the
 * units found in games, which the anchor need not share a group with.
 */
export function repertoireUnitsOfLevel(
  units: readonly RepertoireRow[],
  anchor: RepertoireRow,
  level: RepertoireLevel,
  foundIds: ReadonlySet<number> = NO_FOUND_REPERTOIRE_IDS,
): RepertoireRow[] {
  if (level === "variation") return [anchor];
  if (level === "found") return units.filter((unit) => foundIds.has(unit.id));
  return units.filter(
    (unit) =>
      unit.side === anchor.side && (level === "side" || unit.group_name === anchor.group_name),
  );
}

// A move two variations share has one card, so a drill over both serves it once, under the
// variation where it is likeliest; at equal reach the variation given first keeps it.
export function mergeRepertoireUnitMoves(
  units: readonly RepertoireUnitMoves[],
): RepertoireLevelMove[] {
  const kept = new Map<string, RepertoireLevelMove>();
  for (const { variation, moves } of units) {
    for (const move of moves) {
      const key = `${move.positionKey}|${move.uci}`;
      const held = kept.get(key);
      if (held && held.reach >= move.reach) continue;
      kept.set(key, { ...move, variation });
    }
  }
  return [...kept.values()];
}

function listLevelUnitMoves(
  db: TrainingDeps["db"],
  anchor: RepertoireRow,
  level: RepertoireLevel,
): RepertoireUnitMoves[] {
  const all = level === "variation" ? [anchor] : listDrillRepertoires(db);
  const foundIds = level === "found" ? foundRepertoireIdsOf(listMetOpenings(db)) : undefined;
  return repertoireUnitsOfLevel(all, anchor, level, foundIds).map((variation) => ({
    variation,
    moves: listRepertoireDrillMoves(db, variation.id),
  }));
}

export function isRepertoireMoveDue(move: RepertoireDrillMove, now: Date): boolean {
  return move.card === null || Date.parse(move.card.next_review_at) <= now.getTime();
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Likeliest first, and a move after the moves that lead to it: reach only falls along a line, and
// at equal reach the earlier ply goes first.
export function compareRepertoireLineOrder(a: RepertoireDrillMove, b: RepertoireDrillMove): number {
  return (
    b.reach - a.reach ||
    a.ply - b.ply ||
    byText(a.line.join(" "), b.line.join(" ")) ||
    a.rowId - b.rowId
  );
}

// Two moves are siblings when their lines agree up to Black's last reply: the answers to one White
// move that differ only in what Black played next. Two variations that part in one position
// answer it differently, and those answers are siblings too, since they are as easy to confuse.
const repertoireSiblingKey = (move: RepertoireDrillMove): string =>
  `${move.line.length}|${move.line.slice(0, -1).join(" ")}`;

function repertoireMovesBlockedBySibling(ordered: readonly RepertoireDrillMove[]): Set<string> {
  const blocked = new Set<string>();
  for (const move of ordered) {
    if (move.card !== null && move.card.interval_hours < REPERTOIRE_SIBLING_STABLE_HOURS) {
      blocked.add(repertoireSiblingKey(move));
    }
  }
  return blocked;
}

// A new move is not learned before the moves that lead to it, so it waits for each of them to be
// shown once; stable is not asked of them, only known.
function hasNewMoveEarlierInLine(
  move: RepertoireDrillMove,
  newPaths: ReadonlySet<string>,
): boolean {
  for (let length = 1; length < move.line.length; length += 1) {
    if (newPaths.has(move.line.slice(0, length).join(" "))) return true;
  }
  return false;
}

// The day's limit is the student's whole load, so it counts every card shown in the window, in any
// unit and at any level: a drill of each of two units would otherwise be allowed the limit apiece.
export function repertoireIntroductionsInWindow(db: TrainingDeps["db"], now: Date): number {
  const since = new Date(now.getTime() - REPERTOIRE_NEW_MOVE_WINDOW_MS);
  return countRepertoireCardsIntroducedSince(db, since.toISOString());
}

// The new moves that may enter now: the likeliest of each group of siblings that nothing holds
// back, as many as the day's limit leaves room for. The limit trims that list instead of choosing
// again, so a likelier sibling it leaves out never lets a less likely one in behind it.
function repertoireNewMovesMayEnter<T extends RepertoireDrillMove>(
  ordered: readonly T[],
  introducedInWindow: number,
): Set<T> {
  const blocked = repertoireMovesBlockedBySibling(ordered);
  const newPaths = new Set(
    ordered
      .filter((move) => move.card === null)
      .map((move) => pathOfRepertoireMove(move).join(" ")),
  );
  const groupsWithALeader = new Set<string>();
  const leaders: T[] = [];
  for (const move of ordered) {
    const key = repertoireSiblingKey(move);
    const waits = move.card !== null || blocked.has(key) || hasNewMoveEarlierInLine(move, newPaths);
    if (waits || groupsWithALeader.has(key)) continue;
    groupsWithALeader.add(key);
    leaders.push(move);
  }
  const room = REPERTOIRE_NEW_MOVES_PER_DAY - introducedInWindow;
  return new Set(leaders.slice(0, Math.max(0, room)));
}

// Every move with a card stays, as it always has; a new move enters only as far as the pacing
// allows, one sibling at a time and a few a day, so the student learns one branch before the next.
function admitRepertoireMoves<T extends RepertoireDrillMove>(
  moves: readonly T[],
  introducedInWindow: number,
): T[] {
  const ordered = [...moves].sort(compareRepertoireLineOrder);
  const entering = repertoireNewMovesMayEnter(ordered, introducedInWindow);
  return ordered.filter((move) => move.card !== null || entering.has(move));
}

/**
 * The moves a drill of this scope serves, in line order. A new move is due once it may enter.
 * `introducedInWindow` is `repertoireIntroductionsInWindow`, whichever moves the drill covers.
 */
export function selectRepertoireDrillMoves<T extends RepertoireDrillMove>(
  moves: readonly T[],
  scope: RepertoireScope,
  now: Date,
  introducedInWindow: number,
): T[] {
  const served = admitRepertoireMoves(moves, introducedInWindow);
  if (scope === "all") return served;
  const due = served.filter((move) => isRepertoireMoveDue(move, now));
  return scope === "due" ? due : due.slice(0, REPERTOIRE_RECOMMENDED_SIZE);
}

// A move that waits is left out of every count, as the drill leaves it out of every scope.
export function repertoireScopeCounts(
  moves: readonly RepertoireDrillMove[],
  now: Date,
  introducedInWindow: number,
): RepertoireScopeCounts {
  const served = admitRepertoireMoves(moves, introducedInWindow);
  const due = served.filter((move) => isRepertoireMoveDue(move, now)).length;
  return { recommended: Math.min(due, REPERTOIRE_RECOMMENDED_SIZE), due, all: served.length };
}

export interface RepertoirePassPlan {
  /** The SAN moves from the starting position through the last move the pass asks. */
  path: string[];
  /** The moves the pass was planned to ask, in the order it meets them. */
  chain: number[];
}

const pathOfRepertoireMove = (move: RepertoireDrillMove): string[] => [...move.line, move.san];

function continuesRepertoireLine(longer: readonly string[], shorter: readonly string[]): boolean {
  return longer.length > shorter.length && shorter.every((san, index) => longer[index] === san);
}

// The first move still to ask, then every later one that continues the same line, so one pass
// from move 1 asks as many of them as a single line holds.
export function planRepertoirePass(
  order: readonly RepertoireDrillMove[],
  askable: (move: RepertoireDrillMove) => boolean,
): RepertoirePassPlan | null {
  const first = order.find(askable);
  if (!first) return null;
  let path = pathOfRepertoireMove(first);
  const chain = [first.rowId];
  for (const move of order) {
    if (move === first || !askable(move)) continue;
    const next = pathOfRepertoireMove(move);
    if (!continuesRepertoireLine(next, path)) continue;
    path = next;
    chain.push(move.rowId);
  }
  return { path, chain };
}

export interface RepertoireTryJudge {
  /** The book name of a position itself, not of the line that reached it; null when unnamed. */
  openingOf(fen: string): string | null;
  /** How many centipawns a move loses against the engine's best, from the mover's side. */
  cpLoss(fen: string, uci: string): Promise<number>;
}

export function repertoireTryJudge(names: OpeningNames, engine: Searcher): RepertoireTryJudge {
  return {
    openingOf: (fen) => names.ofPosition(fen)?.name ?? null,
    cpLoss: async (fen, uci) => {
      const mover = fen.split(" ")[1] === "b" ? "b" : "w";
      return (await evaluatePlayerMove(engine, fen, uci, mover)).cpLoss;
    },
  };
}

function fenAfterRepertoireUci(fen: string, uci: string): string {
  const board = new Chess(fen);
  applyUci(board, uci);
  return board.fen();
}

// The half of the flag the table answers alone: the opening a wrong try reaches, when that is a
// named position other than the expected line's. Only such a try is worth asking the engine about.
export function repertoireFlagCandidate(
  judge: RepertoireTryJudge,
  fen: string,
  uci: string,
  expected: RepertoireDrillMove,
): string | null {
  const reached = judge.openingOf(fenAfterRepertoireUci(fen, uci));
  if (reached === null) return null;
  const expectedName =
    judge.openingOf(fenAfterRepertoireUci(fen, expected.uci)) ?? expected.openingName;
  return reached === expectedName ? null : reached;
}

// The flag is a courtesy: when the engine fails, or is slower than its budget because the queue it
// shares with grading is busy, the try is left unflagged like any other wrong move.
async function withinRepertoireFlagMargin(
  judge: RepertoireTryJudge,
  fen: string,
  uci: string,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), REPERTOIRE_FLAG_BUDGET_MS);
  });
  try {
    const loss = await Promise.race([judge.cpLoss(fen, uci), late]);
    return loss !== null && loss <= REPERTOIRE_FLAG_CP;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// `intro`: never shown, so the next pass shows its answer and rates nothing. `test`: its first
// attempt rates it. `retry`: missed, so it comes back until a pass gets it right first time.
type RepertoireStage = "intro" | "test" | "retry" | "done";
type RepertoireRating = "right" | "wrong";

interface DrillMoveState {
  move: RepertoireLevelMove;
  stage: RepertoireStage;
  rating: RepertoireRating | null;
  /** Asked in the current round; until the round ends a pass plays it for the student. */
  asked: boolean;
}

interface DrillAsk {
  rowId: number;
  hint: 0 | 1 | 2;
  /** A try or a hint was spent on this move in this pass; only the first one can rate it. */
  attempted: boolean;
  flagged: string | null;
}

interface DrillTry {
  at_ms: number;
  ply: number;
  uci: string;
  san: string | null;
  correct: boolean;
}

interface DrillPass {
  itemId: number;
  servedAtMs: number;
  plan: RepertoirePassPlan;
  /** The moves on the board, from move 1. */
  line: PlayedMove[];
  fen: string;
  /** The move the student must find now; null once the pass has reached its end. */
  ask: DrillAsk | null;
  /** The variation of the move asked last, or of the move the pass was planned for before that. */
  variation: RepertoireRow;
  missed: boolean;
  hinted: boolean;
  openingName: string | null;
  tries: DrillTry[];
}

// `training_runs.current_json` of a repertoire drill: the whole state, since every pass depends on
// what the earlier ones got right. The tries are read back from `training_tries`.
interface StoredDrillPass {
  item_id: number;
  served_at: string;
  path: string[];
  chain: number[];
  line: PlayedMove[];
  fen: string;
  ask: { row_id: number; hint: 0 | 1 | 2; attempted: boolean; flagged: string | null } | null;
  /** Absent from rows written before a drill could span variations, whose pass had one. */
  variation_id?: number;
  missed: boolean;
  hinted: boolean;
  opening_name: string | null;
}

interface StoredDrill {
  /** The repertoire the drill was started from; its level widens it to the group or the side. */
  repertoire_id: number;
  scope: RepertoireScope;
  /** Absent from rows written before levels existed, which drilled one variation. */
  level?: RepertoireLevel;
  pass_index: number;
  moves: {
    row_id: number;
    stage: RepertoireStage;
    rating: RepertoireRating | null;
    asked: boolean;
  }[];
  pass: StoredDrillPass;
}

interface DrillResume {
  passIndex: number;
  outcomes: ItemOutcome[];
  pass: StoredDrillPass;
}

function repertoireHintOf(ask: DrillAsk | null, asked: DrillMoveState | null): RepertoireHint {
  if (!ask || !asked || ask.hint === 0) return { kind: "none" };
  if (ask.hint === 1) return { kind: "idea", text: asked.move.idea?.trim() || REPERTOIRE_NO_IDEA };
  return { kind: "move", uci: asked.move.uci, san: asked.move.san };
}

function fenAfterRepertoireSans(sans: readonly string[]): string {
  const board = new Chess();
  for (const san of sans) board.move(san);
  return board.fen();
}

const uciOfRepertoireMove = (move: Move): string => `${move.from}${move.to}${move.promotion ?? ""}`;

/**
 * A repertoire drill: each pass plays a line from move 1, the server answering Black's moves and
 * the moves that are not asked, and stops on every move still to find. A move missed comes back on
 * a later pass until it is right first time; only its first attempt in the drill rates it.
 */
export class RepertoireSession implements PracticeRunPort {
  private readonly clock: Clock;
  private readonly order: DrillMoveState[];
  private readonly byRow = new Map<number, DrillMoveState>();
  // Two variations can expect different moves in one position, so a position can hold several.
  private readonly byKey = new Map<string, DrillMoveState[]>();
  private passIndex = 0;
  private outcomes: ItemOutcome[] = [];
  private pass: DrillPass;
  private result: RepertoireDrillResult | null = null;
  // Set while a transition writes, so the coach is woken once the rows are committed.
  private wake = false;

  // `repertoire` is the one the drill was started from: its side is the side of every variation
  // the level covers, and a pass with nothing asked yet falls back to it.
  private constructor(
    private readonly deps: TrainingDeps,
    readonly runId: number,
    private readonly repertoire: RepertoireRow,
    private readonly scope: RepertoireScope,
    private readonly level: RepertoireLevel,
    states: DrillMoveState[],
    resume: DrillResume | null,
  ) {
    this.clock = deps.clock ?? systemClock;
    this.order = [...states].sort((a, b) => compareRepertoireLineOrder(a.move, b.move));
    for (const state of this.order) {
      this.byRow.set(state.move.rowId, state);
      const atKey = this.byKey.get(state.move.positionKey) ?? [];
      atKey.push(state);
      this.byKey.set(state.move.positionKey, atKey);
    }
    if (resume === null) {
      this.pass = this.openPass(this.planNext() as RepertoirePassPlan);
      return;
    }
    this.passIndex = resume.passIndex;
    this.outcomes = [...resume.outcomes];
    this.pass = this.restorePass(resume.pass);
  }

  // A drill that would serve nothing is refused; a new one ends any run still open as replaced.
  static begin(deps: TrainingDeps, input: RepertoireDrillInput): RepertoireSession {
    const { repertoireId, scope } = input;
    const level = input.level ?? "variation";
    if (repertoireId === undefined || scope === undefined) {
      throw new ActivityError("empty_queue", "choose a repertoire and a scope for the line drill");
    }
    const repertoire = findDrillRepertoire(deps.db, repertoireId);
    if (!repertoire) {
      throw new ActivityError("empty_queue", `repertoire ${repertoireId} does not exist`);
    }
    const now = (deps.clock ?? systemClock).now();
    const units = listLevelUnitMoves(deps.db, repertoire, level);
    // The anchor names the side and carries the drill, so it has to be part of what it widens to.
    if (!units.some(({ variation }) => variation.id === repertoire.id)) {
      throw new ActivityError(
        "empty_queue",
        `repertoire ${repertoireId} is not among the openings found in your games`,
      );
    }
    const moves = selectRepertoireDrillMoves(
      mergeRepertoireUnitMoves(units),
      scope,
      now,
      repertoireIntroductionsInWindow(deps.db, now),
    );
    if (moves.length === 0) {
      const what =
        scope === "all" ? "this repertoire holds no move yet" : "no repertoire move is due";
      throw new ActivityError("empty_queue", what);
    }
    const states = moves.map(
      (move): DrillMoveState => ({
        move,
        stage: move.card === null ? "intro" : "test",
        rating: null,
        asked: false,
      }),
    );
    return deps.db.transaction(() => {
      const startedAt = now.toISOString();
      endOpenTrainingRuns(deps.db, "replaced", startedAt);
      const runId = insertTrainingRun(deps.db, {
        mode: "repertoire",
        motif: null,
        color: repertoire.side,
        size: moves.length,
        items: moves.map((move) => ({ kind: "repertoire", id: move.rowId })),
        position: 0,
        solved: 0,
        failed: 0,
        outcomes: [],
        currentJson: "{}",
        startedAt,
      });
      const session = new RepertoireSession(deps, runId, repertoire, scope, level, states, null);
      session.save();
      return session;
    })();
  }

  /** Puts a paused drill back on the move it stopped on, with every move's progress. */
  static resume(deps: TrainingDeps, row: TrainingRunRow): RepertoireSession {
    const stored = JSON.parse(row.currentJson) as StoredDrill;
    const repertoire = findDrillRepertoire(deps.db, stored.repertoire_id);
    if (!repertoire) {
      throw new ActivityError("empty_queue", `repertoire ${stored.repertoire_id} no longer exists`);
    }
    const level = stored.level ?? "variation";
    // Every row of every variation, not only the ones a merge would keep: the drill stored the rows
    // it served, and a rerun that raised another variation's reach since must not drop them.
    const moves = new Map<number, RepertoireLevelMove>();
    for (const { variation, moves: listed } of listLevelUnitMoves(deps.db, repertoire, level)) {
      for (const move of listed) moves.set(move.rowId, { ...move, variation });
    }
    const states = stored.moves.flatMap((state): DrillMoveState[] => {
      const move = moves.get(state.row_id);
      if (!move) return [];
      return [{ move, stage: state.stage, rating: state.rating, asked: state.asked }];
    });
    const resume = { passIndex: stored.pass_index, outcomes: row.outcomes, pass: stored.pass };
    return deps.db.transaction(() => {
      const session = new RepertoireSession(
        deps,
        row.id,
        repertoire,
        stored.scope,
        level,
        states,
        resume,
      );
      session.save();
      return session;
    })();
  }

  /** A paused drill counts moves: `size` served, `position` of them finished. */
  static pausedOf(row: TrainingRunRow): PausedTraining {
    const stored = JSON.parse(row.currentJson) as Partial<StoredDrill>;
    return {
      ...pausedTrainingOf(row),
      ...(stored.repertoire_id === undefined ? {} : { repertoire_id: stored.repertoire_id }),
      ...(stored.scope === undefined ? {} : { scope: stored.scope }),
      ...(stored.level === undefined ? {} : { level: stored.level }),
    };
  }

  state(activityId: number): TrainingActivity {
    const pass = this.pass;
    const asked = pass.ask ? (this.byRow.get(pass.ask.rowId) ?? null) : null;
    const open = this.result === null && pass.ask !== null;
    const board = new Chess(pass.fen);
    const last = pass.line.at(-1);
    const lastTry = pass.tries.at(-1);
    const wrong = pass.tries.filter((attempt) => !attempt.correct);
    const passesLeft = this.passesLeftInRound();
    return {
      kind: "training",
      activity_id: activityId,
      orientation: this.repertoire.side,
      fen: pass.fen,
      turn: board.turn() === "w" ? "white" : "black",
      last_move: last ? { from: last.uci.slice(0, 2), to: last.uci.slice(2, 4) } : null,
      legal_moves: open ? legalMoves(board) : [],
      input_enabled: open,
      pending: "none",
      mode: "repertoire",
      item: {
        kind: "repertoire",
        repertoire_id: pass.variation.id,
        variation_name: pass.variation.variation_name,
        group_name: pass.variation.group_name,
        fen: REPERTOIRE_START_FEN,
        position_in_queue: this.passIndex + 1,
        queue_length: this.passIndex + 1 + passesLeft,
      },
      status: this.statusOf(pass),
      served_at: new Date(pass.servedAtMs).toISOString(),
      run_motif: null,
      expected: null,
      exploring: { fen: pass.fen, line_san: [], trail: [] },
      tries: wrong.length,
      last_try: lastTry ? { uci: lastTry.uci, san: lastTry.san, correct: lastTry.correct } : null,
      gave_up: false,
      solution_line: null,
      suggested_quality: null,
      hint_square: null,
      summary: this.result
        ? {
            solved: this.result.first_try_right,
            failed: this.result.practised - this.result.first_try_right,
          }
        : null,
      moves: [...pass.line],
      wrong_tries: wrong.map(({ ply, uci, san }) => ({ ply, uci, san })),
      queue_outcomes: this.queueOutcomes(passesLeft),
      student_rating: currentPuzzleRating(this.deps.db),
      rating_change: null,
      repertoire: this.drillOf(asked),
    };
  }

  private drillOf(asked: DrillMoveState | null): RepertoireDrill {
    const ask = this.pass.ask;
    const intro = asked?.stage === "intro";
    const count = (keep: (state: DrillMoveState) => boolean): number =>
      this.order.filter(keep).length;
    return {
      repertoire_id: this.pass.variation.id,
      scope: this.scope,
      level: this.level,
      opening_name: this.pass.openingName,
      first_pass: intro,
      answer: intro && asked ? { uci: asked.move.uci, san: asked.move.san } : null,
      hint: repertoireHintOf(ask, asked),
      flagged_opening: ask?.flagged ?? null,
      moves_left: count((state) => state.stage !== "done"),
      moves_right: count((state) => state.rating === "right"),
      moves_wrong: count((state) => state.rating === "wrong"),
      result: this.result,
    };
  }

  private statusOf(pass: DrillPass): TrainingStatus {
    if (pass.ask) return pass.line.some((move) => move.by === "student") ? "in_progress" : "prompt";
    return pass.missed ? "failed" : "solved";
  }

  private queueOutcomes(passesLeft: number): QueueOutcome[] {
    const current: QueueOutcome = this.outcomes[this.passIndex] ?? "current";
    const pending: QueueOutcome[] = Array.from({ length: passesLeft }, () => "pending");
    return [...this.outcomes.slice(0, this.passIndex), current, ...pending];
  }

  // How many more passes this round holds if nothing is missed; a miss brings its line back later.
  private passesLeftInRound(): number {
    const taken = new Set<number>(this.pass.ask ? this.pass.plan.chain : []);
    const askable = (move: RepertoireDrillMove): boolean =>
      !taken.has(move.rowId) && this.isAskable(this.byRow.get(move.rowId));
    const moves = this.order.map((state) => state.move);
    let passes = 0;
    for (
      let plan = planRepertoirePass(moves, askable);
      plan;
      plan = planRepertoirePass(moves, askable)
    ) {
      passes += 1;
      for (const rowId of plan.chain) taken.add(rowId);
    }
    return passes;
  }

  private isAskable(state: DrillMoveState | undefined): boolean {
    return state !== undefined && state.stage !== "done" && !state.asked;
  }

  explore(): void {
    throw new ActivityError("not_exploring", "a repertoire line has no scratch board");
  }

  /** Ties a chat line the student typed to the open pass. */
  linkMessage(messageId: number): void {
    if (this.result === null && this.pass.ask) {
      linkItemMessage(this.deps.db, this.pass.itemId, messageId);
    }
  }

  // A wrong try is kept at once and the position stays open. When the table says it reached
  // another opening, the engine is asked whether it was good enough to name; only that name waits
  // for the answer, so a board that moves on meanwhile loses nothing else.
  tryMove(uci: string): void | Promise<void> {
    const { ask, state } = this.requireAsk();
    const fen = this.pass.fen;
    if (
      !new Chess(fen).moves({ verbose: true }).some((move) => uciOfRepertoireMove(move) === uci)
    ) {
      throw new ActivityError("illegal_move", `${uci} is not legal in this position`);
    }
    if (uci === state.move.uci) return this.transition(() => this.playRight(ask, state, uci));
    this.transition(() => this.playWrong(ask, state, uci));
    const judge = this.deps.repertoireJudge;
    const candidate = judge ? repertoireFlagCandidate(judge, fen, uci, state.move) : null;
    if (!judge || candidate === null) return;
    return withinRepertoireFlagMargin(judge, fen, uci).then((close) => {
      if (!close) return;
      this.transition(() => {
        ask.flagged = candidate;
      });
    });
  }

  /** A repertoire drill never stays quiet, so there is no comment to ask for. */
  askCoach(): void {
    throw new ActivityError("not_in_training", "this drill has no quiet item to ask about");
  }

  /** The first call gives the stored idea, the second the move; either fails the move. */
  hint(): void {
    const { ask, state } = this.requireAsk();
    this.transition(() => {
      ask.hint = ask.hint === 0 ? 1 : 2;
      this.missByHint(ask, state);
    });
  }

  /** Shows the move at once, as a second hint would. */
  showSolution(): void {
    const { ask, state } = this.requireAsk();
    this.transition(() => {
      ask.hint = 2;
      this.missByHint(ask, state);
    });
  }

  rate(): void {
    throw new SrsError("exposure_unknown", "a repertoire move is rated by its first attempt");
  }

  // The last pass's next ends the drill: the result is written once, here.
  next(): void {
    if (this.result !== null) {
      throw new ActivityError("item_finished", "the drill has already ended");
    }
    if (this.pass.ask !== null) {
      throw new ActivityError("item_unfinished", "play this line to its end before the next one");
    }
    this.transition(() => {
      const plan = this.planNext();
      if (!plan) {
        this.finish();
        return;
      }
      this.passIndex += 1;
      this.pass = this.openPass(plan);
    });
  }

  /** The student left the drill; a finished drill keeps the reason it already has. */
  end(): void {
    this.closeRun("ended");
  }

  private requireAsk(): { ask: DrillAsk; state: DrillMoveState } {
    const ask = this.pass.ask;
    const state = ask ? this.byRow.get(ask.rowId) : undefined;
    if (this.result !== null || !ask || !state) {
      throw new ActivityError("item_finished", "this line is already over");
    }
    return { ask, state };
  }

  private playRight(ask: DrillAsk, state: DrillMoveState, uci: string): void {
    const pass = this.pass;
    this.recordTry(pass, uci, true);
    if (!ask.attempted) this.rateFirstAttempt(state, true);
    ask.attempted = true;
    if (state.stage === "intro") state.stage = "test";
    const board = new Chess(pass.fen);
    const played = applyUci(board, uci);
    pass.line.push({ ply: pass.line.length, uci, san: played.san, by: "student" });
    pass.fen = board.fen();
    pass.ask = null;
    this.advance(pass);
  }

  private playWrong(ask: DrillAsk, state: DrillMoveState, uci: string): void {
    this.recordTry(this.pass, uci, false);
    ask.flagged = null;
    this.pass.missed = true;
    if (!ask.attempted) this.rateFirstAttempt(state, false);
    ask.attempted = true;
  }

  private missByHint(ask: DrillAsk, state: DrillMoveState): void {
    const pass = this.pass;
    pass.missed = true;
    if (!pass.hinted) {
      pass.hinted = true;
      setTrainingItemHinted(this.deps.db, pass.itemId);
    }
    if (!ask.attempted) this.rateFirstAttempt(state, false);
    ask.attempted = true;
  }

  // Only the first attempt at a move in the drill rates it, and the pass that shows a move with
  // its answer rates nothing. A miss sends the move back until a pass gets it right first time.
  private rateFirstAttempt(state: DrillMoveState, right: boolean): void {
    if (state.stage === "intro" || state.stage === "done") return;
    if (state.stage === "retry") {
      if (right) state.stage = "done";
      return;
    }
    state.rating = right ? "right" : "wrong";
    state.stage = right ? "done" : "retry";
    this.reschedule(state, right);
  }

  // A move played right before it is due keeps its schedule, so practising early earns no longer
  // interval; a miss fails it like any other. Due is read when the move is played, so a drill
  // resumed after its moves fell due treats them as due.
  private reschedule(state: DrillMoveState, right: boolean): void {
    const db = this.deps.db;
    const now = this.clock.now();
    introduceRepertoireCard(db, state.move, now.toISOString());
    const card = findRepertoireCard(db, state.move) as RepertoireCardSchedule;
    if (right && Date.parse(card.next_review_at) > now.getTime()) return;
    const schedule = reviewSchedule(
      card,
      right ? REPERTOIRE_PASS_QUALITY : REPERTOIRE_FAIL_QUALITY,
    );
    saveRepertoireCardReview(db, card.id, {
      schedule,
      nextReviewAt: dueAt(now, schedule.interval_hours).toISOString(),
      reviewedAt: now.toISOString(),
    });
  }

  // Stamped by the server clock from the moment the pass was served, like every other try.
  private recordTry(pass: DrillPass, uci: string, correct: boolean): void {
    const atMs = Math.max(0, this.clock.now().getTime() - pass.servedAtMs);
    const ply = pass.line.length;
    insertTrainingTry(this.deps.db, pass.itemId, {
      seq: pass.tries.length + 1,
      atMs,
      ply,
      uci,
      correct,
    });
    pass.tries.push({ at_ms: atMs, ply, uci, san: sanFor(pass.fen, uci), correct });
  }

  private planNext(): RepertoirePassPlan | null {
    const moves = this.order.map((state) => state.move);
    const askable = (move: RepertoireDrillMove): boolean =>
      this.isAskable(this.byRow.get(move.rowId));
    const planned = planRepertoirePass(moves, askable);
    if (planned || this.order.every((state) => state.stage === "done")) return planned;
    // Every move of this round has been asked: the ones not yet right come back, from move 1.
    for (const state of this.order) state.asked = false;
    return planRepertoirePass(moves, askable);
  }

  private openPass(plan: RepertoirePassPlan): DrillPass {
    const servedAt = this.clock.now();
    const itemId = openTrainingItem(this.deps.db, {
      kind: "repertoire",
      cardId: null,
      puzzleId: null,
      exposureId: null,
      servedAt: servedAt.toISOString(),
      runId: this.runId,
    });
    const pass: DrillPass = {
      itemId,
      servedAtMs: servedAt.getTime(),
      plan,
      line: [],
      fen: REPERTOIRE_START_FEN,
      ask: null,
      variation: this.variationOfRow(plan.chain[0]),
      missed: false,
      hinted: false,
      openingName: null,
      tries: [],
    };
    this.advance(pass);
    return pass;
  }

  // Plays the line on the student's behalf up to the next move they must find, or to its end.
  private advance(pass: DrillPass): void {
    const board = new Chess(pass.fen);
    while (pass.line.length < pass.plan.path.length) {
      const san = pass.plan.path[pass.line.length] as string;
      const asked = this.askableAt(board, san);
      if (asked) {
        this.ask(pass, asked);
        return;
      }
      if (!this.serverPlays(pass, board, san)) break;
    }
    this.endPass(pass);
  }

  // The move the line plays next decides which of the position's moves is asked, so a pass along
  // one variation's line is asked that variation's move.
  private askableAt(board: Chess, san: string): DrillMoveState | null {
    if (board.turn() !== (this.repertoire.side === "white" ? "w" : "b")) return null;
    const states = this.byKey.get(positionKey(board.fen())) ?? [];
    return states.find((state) => this.isAskable(state) && state.move.san === san) ?? null;
  }

  private ask(pass: DrillPass, state: DrillMoveState): void {
    state.asked = true;
    pass.ask = { rowId: state.move.rowId, hint: 0, attempted: false, flagged: null };
    pass.variation = state.move.variation;
    pass.openingName = state.move.openingName;
    // Showing a new move with its answer is what makes it known.
    if (state.stage === "intro") {
      introduceRepertoireCard(this.deps.db, state.move, this.clock.now().toISOString());
    }
  }

  private serverPlays(pass: DrillPass, board: Chess, san: string): boolean {
    let move: Move;
    try {
      move = board.move(san);
    } catch {
      return false;
    }
    pass.line.push({
      ply: pass.line.length,
      uci: uciOfRepertoireMove(move),
      san: move.san,
      by: "reply",
    });
    pass.fen = board.fen();
    return true;
  }

  private endPass(pass: DrillPass): void {
    pass.ask = null;
    // A pass that never reached the move it was planned for would be planned again forever.
    const target = this.byRow.get(pass.plan.chain[0] as number);
    if (target && !target.asked) target.stage = "done";
    this.outcomes[this.passIndex] = pass.missed ? "failed" : "solved";
    const lastStudent = pass.line.filter((move) => move.by === "student").at(-1);
    closeTrainingItem(this.deps.db, pass.itemId, {
      answeredAt: this.clock.now().toISOString(),
      answerUci: lastStudent?.uci ?? null,
      correct: !pass.missed,
    });
  }

  private finish(): void {
    const right = this.order.filter((state) => state.rating === "right").length;
    this.result = { practised: this.order.length, first_try_right: right };
    this.notify({
      type: "training_summary",
      mode: "repertoire",
      solved: right,
      failed: this.order.length - right,
    });
    this.closeRun("finished");
  }

  private closeRun(reason: RunEndReason): void {
    endTrainingRun(this.deps.db, this.runId, reason, this.clock.now().toISOString());
  }

  // The ledger rows a step writes and the run row that follows them commit together, so a restart
  // between two steps finds the drill exactly where the ledger says it was.
  private transition(change: () => void): void {
    this.wake = false;
    this.deps.db.transaction(() => {
      change();
      this.save();
    })();
    if (!this.wake) return;
    this.wake = false;
    this.deps.onNotification?.();
  }

  private save(): void {
    const count = (keep: (state: DrillMoveState) => boolean): number =>
      this.order.filter(keep).length;
    const stored: StoredDrill = {
      repertoire_id: this.repertoire.id,
      scope: this.scope,
      level: this.level,
      pass_index: this.passIndex,
      moves: this.order.map(({ move, stage, rating, asked }) => ({
        row_id: move.rowId,
        stage,
        rating,
        asked,
      })),
      pass: this.storedPass(),
    };
    saveTrainingRun(this.deps.db, this.runId, {
      position: Math.max(
        0,
        Math.min(
          count((s) => s.stage === "done"),
          this.order.length - 1,
        ),
      ),
      solved: count((state) => state.rating === "right"),
      failed: count((state) => state.rating === "wrong"),
      outcomes: this.outcomes,
      currentJson: JSON.stringify(stored),
      updatedAt: this.clock.now().toISOString(),
    });
  }

  private storedPass(): StoredDrillPass {
    const { pass } = this;
    const ask = pass.ask;
    return {
      item_id: pass.itemId,
      served_at: new Date(pass.servedAtMs).toISOString(),
      path: pass.plan.path,
      chain: pass.plan.chain,
      line: pass.line,
      fen: pass.fen,
      ask: ask
        ? { row_id: ask.rowId, hint: ask.hint, attempted: ask.attempted, flagged: ask.flagged }
        : null,
      variation_id: pass.variation.id,
      missed: pass.missed,
      hinted: pass.hinted,
      opening_name: pass.openingName,
    };
  }

  private variationOfRow(rowId: number | undefined): RepertoireRow {
    const state = rowId === undefined ? undefined : this.byRow.get(rowId);
    return state?.move.variation ?? this.repertoire;
  }

  // A variation no move of the drill belongs to any more is gone from what the pass can name.
  private variationOfId(id: number | undefined): RepertoireRow {
    const state = this.order.find((candidate) => candidate.move.variation.id === id);
    return state?.move.variation ?? this.repertoire;
  }

  private restorePass(stored: StoredDrillPass): DrillPass {
    const ask = stored.ask && this.byRow.has(stored.ask.row_id) ? stored.ask : null;
    return {
      itemId: stored.item_id,
      servedAtMs: Date.parse(stored.served_at),
      plan: { path: stored.path, chain: stored.chain },
      line: stored.line,
      fen: stored.fen,
      ask: ask
        ? { rowId: ask.row_id, hint: ask.hint, attempted: ask.attempted, flagged: ask.flagged }
        : null,
      variation:
        stored.variation_id === undefined
          ? this.repertoire
          : this.variationOfId(stored.variation_id),
      missed: stored.missed,
      hinted: stored.hinted,
      openingName: stored.opening_name,
      tries: listTrainingTries(this.deps.db, stored.item_id).map((attempt) => ({
        at_ms: attempt.atMs,
        ply: attempt.ply,
        uci: attempt.uci,
        san: sanFor(fenAfterRepertoireSans(stored.path.slice(0, attempt.ply)), attempt.uci),
        correct: attempt.correct,
      })),
    };
  }

  private notify(content: TrainingSummaryNotification): void {
    const sink = this.deps.notifications;
    if (!sink) return;
    appendChatMessage(
      this.deps.db,
      sink.sessionId(),
      { role: "user", kind: "notification", contentJson: JSON.stringify(content) },
      this.clock,
    );
    this.wake = true;
  }
}
