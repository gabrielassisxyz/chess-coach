import type {
  ExpectedMove,
  TrainingActivity,
  TrainingItem,
  TrainingMode,
  TrainingStatus,
  TrainingSummary,
} from "@chess-coach/shared";
import { Chess } from "chess.js";
import { type Clock, systemClock } from "../clock.js";
import type { PuzzleResultNotification, TrainingSummaryNotification } from "../coach/notify.js";
import { appendChatMessage } from "../db/chat.js";
import type { PlayerColor } from "../db/games.js";
import type { Database } from "../db/open.js";
import { getPuzzle, listPuzzles, recordPuzzleAttempt } from "../db/puzzles.js";
import type { NotificationSink } from "../game/notifications.js";
import { legalMoves } from "../game/snapshot.js";
import { type AttemptState, answer as answerPuzzle, startAttempt } from "../puzzles/attempt.js";
import { sanFor } from "../srs/cards.js";
import { SrsError } from "../srs/errors.js";
import type { ReviewDesk } from "../srs/review.js";
import { ActivityError } from "./errors.js";

export type DeskPort = Pick<ReviewDesk, "listDueCards" | "serveCard" | "answer" | "rate">;

export const DUE_QUEUE_SIZE = 20;
export const PUZZLE_QUEUE_SIZE = 10;

export interface TrainingDeps {
  db: Database;
  desk: DeskPort;
  clock?: Clock;
  notifications?: NotificationSink;
  /** Called after a result row is written, so the coach comments between items. */
  onNotification?: () => void;
}

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
  static begin(deps: TrainingDeps, input: { mode: TrainingMode; motif?: string }): TrainingRun {
    const queue = TrainingRun.materialize(deps, input);
    if (queue.length === 0) {
      const what = input.mode === "srs" ? "no review card is due" : "no puzzle matches";
      throw new ActivityError("empty_queue", what);
    }
    return new TrainingRun(deps, input.mode, queue);
  }

  private static materialize(
    deps: TrainingDeps,
    input: { mode: TrainingMode; motif?: string },
  ): QueueEntry[] {
    if (input.mode === "srs") {
      return deps.desk
        .listDueCards(DUE_QUEUE_SIZE)
        .map((card) => ({ kind: "card", cardId: card.id }));
    }
    const { puzzles } = listPuzzles(deps.db, {
      motif: input.motif,
      limit: PUZZLE_QUEUE_SIZE,
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
    const open = this.summary === null && (s.status === "prompt" || s.status === "in_progress");
    const chess = new Chess(s.fen);
    return {
      kind: "training",
      activity_id: activityId,
      orientation: s.orientation,
      fen: s.fen,
      turn: turnOf(s.fen),
      last_move: s.lastMove ? { from: s.lastMove.slice(0, 2), to: s.lastMove.slice(2, 4) } : null,
      legal_moves: open ? legalMoves(chess) : [],
      input_enabled: open,
      pending: "none",
      mode: this.mode,
      item: s.item,
      status: s.status,
      ...(s.item.kind === "card" ? { exposure_id: s.item.exposure_id } : {}),
      expected: s.expected,
      summary: this.summary,
    };
  }

  answer(uci: string): void {
    const s = this.served;
    if (this.summary !== null || (s.status !== "prompt" && s.status !== "in_progress")) {
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
    if (state.status === "in_progress") {
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
    this.recordPuzzle(item, state, s.expected, attempt.fen);
  }

  private recordPuzzle(
    item: TrainingItem & { kind: "puzzle" },
    state: AttemptState,
    expected: ExpectedMove | null,
    failedFen: string,
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
    });
  }

  private tally(correct: boolean): void {
    if (correct) this.solved += 1;
    else this.failed += 1;
  }

  private serve(index: number): Served {
    const entry = this.queue[index] as QueueEntry;
    const position = { position_in_queue: index + 1, queue_length: this.queue.length };
    if (entry.kind === "card") {
      const card = this.deps.desk.serveCard(entry.cardId);
      return {
        item: {
          kind: "card",
          card_id: card.cardId,
          exposure_id: card.exposureId,
          prompt_fen: card.promptFen,
          student_color: card.studentColor,
          ...position,
        },
        status: "prompt",
        fen: card.promptFen,
        orientation: card.studentColor,
        lastMove: null,
        expected: null,
        attempt: null,
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
