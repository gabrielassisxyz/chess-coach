import type {
  ExpectedMove,
  PausedTraining,
  ExploredEvent as ShownEvent,
  TrainingActivity,
  TrainingItem,
  TrainingMode,
  TrainingStatus,
  TrainingSummary,
} from "@chess-coach/shared";
import { Chess } from "chess.js";
import { type Clock, systemClock } from "../clock.js";
import type {
  ExploredEvent,
  PuzzleResultNotification,
  TrainingReasoning,
  TrainingSummaryNotification,
} from "../coach/notify.js";
import { appendChatMessage } from "../db/chat.js";
import type { PlayerColor } from "../db/games.js";
import type { Database } from "../db/open.js";
import { getPuzzle, getPuzzleHeader, listPuzzles, recordPuzzleAttempt } from "../db/puzzles.js";
import { getCard, insertCard } from "../db/srs.js";
import {
  amendPendingNotification,
  closeTrainingItem,
  type ExplorationKind,
  endOpenTrainingRuns,
  endTrainingRun,
  insertExplorationEvent,
  insertTrainingRun,
  lastExplorationSeq,
  linkItemMessage,
  listItemMessageTexts,
  openTrainingItem,
  type RunEndReason,
  type StoredRunItem,
  saveTrainingRun,
  type TrainingRunRow,
} from "../db/training.js";
import type { NotificationSink } from "../game/notifications.js";
import { type AttemptState, answer as answerPuzzle, startAttempt } from "../puzzles/attempt.js";
import { sanFor } from "../srs/cards.js";
import { SrsError } from "../srs/errors.js";
import type { ReviewDesk } from "../srs/review.js";
import { ActivityError } from "./errors.js";
import { Exploration } from "./exploration.js";

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

interface Served {
  item: TrainingItem;
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
}

// The served item as `training_runs.current_json` keeps it: enough to put the same item back at
// the same puzzle step. The explored line is not kept; a resumed item starts from its position.
interface StoredCurrent {
  item_id: number;
  served_at: string;
  status: TrainingStatus;
  fen: string;
  last_move: string | null;
  expected: ExpectedMove | null;
  reply_uci: string | null;
  attempt: Omit<AttemptState, "solution"> | null;
}

interface ResumePoint {
  position: number;
  solved: number;
  failed: number;
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

function isLegalUci(fen: string, uci: string): boolean {
  return new Chess(fen)
    .moves({ verbose: true })
    .some((move) => `${move.from}${move.to}${move.promotion ?? ""}` === uci);
}

/**
 * One queue of cards or puzzles, served one at a time. It holds no activity id: the activity
 * service owns ids and staleness, and asks this for the state to publish.
 */
export class TrainingRun {
  private position = 0;
  private solved = 0;
  private failed = 0;
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
  ) {
    this.clock = deps.clock ?? systemClock;
    if (resume === null) {
      this.served = this.serve(0);
      return;
    }
    this.position = resume.position;
    this.solved = resume.solved;
    this.failed = resume.failed;
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
        currentJson: "{}",
        startedAt,
      });
      const run = new TrainingRun(deps, input.mode, queue, runId);
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
      current: JSON.parse(row.currentJson) as StoredCurrent,
    };
    return deps.db.transaction(() => {
      const run = new TrainingRun(deps, row.mode, queue, row.id, resume);
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
    const motif = input.mode === "openings" ? `opening-${input.color}` : input.motif;
    const { puzzles } = listPuzzles(deps.db, {
      motif,
      limit: input.size ?? DEFAULT_DRILL_SIZE,
    });
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
      expected: s.expected,
      exploring: open
        ? { fen: s.explore.fen, line_san: s.explore.lineSan, trail: [...s.shown] }
        : { fen: s.fen, line_san: [], trail: [...s.shown] },
      summary: this.summary,
    };
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
    };
  }

  private closeItem(s: Served, uci: string, correct: boolean): void {
    closeTrainingItem(this.deps.db, s.itemId, {
      answeredAt: this.clock.now().toISOString(),
      answerUci: uci,
      correct,
    });
  }

  answer(uci: string): void {
    const s = this.served;
    if (!this.isOpen()) {
      throw new ActivityError("item_finished", "this item is already answered");
    }
    this.transition(() => {
      if (s.item.kind === "card") this.answerCard(s, s.item.exposure_id, uci);
      else this.answerPuzzle(s, s.item, uci);
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
          }
        : null,
    };
    saveTrainingRun(this.deps.db, this.runId, {
      position: this.position,
      solved: this.solved,
      failed: this.failed,
      currentJson: JSON.stringify(current),
      updatedAt: this.clock.now().toISOString(),
    });
  }

  private answerCard(s: Served, exposureId: string, uci: string): void {
    if (!isLegalUci(s.fen, uci)) {
      throw new ActivityError("illegal_move", `${uci} is not legal in this position`);
    }
    const result = this.deps.desk.answer(exposureId, uci);
    this.closeItem(s, uci, result.correct);
    this.attachReasoning(s);
    s.explore.restart(s.fen);
    s.status = result.correct ? "solved" : "failed";
    s.expected = { uci: result.expected_uci, san: result.expected_san };
    s.lastMove = result.expected_uci;
    this.tally(result.correct);
    this.wake = true;
  }

  private answerPuzzle(s: Served, item: TrainingItem & { kind: "puzzle" }, uci: string): void {
    const attempt = s.attempt as AttemptState;
    const outcome = answerPuzzle(attempt, uci);
    if (!outcome.accepted) {
      const code = outcome.reason === "illegal" ? "illegal_move" : "item_finished";
      throw new ActivityError(code, `the puzzle refused ${uci}: ${outcome.reason}`);
    }
    const state = outcome.state;
    s.attempt = state;
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
    if (state.status === "solved") {
      s.lastMove = uci;
    } else {
      const expectedUci = state.solution[state.failedPly as number] as string;
      s.expected = { uci: expectedUci, san: sanFor(attempt.fen, expectedUci) };
      s.lastMove = expectedUci;
    }
    this.closeItem(s, uci, state.status === "solved");
    this.recordPuzzle(item, state, s.expected, attempt.fen, this.reasoning(s));
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
    item: TrainingItem & { kind: "puzzle" },
    state: AttemptState,
    expected: ExpectedMove | null,
    failedFen: string,
    reasoning: TrainingReasoning,
  ): void {
    const solved = state.status === "solved";
    recordPuzzleAttempt(this.deps.db, {
      puzzleId: item.puzzle_id,
      attemptedAt: this.clock.now().toISOString(),
      solved,
      answered: state.answered,
      failedPly: state.failedPly,
    });
    this.tally(solved);
    if (!solved) this.cardFromFailure(item, state);
    this.notify({
      type: "puzzle_result",
      puzzle_id: item.puzzle_id,
      motif: item.motif,
      difficulty: item.difficulty,
      fen: solved ? item.fen : failedFen,
      solved,
      answered_uci: [...state.answered],
      expected_uci: expected?.uci ?? null,
      expected_san: expected?.san ?? null,
      reasoning,
    });
  }

  // Every failed puzzle comes back as a review card; the unique puzzle_id makes a repeat failure a no-op.
  private cardFromFailure(item: TrainingItem & { kind: "puzzle" }, state: AttemptState): void {
    insertCard(this.deps.db, {
      sourceKind: "teaching",
      sourceGameId: null,
      sourceMoveId: null,
      promptFen: item.fen,
      studentColor: turnOf(item.fen),
      playedUci: state.answered.at(-1) ?? null,
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
    const served = this.serve(this.position);
    if (current.status !== "rated") return served;
    return { ...served, status: "rated", expected: current.expected, lastMove: current.last_move };
  }

  private restorePuzzle(entry: QueueEntry & { kind: "puzzle" }, current: StoredCurrent): Served {
    const puzzle = getPuzzle(this.deps.db, entry.id);
    if (!puzzle) throw new ActivityError("empty_queue", `puzzle ${entry.id} no longer exists`);
    const stored = current.attempt ?? startAttempt(puzzle.fen, puzzle.solution);
    const attempt: AttemptState = { ...stored, solution: puzzle.solution };
    return {
      item: {
        kind: "puzzle",
        puzzle_id: entry.id,
        motif: entry.motif,
        difficulty: entry.difficulty,
        fen: puzzle.fen,
        cursor: attempt.cursor,
        reply_uci: current.reply_uci,
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
