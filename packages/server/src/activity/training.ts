import type {
  ExpectedMove,
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
  insertExplorationEvent,
  linkItemMessage,
  listItemMessageTexts,
  openTrainingItem,
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

  private constructor(
    private readonly deps: TrainingDeps,
    private readonly mode: TrainingMode,
    private readonly queue: QueueEntry[],
  ) {
    this.clock = deps.clock ?? systemClock;
    this.served = this.serve(0);
  }

  // A queue that would hold nothing is refused, so the board never shows an item that is not there.
  static begin(deps: TrainingDeps, input: TrainingInput): TrainingRun {
    const queue = TrainingRun.materialize(deps, input);
    if (queue.length === 0) {
      const what = input.mode === "srs" ? "no review card is due" : "no puzzle matches";
      throw new ActivityError("empty_queue", what);
    }
    return new TrainingRun(deps, input.mode, queue);
  }

  /** A queue of one item the coach picked; unlike `begin`, an unknown id is refused by name. */
  static beginWith(deps: TrainingDeps, item: TrainingItemRef): TrainingRun {
    if (item.kind === "card") {
      if (!getCard(deps.db, item.id)) {
        throw new ActivityError("card_not_found", `card ${item.id} does not exist`);
      }
      return new TrainingRun(deps, "srs", [{ kind: "card", cardId: item.id }]);
    }
    const header = getPuzzleHeader(deps.db, item.id);
    if (!header) throw new ActivityError("puzzle_not_found", `puzzle ${item.id} does not exist`);
    const entry: QueueEntry = {
      kind: "puzzle",
      id: item.id,
      motif: header.motif,
      difficulty: header.difficulty,
    };
    return new TrainingRun(deps, "puzzles", [entry]);
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
    if (s.item.kind === "card") this.answerCard(s, s.item.exposure_id, uci);
    else this.answerPuzzle(s, s.item, uci);
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
    this.deps.desk.rate(exposureId, quality);
    s.status = "rated";
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
    if (this.position === this.queue.length - 1) {
      this.finish();
      return;
    }
    this.position += 1;
    this.served = this.serve(this.position);
  }

  private finish(): void {
    this.summary = { solved: this.solved, failed: this.failed };
    this.notify({ type: "training_summary", mode: this.mode, ...this.summary });
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
    this.deps.onNotification?.();
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
      itemId: openTrainingItem(this.deps.db, { ...item, servedAt: servedAt.toISOString() }),
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

  private notify(content: PuzzleResultNotification | TrainingSummaryNotification): void {
    const sink = this.deps.notifications;
    if (!sink) return;
    appendChatMessage(
      this.deps.db,
      sink.sessionId(),
      { role: "user", kind: "notification", contentJson: JSON.stringify(content) },
      this.clock,
    );
    this.deps.onNotification?.();
  }
}
