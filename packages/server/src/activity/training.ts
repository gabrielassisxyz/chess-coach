import type {
  ExpectedMove,
  PausedTraining,
  PlayedMove,
  QueueOutcome,
  ExploredEvent as ShownEvent,
  TrainingActivity,
  TrainingItem,
  TrainingMode,
  TrainingStatus,
  TrainingSummary,
  WrongTry,
} from "@chess-coach/shared";
import { isFixedPracticeMotif } from "@chess-coach/shared";
import { Chess } from "chess.js";
import { type Clock, systemClock } from "../clock.js";
import type {
  ExploredEvent,
  PuzzleResultNotification,
  TrainingReasoning,
  TrainingSummaryNotification,
  TriedMove,
} from "../coach/notify.js";
import { appendChatMessage } from "../db/chat.js";
import type { PlayerColor } from "../db/games.js";
import type { Database } from "../db/open.js";
import {
  getPuzzle,
  getPuzzleHeader,
  listPuzzles,
  type PuzzleFilter,
  type PuzzleSummary,
  type RatingSampleFilter,
  recordPuzzleAttempt,
} from "../db/puzzles.js";
import { getCard, insertCard } from "../db/srs.js";
import {
  amendPendingNotification,
  closeTrainingItem,
  type ExplorationKind,
  endOpenTrainingRuns,
  endTrainingRun,
  type ItemOutcome,
  insertExplorationEvent,
  insertTrainingRun,
  insertTrainingTry,
  lastExplorationSeq,
  linkItemMessage,
  listItemMessageTexts,
  listTrainingTries,
  openTrainingItem,
  type RunEndReason,
  type StoredRunItem,
  saveTrainingRun,
  setTrainingItemHinted,
  type TrainingRunRow,
} from "../db/training.js";
import { applyUci } from "../engine/moves.js";
import type { NotificationSink } from "../game/notifications.js";
import {
  type AttemptState,
  giveUp,
  solutionLineOf,
  solvedFirstTry,
  startAttempt,
  tryMove as tryPuzzleMove,
} from "../puzzles/attempt.js";
import { currentPuzzleRating, ratingAfter, setPuzzleRating } from "../puzzles/rating.js";
import { sanFor } from "../srs/cards.js";
import { SrsError } from "../srs/errors.js";
import type { ReviewDesk } from "../srs/review.js";
import { ActivityError } from "./errors.js";
import { Exploration } from "./exploration.js";
import type { RepertoireTryJudge } from "./repertoire-session.js";

export type DeskPort = Pick<
  ReviewDesk,
  "listDueCards" | "serveCard" | "answer" | "rate" | "previewRatings"
>;

export const DUE_QUEUE_SIZE = 20;
export const DEFAULT_DRILL_SIZE = 10;
export type DrillSize = 5 | 10 | 20;

export interface TrainingDeps {
  db: Database;
  desk: DeskPort;
  clock?: Clock;
  notifications?: NotificationSink;
  /** Called after a result row is written, so the coach comments between items. */
  onNotification?: () => void;
  /** Shuffle source for puzzle queues; defaults to Math.random, tests inject a seed. */
  shuffleRandom?: (() => number) | undefined;
  /** Names the other opening a good but unexpected repertoire move reaches; without it none is. */
  repertoireJudge?: RepertoireTryJudge | undefined;
}

/** What the activity service drives on the practice queue or drill that is on the board. */
export interface PracticeRunPort {
  readonly runId: number | null;
  state(activityId: number): TrainingActivity;
  explore(kind: ExplorationKind, uci?: string): void;
  linkMessage(messageId: number): void;
  /** `stillOnBoard` is asked before a try that waited on the engine is applied. */
  tryMove(uci: string, stillOnBoard?: () => boolean): void | Promise<void>;
  showSolution(): void;
  hint(): void;
  rate(exposureId: string, quality: number): void;
  next(): void;
  end(): void;
}

export interface TrainingInput {
  mode: TrainingMode;
  motif?: string | undefined;
  color?: PlayerColor | undefined;
  /** How many positions a puzzle or opening drill holds; a review queue ignores it. */
  size?: DrillSize | undefined;
}

export type TrainingItemRef = { kind: "card"; id: number } | { kind: "puzzle"; id: string };

type QueueEntry =
  | { kind: "card"; cardId: number }
  | { kind: "puzzle"; id: string; motif: string; difficulty: string };

// A repertoire pass is served by RepertoireSession, never by a queue.
type QueueItem = Exclude<TrainingItem, { kind: "repertoire" }>;

interface Served {
  item: QueueItem;
  status: TrainingStatus;
  fen: string;
  orientation: PlayerColor;
  lastMove: string | null;
  expected: ExpectedMove | null;
  attempt: AttemptState | null;
  itemId: number;
  servedAtMs: number;
  explore: Exploration;
  seq: number;
  trail: ExploredEvent[];
  // What the client sees; unlike `trail`, which the coach reads whole, it restarts when a puzzle advances.
  shown: ShownEvent[];
  // Every graded try on the item, in order; `ply` is the solution step it was graded against.
  tries: (TriedMove & { ply: number })[];
  gaveUp: boolean;
  solutionLine: string[] | null;
  suggestedQuality: number | null;
  hintSquare: string | null;
  hinted: boolean;
  // How this item moved the student's puzzle rating; null until a rated puzzle ends.
  ratingChange: number | null;
}

// UCI's null move: a card given up before any try has no move of the student's to record.
const NO_MOVE_UCI = "0000";

// The rating a finished card pre-selects: the first try decides it, a hint means the student did
// not know it, and giving up means blank.
function suggestedQualityOf(gaveUp: boolean, firstTryRight: boolean, hinted: boolean): number {
  if (gaveUp) return 0;
  if (hinted) return 2;
  return firstTryRight ? 4 : 2;
}

// The served item as `training_runs.current_json` keeps it: enough to put the same item back at
// the same puzzle step. The explored line is not kept; a resumed item starts from its position.
// `hinted` is absent from a step stored before hints existed.
interface StoredCurrent {
  item_id: number;
  served_at: string;
  status: TrainingStatus;
  fen: string;
  last_move: string | null;
  expected: ExpectedMove | null;
  reply_uci: string | null;
  // `wrongTries` is absent from a step stored before retries existed.
  attempt: (Omit<AttemptState, "solution" | "wrongTries"> & { wrongTries?: number }) | null;
  hinted?: boolean | undefined;
  hint_square?: string | null | undefined;
  rating_change?: number | null | undefined;
}

interface ResumePoint {
  position: number;
  solved: number;
  failed: number;
  outcomes: ItemOutcome[];
  current: StoredCurrent;
}

function storedItemOf(entry: QueueEntry): StoredRunItem {
  return entry.kind === "card"
    ? { kind: "card", id: entry.cardId }
    : { kind: "puzzle", id: entry.id };
}

function queueEntryOf(db: Database, item: StoredRunItem): QueueEntry {
  if (item.kind === "card") return { kind: "card", cardId: Number(item.id) };
  const id = String(item.id);
  const header = getPuzzleHeader(db, id);
  return { kind: "puzzle", id, motif: header?.motif ?? "", difficulty: header?.difficulty ?? "" };
}

export function pausedTrainingOf(row: TrainingRunRow): PausedTraining {
  return {
    run_id: row.id,
    mode: row.mode,
    motif: row.motif,
    color: row.color,
    position: row.position,
    size: row.size,
    solved: row.solved,
    failed: row.failed,
  };
}

const turnOf = (fen: string): PlayerColor => (fen.split(" ")[1] === "b" ? "black" : "white");

// The solution moves on the board so far: everything before the cursor, plus the student's last
// move once the puzzle is solved, because the cursor stays on it.
function playedSolution(attempt: AttemptState): string[] {
  const played = attempt.solution.slice(0, attempt.cursor);
  const last = attempt.solution[attempt.cursor];
  if (attempt.status === "solved" && last) played.push(last);
  return played;
}

// Even solution indices are the student's, odd ones the puzzle's replies.
function lineFrom(fen: string, ucis: readonly string[]): PlayedMove[] {
  const board = new Chess(fen);
  return ucis.map((uci, ply) => ({
    ply,
    uci,
    san: applyUci(board, uci).san,
    by: ply % 2 === 0 ? "student" : "reply",
  }));
}

function fenAfter(fen: string, ucis: readonly string[]): string {
  const board = new Chess(fen);
  for (const uci of ucis) applyUci(board, uci);
  return board.fen();
}

function isLegalUci(fen: string, uci: string): boolean {
  return new Chess(fen)
    .moves({ verbose: true })
    .some((move) => `${move.from}${move.to}${move.promotion ?? ""}` === uci);
}

/**
 * One queue of cards or puzzles, served one at a time. It holds no activity id: the activity
 * service owns ids and staleness, and asks this for the state to publish.
 */
// Library motifs whose Lichess theme has another name; the others share theirs.
const THEME_OF_MOTIF: Readonly<Record<string, string>> = {
  back_rank_mate: "backRankMate",
  checkmate: "mate",
};

export class TrainingRun implements PracticeRunPort {
  private position = 0;
  private solved = 0;
  private failed = 0;
  // One entry per answered item, in queue order; the client draws its progress from it.
  private outcomes: ItemOutcome[] = [];
  private summary: TrainingSummary | null = null;
  private served: Served;
  private readonly clock: Clock;
  // Set while a transition writes, so the coach is woken once the rows are committed.
  private wake = false;

  /**
   * `runId` is the `training_runs` row this queue keeps current; a single item the coach served
   * has none and is never persisted.
   */
  private constructor(
    private readonly deps: TrainingDeps,
    private readonly mode: TrainingMode,
    private readonly queue: QueueEntry[],
    readonly runId: number | null,
    resume: ResumePoint | null = null,
    private readonly runMotif: string | null = null,
  ) {
    this.clock = deps.clock ?? systemClock;
    if (resume === null) {
      this.served = this.serve(0);
      return;
    }
    this.position = resume.position;
    this.solved = resume.solved;
    this.failed = resume.failed;
    this.outcomes = [...resume.outcomes];
    this.served = this.restoreServed(resume.current);
  }

  // A queue that would hold nothing is refused, so the board never shows an item that is not there.
  // A new queue ends any run still open, paused or on the board, as replaced.
  static begin(deps: TrainingDeps, input: TrainingInput): TrainingRun {
    const queue = TrainingRun.materialize(deps, input);
    if (queue.length === 0) {
      const what = input.mode === "srs" ? "no review card is due" : "no puzzle matches";
      throw new ActivityError("empty_queue", what);
    }
    const startedAt = (deps.clock ?? systemClock).now().toISOString();
    return deps.db.transaction(() => {
      endOpenTrainingRuns(deps.db, "replaced", startedAt);
      const runId = insertTrainingRun(deps.db, {
        mode: input.mode,
        motif: input.motif ?? null,
        color: input.color ?? null,
        size: queue.length,
        items: queue.map(storedItemOf),
        position: 0,
        solved: 0,
        failed: 0,
        outcomes: [],
        currentJson: "{}",
        startedAt,
      });
      const runMotif = input.mode === "puzzles" ? (input.motif ?? null) : null;
      const run = new TrainingRun(deps, input.mode, queue, runId, null, runMotif);
      run.save();
      return run;
    })();
  }

  /** Puts a paused run back at its stored item; a card is served again, with a fresh exposure. */
  static resume(deps: TrainingDeps, row: TrainingRunRow): TrainingRun {
    const queue = row.items.map((item) => queueEntryOf(deps.db, item));
    const resume: ResumePoint = {
      position: row.position,
      solved: row.solved,
      failed: row.failed,
      outcomes: row.outcomes,
      current: JSON.parse(row.currentJson) as StoredCurrent,
    };
    return deps.db.transaction(() => {
      const run = new TrainingRun(deps, row.mode, queue, row.id, resume, row.motif);
      run.save();
      return run;
    })();
  }

  static discard(deps: TrainingDeps, runId: number): void {
    endTrainingRun(deps.db, runId, "discarded", (deps.clock ?? systemClock).now().toISOString());
  }

  /** A queue of one item the coach picked; unlike `begin`, an unknown id is refused by name. */
  static beginWith(deps: TrainingDeps, item: TrainingItemRef): TrainingRun {
    if (item.kind === "card") {
      if (!getCard(deps.db, item.id)) {
        throw new ActivityError("card_not_found", `card ${item.id} does not exist`);
      }
      return new TrainingRun(deps, "srs", [{ kind: "card", cardId: item.id }], null);
    }
    const header = getPuzzleHeader(deps.db, item.id);
    if (!header) throw new ActivityError("puzzle_not_found", `puzzle ${item.id} does not exist`);
    const entry: QueueEntry = {
      kind: "puzzle",
      id: item.id,
      motif: header.motif,
      difficulty: header.difficulty,
    };
    return new TrainingRun(deps, "puzzles", [entry], null);
  }

  private static materialize(deps: TrainingDeps, input: TrainingInput): QueueEntry[] {
    if (input.mode === "srs") {
      return deps.desk
        .listDueCards(DUE_QUEUE_SIZE)
        .map((card) => ({ kind: "card", cardId: card.id }));
    }
    if (input.mode === "openings" && !input.color) {
      throw new ActivityError("empty_queue", "choose White or Black for the opening drill");
    }
    const limit = input.size ?? DEFAULT_DRILL_SIZE;
    const random = deps.shuffleRandom ?? Math.random;
    const listed = (filter: PuzzleFilter | RatingSampleFilter): PuzzleSummary[] =>
      listPuzzles(deps.db, filter, random).puzzles;
    let puzzles: PuzzleSummary[];
    if (input.mode === "openings") {
      puzzles = listed({ motif: `opening-${input.color}`, limit });
    } else {
      if (input.motif !== undefined && !isFixedPracticeMotif(input.motif)) {
        const stored = deps.db
          .prepare("SELECT 1 FROM puzzles WHERE motif = ? LIMIT 1")
          .get(input.motif);
        if (!stored) throw new ActivityError("empty_queue", "no puzzle matches");
      }
      const ratingAround = currentPuzzleRating(deps.db);
      const theme = input.motif && (THEME_OF_MOTIF[input.motif] ?? input.motif);
      puzzles = listed({ theme, ratingAround, limit });
      // A motif no theme row names yet, such as the library's unrated ones, stays reachable.
      if (puzzles.length === 0 && input.motif !== undefined) {
        puzzles = listed({ motif: input.motif, limit });
      }
    }
    return puzzles.map((p) => ({
      kind: "puzzle",
      id: p.id,
      motif: p.motif,
      difficulty: p.difficulty,
    }));
  }

  state(activityId: number): TrainingActivity {
    const s = this.served;
    const open = this.isOpen();
    const lastMove = open ? s.explore.lastMove : null;
    const lastTry = s.tries.at(-1);
    return {
      kind: "training",
      activity_id: activityId,
      orientation: s.orientation,
      fen: s.fen,
      turn: open ? s.explore.turn : turnOf(s.fen),
      last_move:
        lastMove ??
        (s.lastMove ? { from: s.lastMove.slice(0, 2), to: s.lastMove.slice(2, 4) } : null),
      legal_moves: open ? s.explore.legal() : [],
      input_enabled: open,
      pending: "none",
      mode: this.mode,
      item: s.item,
      status: s.status,
      served_at: new Date(s.servedAtMs).toISOString(),
      ...(s.item.kind === "card" ? { exposure_id: s.item.exposure_id } : {}),
      run_motif: this.runMotif,
      expected: s.expected,
      exploring: open
        ? { fen: s.explore.fen, line_san: s.explore.lineSan, trail: [...s.shown] }
        : { fen: s.fen, line_san: [], trail: [...s.shown] },
      tries: s.tries.filter((attempt) => !attempt.correct).length,
      last_try: lastTry ? { uci: lastTry.uci, san: lastTry.san, correct: lastTry.correct } : null,
      gave_up: s.gaveUp,
      solution_line: s.solutionLine,
      suggested_quality: s.suggestedQuality,
      hint_square: open ? s.hintSquare : null,
      summary: this.summary,
      moves: this.playedLine(s),
      wrong_tries: s.tries
        .filter((attempt) => !attempt.correct)
        .map(({ ply, uci, san }): WrongTry => ({ ply, uci, san })),
      queue_outcomes: this.queue.map(
        (_entry, index): QueueOutcome =>
          this.outcomes[index] ?? (index === this.position ? "current" : "pending"),
      ),
      student_rating: currentPuzzleRating(this.deps.db),
      rating_change: s.ratingChange,
    };
  }

  private playedLine(s: Served): PlayedMove[] {
    if (s.item.kind === "puzzle")
      return lineFrom(s.item.fen, playedSolution(s.attempt as AttemptState));
    const right = s.tries.find((attempt) => attempt.correct);
    if (!right || s.gaveUp) return [];
    return [{ ply: 0, uci: right.uci, san: right.san ?? right.uci, by: "student" }];
  }

  private isOpen(): boolean {
    const { status } = this.served;
    return this.summary === null && (status === "prompt" || status === "in_progress");
  }

  // Exploration is recorded and never graded; the server clock stamps it, the browser's is not trusted.
  explore(kind: ExplorationKind, uci?: string): void {
    const s = this.served;
    if (!this.isOpen()) throw new ActivityError("not_exploring", "no item is open to explore");
    if (kind === "move") {
      if (uci === undefined || !s.explore.play(uci)) {
        throw new ActivityError("illegal_exploration", `${uci ?? "no move"} is not legal here`);
      }
    } else if (!(kind === "undo" ? s.explore.undo() : s.explore.reset())) {
      throw new ActivityError("illegal_exploration", `nothing to ${kind}`);
    }
    s.seq += 1;
    const atMs = Math.max(0, this.clock.now().getTime() - s.servedAtMs);
    insertExplorationEvent(this.deps.db, {
      itemId: s.itemId,
      seq: s.seq,
      atMs,
      kind,
      uci: kind === "move" ? (uci as string) : null,
      fenAfter: s.explore.fen,
    });
    s.trail.push({ at_ms: atMs, kind, line: kind === "move" ? s.explore.line() : null });
    s.shown.push({ seq: s.seq, at_ms: atMs, kind, line_san: s.explore.lineSan });
  }

  /** Ties a chat line the student typed to the open item; a line sent between items belongs to none. */
  linkMessage(messageId: number): void {
    if (this.isOpen()) linkItemMessage(this.deps.db, this.served.itemId, messageId);
  }

  private reasoning(s: Served): TrainingReasoning {
    return {
      messages: listItemMessageTexts(this.deps.db, s.itemId),
      explored: [...s.trail],
      tries: s.tries.map(({ at_ms, uci, san, correct }) => ({ at_ms, uci, san, correct })),
      gave_up: s.gaveUp,
    };
  }

  private closeItem(s: Served, uci: string | null, correct: boolean): void {
    closeTrainingItem(this.deps.db, s.itemId, {
      answeredAt: this.clock.now().toISOString(),
      answerUci: uci,
      correct,
    });
  }

  /** Grades a dropped move against the current step; a wrong one leaves the item open. */
  tryMove(uci: string): void {
    const s = this.served;
    if (!this.isOpen()) {
      throw new ActivityError("item_finished", "this item is already over");
    }
    this.transition(() => {
      if (s.item.kind === "card") this.tryCard(s, s.item, uci);
      else this.tryPuzzle(s, s.item, uci);
      s.hintSquare = null;
    });
  }

  /** Gives up on the open item: it ends as given up and the state carries the solution line. */
  showSolution(): void {
    const s = this.served;
    if (!this.isOpen()) {
      throw new ActivityError("item_finished", "this item is already over");
    }
    this.transition(() => {
      if (s.item.kind === "card") this.finishCard(s, s.item.exposure_id, true);
      else this.givePuzzleUp(s, s.item);
      s.hintSquare = null;
    });
  }

  /** Marks the origin square of the expected move; a hinted item never counts as first try. */
  hint(): void {
    const s = this.served;
    if (!this.isOpen()) {
      throw new ActivityError("item_finished", "this item is already over");
    }
    let expectedUci: string;
    if (s.item.kind === "card") {
      const card = getCard(this.deps.db, s.item.card_id);
      if (!card) throw new ActivityError("card_not_found", `card ${s.item.card_id} does not exist`);
      expectedUci = card.expectedUci;
    } else {
      const attempt = s.attempt as AttemptState;
      const next = attempt.solution[attempt.cursor];
      if (!next) throw new ActivityError("item_finished", "this item is already over");
      expectedUci = next;
    }
    const square = expectedUci.slice(0, 2);
    this.transition(() => {
      s.hintSquare = square;
      if (!s.hinted) {
        s.hinted = true;
        setTrainingItemHinted(this.deps.db, s.itemId);
      }
    });
  }

  rate(exposureId: string, quality: number): void {
    const s = this.served;
    if (this.summary !== null) {
      throw new ActivityError("item_finished", "the queue has ended");
    }
    // Only the serving on the board can be rated: an earlier one is still open in the desk.
    if (s.item.kind !== "card" || s.item.exposure_id !== exposureId) {
      throw new SrsError("exposure_unknown", "that card is not the one on the board");
    }
    this.transition(() => {
      this.deps.desk.rate(exposureId, quality);
      s.status = "rated";
    });
  }

  // The last item's next ends the queue: the summary is written once, here.
  next(): void {
    const s = this.served;
    if (this.summary !== null) {
      throw new ActivityError("item_finished", "the queue has already ended");
    }
    const done =
      s.status === "solved" ||
      s.status === "failed" ||
      (s.status === "rated" && s.item.kind === "card");
    if (!done) {
      throw new ActivityError("item_unfinished", "answer this item before moving on");
    }
    this.transition(() => {
      if (this.position === this.queue.length - 1) {
        this.finish();
        return;
      }
      this.position += 1;
      this.served = this.serve(this.position);
    });
  }

  /** The student left the queue; a finished queue keeps the reason it already has. */
  end(): void {
    this.closeRun("ended");
  }

  private finish(): void {
    this.summary = { solved: this.solved, failed: this.failed };
    this.notify({ type: "training_summary", mode: this.mode, ...this.summary });
    this.closeRun("finished");
  }

  private closeRun(reason: RunEndReason): void {
    if (this.runId === null) return;
    endTrainingRun(this.deps.db, this.runId, reason, this.clock.now().toISOString());
  }

  // The ledger rows a step writes and the run row that follows them commit together, so a restart
  // between two steps finds the run exactly where the ledger says it was.
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
    if (this.runId === null) return;
    const s = this.served;
    const attempt = s.attempt;
    const current: StoredCurrent = {
      item_id: s.itemId,
      served_at: new Date(s.servedAtMs).toISOString(),
      status: s.status,
      fen: s.fen,
      last_move: s.lastMove,
      expected: s.expected,
      reply_uci: s.item.kind === "puzzle" ? s.item.reply_uci : null,
      attempt: attempt
        ? {
            cursor: attempt.cursor,
            fen: attempt.fen,
            answered: attempt.answered,
            status: attempt.status,
            failedPly: attempt.failedPly,
            wrongTries: attempt.wrongTries,
          }
        : null,
      hinted: s.hinted,
      hint_square: s.hintSquare,
      rating_change: s.ratingChange,
    };
    saveTrainingRun(this.deps.db, this.runId, {
      position: this.position,
      solved: this.solved,
      failed: this.failed,
      outcomes: this.outcomes,
      currentJson: JSON.stringify(current),
      updatedAt: this.clock.now().toISOString(),
    });
  }

  // Stamped by the server clock from the moment the item was served, like exploration.
  private recordTry(
    s: Served,
    ply: number,
    uci: string,
    correct: boolean,
    fenBefore: string,
  ): void {
    const atMs = Math.max(0, this.clock.now().getTime() - s.servedAtMs);
    const seq = s.tries.length + 1;
    insertTrainingTry(this.deps.db, s.itemId, { seq, atMs, ply, uci, correct });
    s.tries.push({ at_ms: atMs, ply, uci, san: sanFor(fenBefore, uci), correct });
  }

  private tryCard(s: Served, item: TrainingItem & { kind: "card" }, uci: string): void {
    if (!isLegalUci(s.fen, uci)) {
      throw new ActivityError("illegal_move", `${uci} is not legal in this position`);
    }
    const card = getCard(this.deps.db, item.card_id);
    if (!card) throw new ActivityError("card_not_found", `card ${item.card_id} does not exist`);
    const correct = uci === card.expectedUci;
    this.recordTry(s, 0, uci, correct, s.fen);
    if (correct) this.finishCard(s, item.exposure_id, false);
  }

  // The desk grades one answer per serving, so it is handed the first try: that is what the review
  // row's `correct` means. A card given up before any try is answered with the null move.
  // A hinted solve keeps the desk's grade but never counts as first try.
  private finishCard(s: Served, exposureId: string, gaveUp: boolean): void {
    const result = this.deps.desk.answer(exposureId, s.tries[0]?.uci ?? NO_MOVE_UCI);
    this.closeItem(s, s.tries.at(-1)?.uci ?? null, result.correct && !s.hinted);
    s.gaveUp = gaveUp;
    this.attachReasoning(s);
    s.explore.restart(s.fen);
    s.status = gaveUp ? "failed" : "solved";
    s.expected = gaveUp ? { uci: result.expected_uci, san: result.expected_san } : null;
    s.lastMove = gaveUp ? null : result.expected_uci;
    s.solutionLine = gaveUp ? [result.expected_uci] : null;
    s.suggestedQuality = suggestedQualityOf(gaveUp, result.correct, s.hinted);
    this.tally(!gaveUp);
    this.wake = true;
  }

  private tryPuzzle(s: Served, item: TrainingItem & { kind: "puzzle" }, uci: string): void {
    const before = s.attempt as AttemptState;
    const outcome = tryPuzzleMove(before, uci);
    if (!outcome.accepted) {
      const code = outcome.reason === "illegal" ? "illegal_move" : "item_finished";
      throw new ActivityError(code, `the puzzle refused ${uci}: ${outcome.reason}`);
    }
    this.recordTry(s, before.cursor, uci, outcome.correct, before.fen);
    const state = outcome.state;
    s.attempt = state;
    if (!outcome.correct) return;
    s.fen = state.fen;
    s.status = state.status;
    s.explore.restart(s.fen);
    if (state.status === "in_progress") {
      s.shown = [];
      s.lastMove = outcome.reply;
      s.item = { ...item, cursor: state.cursor, reply_uci: outcome.reply };
      return;
    }
    s.item = { ...item, cursor: state.cursor, reply_uci: null };
    s.lastMove = uci;
    this.closeItem(s, uci, solvedFirstTry(state) && !s.hinted);
    this.recordPuzzle(s, item, state);
  }

  private givePuzzleUp(s: Served, item: TrainingItem & { kind: "puzzle" }): void {
    const state = giveUp(s.attempt as AttemptState);
    const expectedUci = state.solution[state.cursor] as string;
    s.attempt = state;
    s.status = "failed";
    s.gaveUp = true;
    s.expected = { uci: expectedUci, san: sanFor(state.fen, expectedUci) };
    s.lastMove = null;
    s.solutionLine = solutionLineOf(state);
    s.item = { ...item, cursor: state.cursor, reply_uci: null };
    s.explore.restart(s.fen);
    this.closeItem(s, s.tries.at(-1)?.uci ?? null, false);
    this.recordPuzzle(s, item, state);
  }

  // The desk writes the srs_answer row itself, so the reasoning is merged in before the coach wakes.
  private attachReasoning(s: Served): void {
    const sink = this.deps.notifications;
    if (!sink || s.item.kind !== "card") return;
    amendPendingNotification(
      this.deps.db,
      { sessionId: sink.sessionId(), type: "srs_answer", cardId: s.item.card_id },
      { reasoning: this.reasoning(s) },
    );
  }

  private recordPuzzle(
    s: Served,
    item: TrainingItem & { kind: "puzzle" },
    state: AttemptState,
  ): void {
    const solved = state.status === "solved";
    const firstTry = solvedFirstTry(state) && !s.hinted;
    recordPuzzleAttempt(this.deps.db, {
      puzzleId: item.puzzle_id,
      attemptedAt: this.clock.now().toISOString(),
      solved,
      answered: state.answered,
      failedPly: state.failedPly,
      firstTry,
      tries: state.wrongTries,
      gaveUp: s.gaveUp,
      hinted: s.hinted,
    });
    s.ratingChange = this.movePuzzleRating(item.rating ?? null, firstTry);
    this.tally(solved);
    if (!firstTry) this.cardFromMiss(item, state, s.tries.find((t) => !t.correct)?.uci ?? null);
    this.notify({
      type: "puzzle_result",
      puzzle_id: item.puzzle_id,
      motif: item.motif,
      difficulty: item.difficulty,
      fen: s.gaveUp ? state.fen : item.fen,
      solved,
      answered_uci: [...state.answered],
      expected_uci: s.expected?.uci ?? null,
      expected_san: s.expected?.san ?? null,
      first_try: firstTry,
      tries: state.wrongTries,
      gave_up: s.gaveUp,
      reasoning: this.reasoning(s),
    });
  }

  // A puzzle not solved on the first try comes back as a review card, found after a miss or given
  // up: either way the student did not know it. The unique puzzle_id makes a repeat a no-op.
  private cardFromMiss(
    item: TrainingItem & { kind: "puzzle" },
    state: AttemptState,
    playedUci: string | null,
  ): void {
    insertCard(this.deps.db, {
      sourceKind: "teaching",
      sourceGameId: null,
      sourceMoveId: null,
      promptFen: item.fen,
      studentColor: turnOf(item.fen),
      playedUci,
      expectedUci: state.solution[0] as string,
      cpLoss: null,
      classification: null,
      explanation: getPuzzleHeader(this.deps.db, item.puzzle_id)?.explanation ?? null,
      createdAt: this.clock.now().toISOString(),
      puzzleId: item.puzzle_id,
    });
  }

  private tally(correct: boolean): void {
    if (correct) this.solved += 1;
    else this.failed += 1;
    this.outcomes[this.position] = correct ? "solved" : "failed";
  }

  // A puzzle without a rating says nothing about the student's; one with a rating is a game of Elo.
  private movePuzzleRating(puzzleRating: number | null, won: boolean): number | null {
    if (puzzleRating === null) return null;
    const before = currentPuzzleRating(this.deps.db);
    const after = ratingAfter(before, puzzleRating, won);
    setPuzzleRating(this.deps.db, after, this.clock.now().toISOString());
    return after - before;
  }

  private serve(index: number): Served {
    const entry = this.queue[index] as QueueEntry;
    const position = { position_in_queue: index + 1, queue_length: this.queue.length };
    const servedAt = this.clock.now();
    const ledger = (
      item: Omit<Parameters<typeof openTrainingItem>[1], "servedAt">,
      fen: string,
    ) => ({
      itemId: openTrainingItem(this.deps.db, {
        ...item,
        servedAt: servedAt.toISOString(),
        runId: this.runId,
      }),
      servedAtMs: servedAt.getTime(),
      explore: new Exploration(fen),
      seq: 0,
      trail: [] as ExploredEvent[],
      shown: [] as ShownEvent[],
      tries: [] as Served["tries"],
      gaveUp: false,
      solutionLine: null,
      suggestedQuality: null,
      hintSquare: null,
      hinted: false,
      ratingChange: null,
    });
    if (entry.kind === "card") {
      const card = this.deps.desk.serveCard(entry.cardId);
      return {
        item: {
          kind: "card",
          card_id: card.cardId,
          exposure_id: card.exposureId,
          prompt_fen: card.promptFen,
          student_color: card.studentColor,
          rating_preview: this.deps.desk.previewRatings(card.cardId),
          ...position,
        },
        status: "prompt",
        fen: card.promptFen,
        orientation: card.studentColor,
        lastMove: null,
        expected: null,
        attempt: null,
        ...ledger(
          {
            kind: "card",
            cardId: card.cardId,
            puzzleId: null,
            exposureId: card.exposureId,
          },
          card.promptFen,
        ),
      };
    }
    const puzzle = getPuzzle(this.deps.db, entry.id);
    if (!puzzle) throw new ActivityError("empty_queue", `puzzle ${entry.id} no longer exists`);
    return {
      item: {
        kind: "puzzle",
        puzzle_id: entry.id,
        motif: entry.motif,
        difficulty: entry.difficulty,
        fen: puzzle.fen,
        cursor: 0,
        reply_uci: null,
        rating: puzzle.rating,
        ...position,
      },
      status: "prompt",
      fen: puzzle.fen,
      orientation: turnOf(puzzle.fen),
      lastMove: null,
      expected: null,
      attempt: startAttempt(puzzle.fen, puzzle.solution),
      ...ledger({ kind: "puzzle", cardId: null, puzzleId: entry.id, exposureId: null }, puzzle.fen),
    };
  }

  private restoreServed(current: StoredCurrent): Served {
    const entry = this.queue[this.position] as QueueEntry;
    if (entry.kind === "card") return this.restoreCard(current);
    return this.restorePuzzle(entry, current);
  }

  // An exposure lives only in the desk's memory, so the card is served again. One answered but not
  // yet rated cannot be rated without its exposure: it is asked again and its tally taken back.
  private restoreCard(current: StoredCurrent): Served {
    if (current.status === "solved") this.solved -= 1;
    if (current.status === "failed") this.failed -= 1;
    if (current.status === "solved" || current.status === "failed") {
      this.outcomes.splice(this.position, 1);
    }
    const served = this.serve(this.position);
    const hinted = current.hinted ?? false;
    const hintSquare = current.hint_square ?? null;
    if (current.status !== "rated") return { ...served, hinted, hintSquare };
    return {
      ...served,
      status: "rated",
      expected: current.expected,
      lastMove: current.last_move,
      hinted,
      hintSquare,
    };
  }

  private restorePuzzle(entry: QueueEntry & { kind: "puzzle" }, current: StoredCurrent): Served {
    const puzzle = getPuzzle(this.deps.db, entry.id);
    if (!puzzle) throw new ActivityError("empty_queue", `puzzle ${entry.id} no longer exists`);
    const stored = current.attempt ?? startAttempt(puzzle.fen, puzzle.solution);
    const attempt: AttemptState = {
      ...stored,
      wrongTries: stored.wrongTries ?? 0,
      solution: puzzle.solution,
    };
    const gaveUp = attempt.status === "failed";
    return {
      item: {
        kind: "puzzle",
        puzzle_id: entry.id,
        motif: entry.motif,
        difficulty: entry.difficulty,
        fen: puzzle.fen,
        cursor: attempt.cursor,
        reply_uci: current.reply_uci,
        rating: puzzle.rating,
        position_in_queue: this.position + 1,
        queue_length: this.queue.length,
      },
      status: current.status,
      fen: current.fen,
      orientation: turnOf(puzzle.fen),
      lastMove: current.last_move,
      expected: current.expected,
      attempt,
      itemId: current.item_id,
      servedAtMs: Date.parse(current.served_at),
      explore: new Exploration(current.fen),
      seq: lastExplorationSeq(this.deps.db, current.item_id),
      trail: [],
      shown: [],
      tries: listTrainingTries(this.deps.db, current.item_id).map((stored) => ({
        at_ms: stored.atMs,
        ply: stored.ply,
        uci: stored.uci,
        san: sanFor(fenAfter(puzzle.fen, puzzle.solution.slice(0, stored.ply)), stored.uci),
        correct: stored.correct,
      })),
      gaveUp,
      solutionLine: gaveUp ? solutionLineOf(attempt) : null,
      suggestedQuality: null,
      hintSquare: current.hint_square ?? null,
      hinted: current.hinted ?? false,
      ratingChange: current.rating_change ?? null,
    };
  }

  private notify(content: PuzzleResultNotification | TrainingSummaryNotification): void {
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
