import type {
  ExpectedMove,
  PlayedMove,
  QueueOutcome,
  RepertoireScope,
  ExploredEvent as ShownEvent,
  TrainingActivity,
  TrainingItem,
  TrainingMode,
  TrainingStatus,
  TrainingSummary,
  WrongTry,
} from "@chess-coach/shared";
import { isFixedPracticeMotif, UNNAMED_OPENING } from "@chess-coach/shared";
import { Chess } from "chess.js";
import { type Clock, systemClock } from "../clock.js";
import type {
  ExploredEvent,
  PuzzleResultNotification,
  SrsAnswerNotification,
  TrainingReasoning,
  TrainingSummaryNotification,
  TriedMove,
} from "../coach/notify.js";
import { appendChatMessage } from "../db/chat.js";
import { rateFoundCard } from "../db/found-cards.js";
import { listListedFoundPositions } from "../db/found-positions.js";
import type { PlayerColor } from "../db/games.js";
import type { Database } from "../db/open.js";
import {
  getPuzzle,
  getPuzzleHeader,
  listPuzzles,
  openingNamesOfFamily,
  type PuzzleFilter,
  type PuzzleSummary,
  recordPuzzleAttempt,
} from "../db/puzzles.js";
import { getCard, insertCard } from "../db/srs.js";
import {
  amendPendingNotification,
  appendTrainingRunItems,
  closeTrainingItem,
  type ExplorationKind,
  endOpenTrainingRuns,
  endTrainingRun,
  type ItemOutcome,
  insertExplorationEvent,
  insertTrainingRun,
  insertTrainingTry,
  linkItemMessage,
  listItemMessageTexts,
  openTrainingItem,
  type RunEndReason,
  type StoredRunItem,
  saveTrainingRun,
  setTrainingItemHinted,
} from "../db/training.js";
import { applyUci } from "../engine/moves.js";
import type { NotificationSink } from "../game/notifications.js";
import type { PositionPhase } from "../openings/game-phase.js";
import { computeThemeStats } from "../progress/theme-stats.js";
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
import type { AnswerResult, ReviewDesk } from "../srs/review.js";
import { ActivityError } from "./errors.js";
import { Exploration } from "./exploration.js";
import { selectFoundDrillPositions } from "./found-drill.js";
import type { RepertoireTryJudge } from "./repertoire-session.js";

export type DeskPort = Pick<
  ReviewDesk,
  "listDueCards" | "serveCard" | "answer" | "rate" | "previewRatings"
>;

export const DUE_QUEUE_SIZE = 20;
// The puzzles drawn at a time: a queue without an end gets this many when it starts and again each
// time the student reaches its last item, and a drill over a fixed set holds this many.
export const PUZZLE_BATCH_SIZE = 10;

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
  /** A repertoire try may check the engine in the background and return a follow-up update. */
  tryMove(uci: string): void | Promise<() => boolean>;
  showSolution(): void;
  hint(): void;
  askCoach(): void;
  rate(exposureId: string, quality: number): void;
  next(): void;
  end(): void;
  /** The run stopped being on the board without the student ending it. */
  leave(): void;
}

export interface TrainingInput {
  mode: TrainingMode;
  motif?: string | undefined;
  color?: PlayerColor | undefined;
  /**
   * One opening family of the colour's drill, or UNNAMED_OPENING for its positions with no name;
   * without it the drill serves every position of the colour. In mode puzzles it is a Lichess
   * opening tag, served around the rating in place of a motif. Other modes ignore it.
   */
  opening?: string | undefined;
  /** Which positions from the student's games a found drill serves; the other modes ignore it. */
  scope?: RepertoireScope | undefined;
  /** A found drill narrowed to one phase, or to one listed position by its id. */
  phase?: PositionPhase | undefined;
  position?: string | undefined;
}

export type TrainingItemRef = { kind: "card"; id: number } | { kind: "puzzle"; id: string };

// `accepted` is set on a position from the student's games: every move it takes as right.
type QueueEntry =
  | { kind: "card"; cardId: number }
  | {
      kind: "puzzle";
      id: string;
      motif: string;
      difficulty: string;
      accepted?: readonly string[];
    };

// A repertoire pass is served by RepertoireSession, never by a queue.
type QueueItem = Exclude<TrainingItem, { kind: "repertoire" }>;

interface Served {
  item: QueueItem;
  status: TrainingStatus;
  fen: string;
  orientation: PlayerColor;
  lastMove: string | null;
  expected: ExpectedMove | null;
  // The line a puzzle steps through, and a card born from a puzzle with a line of its own; null
  // for a card graded on one move.
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
  // A puzzle solved first try without a hint writes no coach notification; `coachAsk` says whether
  // the item is one of those and whether the student has since asked for the comment.
  coachAsk: "none" | "offered" | "requested";
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

// The served item as `training_runs.current_json` keeps it: where the run stood at its last step.
// The explored line is not kept.
interface StoredCurrent {
  item_id: number;
  served_at: string;
  status: TrainingStatus;
  fen: string;
  last_move: string | null;
  expected: ExpectedMove | null;
  reply_uci: string | null;
  attempt: Omit<AttemptState, "solution"> | null;
  hinted: boolean;
  hint_square: string | null;
  rating_change: number | null;
  coach_ask: Served["coachAsk"];
}

function storedItemOf(entry: QueueEntry): StoredRunItem {
  return entry.kind === "card"
    ? { kind: "card", id: entry.cardId }
    : { kind: "puzzle", id: entry.id };
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

// The stored opening names of the family a start names, or undefined for the colour's whole drill.
// A family the colour does not have is refused here, before any run is written or replaced, and the
// text the browser sent goes no further than the comparison against what the database holds.
function openingNamesOfStart(
  db: Database,
  { color, opening }: TrainingInput,
): (string | null)[] | undefined {
  if (color === undefined || opening === undefined) return undefined;
  const names = openingNamesOfFamily(db, color, opening === UNNAMED_OPENING ? null : opening);
  if (names.length === 0) {
    throw new ActivityError("unknown_opening", `no ${color} opening drill is named ${opening}`);
  }
  return names;
}

function isLegalUci(fen: string, uci: string): boolean {
  return new Chess(fen)
    .moves({ verbose: true })
    .some((move) => `${move.from}${move.to}${move.promotion ?? ""}` === uci);
}

// A drill of the positions from the student's games reads them as the From my games list does,
// so a filter narrows the drill exactly as it narrows the list; an empty one is refused here.
function foundDrillQueueOf(deps: TrainingDeps, input: TrainingInput): QueueEntry[] {
  if (input.scope === undefined) {
    throw new ActivityError("empty_queue", "choose which positions from your games to drill");
  }
  const { color, phase, position } = input;
  const listed = listListedFoundPositions(deps.db, { color, phase, position });
  const now = (deps.clock ?? systemClock).now();
  const queue = selectFoundDrillPositions(listed, input.scope, now);
  if (queue.length === 0) {
    const what = position === undefined ? "no position from your games is" : "no such position is";
    throw new ActivityError("empty_queue", `${what} in this drill`);
  }
  return queue.map((found) => ({
    kind: "puzzle",
    id: found.id,
    motif: found.motif,
    difficulty: found.difficulty,
    accepted: found.acceptedUci,
  }));
}

// A line is the student's move, the reply and a move again, and it ends on the student's move, so
// it has an odd number of plies from 3 up; anything shorter is one question.
const MIN_CARD_LINE_PLIES = 3;

// The solution a card is reviewed through: its puzzle's whole one, so the review asks what the
// puzzle asked. Every other card is graded on its own move: one with no puzzle, one whose puzzle
// is gone (`puzzle_id` has no foreign key) or holds a single move, and one whose puzzle the seed
// has since rewritten, since a line that does not start from the card's position and move is not
// the line the card was made from.
function puzzleLineOfCard(db: Database, cardId: number): readonly string[] | null {
  const card = getCard(db, cardId);
  if (!card || card.puzzleId === null) return null;
  const puzzle = getPuzzle(db, card.puzzleId);
  if (!puzzle) return null;
  const { solution } = puzzle;
  if (solution.length < MIN_CARD_LINE_PLIES || solution.length % 2 === 0) return null;
  if (puzzle.fen !== card.promptFen || solution[0] !== card.expectedUci) return null;
  return solution;
}

// The row the desk writes describes the card's first move, which is all a card of one move is
// graded on. A card reviewed through a line is described where the student missed instead, so the
// coach explains the miss in the position it happened in: the step the solution was shown at,
// else the step of the first wrong try. At the first step that is what the desk already wrote.
function missedStepOfCard(s: Served, promptFen: string): Partial<SrsAnswerNotification> {
  const line = s.attempt;
  if (!line) return {};
  const wrong = s.tries.find((attempt) => !attempt.correct);
  const ply = s.gaveUp ? line.cursor : wrong?.ply;
  if (ply === undefined) return {};
  const fen = fenAfter(promptFen, line.solution.slice(0, ply));
  const expectedUci = line.solution[ply] as string;
  return {
    prompt_fen: fen,
    expected_uci: expectedUci,
    expected_san: sanFor(fen, expectedUci),
    ...(!s.gaveUp && wrong ? { answered_uci: wrong.uci, answered_san: wrong.san } : {}),
  };
}

/**
 * One queue of cards or puzzles, served one at a time. It holds no activity id: the activity
 * service owns ids and staleness, and asks this for the state to publish.
 */
// Library motifs whose Lichess theme has another name; the others share theirs.
export const THEME_OF_MOTIF: Readonly<Record<string, string>> = {
  back_rank_mate: "backRankMate",
  checkmate: "mate",
};

function hasStoredMotifOrTheme(db: Database, motif: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM puzzles WHERE motif = ? LIMIT 1").get(motif) ??
      db.prepare("SELECT 1 FROM puzzle_themes WHERE theme = ? LIMIT 1").get(motif),
  );
}

const puzzleEntryOf = (puzzle: PuzzleSummary): QueueEntry => ({
  kind: "puzzle",
  id: puzzle.id,
  motif: puzzle.motif,
  difficulty: puzzle.difficulty,
});

// What a start draws: the first items, and whether the queue goes on past them. A queue sampled
// around the student's rating has no end of its own; every other queue is a set fixed at the start.
interface DrawnQueue {
  entries: QueueEntry[];
  endless: boolean;
}

// A fixed set holds one batch: the opening drills, and a motif no theme row names.
function drawFixedSet(deps: TrainingDeps, filter: PuzzleFilter): DrawnQueue {
  const listing = listPuzzles(deps.db, { ...filter, limit: PUZZLE_BATCH_SIZE }, deps.shuffleRandom);
  return { entries: listing.puzzles.map(puzzleEntryOf), endless: false };
}

// The statistics screens open on 30 days, and so do the improvement areas a batch leans on. They
// are read again for every batch, so a theme that enters or leaves the list during a session is
// followed.
const BOOST_WINDOW_DAYS = "30";
// Of every batch of PUZZLE_BATCH_SIZE, this many come from the improvement areas.
const BOOSTED_PUZZLES_PER_BATCH = 3;
// The unthemed queue serves no opening material, so it never leans on the opening phase.
const BOOST_SKIPPED_THEME = "opening";

function boostableThemes(deps: TrainingDeps): string[] {
  const stats = computeThemeStats(deps.db, BOOST_WINDOW_DAYS, deps.clock ?? systemClock);
  return stats.improvement_areas.filter((theme) => theme !== BOOST_SKIPPED_THEME);
}

// The theme of each boosted place: the listed themes in turn, from one picked at random, so the
// weakest theme is not the one that always gets the extra place.
function boostedPlaces(themes: readonly string[], random: () => number): string[] {
  const first = Math.floor(random() * themes.length);
  return Array.from(
    { length: BOOSTED_PUZZLES_PER_BATCH },
    (_, place) => themes[(first + place) % themes.length] as string,
  );
}

// One themed draw around the rating for each listed theme, for as many places as it holds. A puzzle
// the run or the batch already has is not taken twice; a theme with too few puzzles leaves its
// places to the unthemed sample, which is how a batch keeps its length.
function drawBoostedPuzzles(
  deps: TrainingDeps,
  ratingAround: number,
  taken: ReadonlySet<string>,
): PuzzleSummary[] {
  const themes = boostableThemes(deps);
  if (themes.length === 0) return [];
  const places = boostedPlaces(themes, deps.shuffleRandom ?? Math.random);
  const picked = new Map<string, PuzzleSummary>();
  for (const theme of new Set(places)) {
    const wanted = places.filter((place) => place === theme).length;
    const limit = wanted + taken.size + picked.size;
    const drawn = listPuzzles(deps.db, { theme, ratingAround, limit }, deps.shuffleRandom);
    const fresh = drawn.puzzles.filter((puzzle) => !taken.has(puzzle.id) && !picked.has(puzzle.id));
    for (const puzzle of fresh.slice(0, wanted)) picked.set(puzzle.id, puzzle);
  }
  return [...picked.values()];
}

// Fisher-Yates over a copy, so the boosted puzzles of a batch sit at no fixed positions.
function shuffledBatchEntries(entries: readonly QueueEntry[], random: () => number): QueueEntry[] {
  const shuffled = [...entries];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j] as QueueEntry, shuffled[i] as QueueEntry];
  }
  return shuffled;
}

// One batch of a queue sampled around the student's rating, of one theme or of none. The sampler
// drops duplicates inside a call only, and a puzzle the run already served has been answered, so
// it is returned last, and again once a window holds too few new ones. Asking for as many extra
// puzzles as the run holds leaves a whole batch after those are dropped; the sampler's own bound
// per call (50) is where that stops being true, and a batch that then comes back short or empty is
// the end of the run. A queue of no theme leans on the student's improvement areas: its boosted
// puzzles are drawn first, the unthemed sample fills the rest, and the batch is shuffled.
function drawRatedBatch(
  deps: TrainingDeps,
  motif: string | undefined,
  taken: ReadonlySet<string>,
): QueueEntry[] {
  const theme = motif && (THEME_OF_MOTIF[motif] ?? motif);
  const ratingAround = currentPuzzleRating(deps.db);
  const boosted = motif === undefined ? drawBoostedPuzzles(deps, ratingAround, taken) : [];
  const skipped = new Set([...taken, ...boosted.map((puzzle) => puzzle.id)]);
  const filter = { theme, ratingAround, limit: PUZZLE_BATCH_SIZE + taken.size };
  const sampled = listPuzzles(deps.db, filter, deps.shuffleRandom)
    .puzzles.filter((puzzle) => !skipped.has(puzzle.id))
    .slice(0, PUZZLE_BATCH_SIZE - boosted.length);
  const batch = [...boosted, ...sampled].map(puzzleEntryOf);
  if (boosted.length === 0) return batch;
  return shuffledBatchEntries(batch, deps.shuffleRandom ?? Math.random);
}

// One batch of a queue of one Lichess opening tag, drawn as a themed batch is: around the rating the
// student has now, with the puzzles the run already holds left out. Nothing is boosted, since the
// student chose what the queue is about.
function drawOpeningTagBatch(
  deps: TrainingDeps,
  opening: string,
  taken: ReadonlySet<string>,
): QueueEntry[] {
  const ratingAround = currentPuzzleRating(deps.db);
  const filter = { opening, ratingAround, limit: PUZZLE_BATCH_SIZE + taken.size };
  return listPuzzles(deps.db, filter, deps.shuffleRandom)
    .puzzles.filter((puzzle) => !taken.has(puzzle.id))
    .slice(0, PUZZLE_BATCH_SIZE)
    .map(puzzleEntryOf);
}

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
   * has none and is never persisted. An `endless` queue has no length: it draws its next batch when
   * the student asks for the item after the last one, from `runOpening` when the queue is one
   * opening tag's.
   */
  private constructor(
    private readonly deps: TrainingDeps,
    private readonly mode: TrainingMode,
    private readonly queue: QueueEntry[],
    readonly runId: number | null,
    private readonly runMotif: string | null = null,
    private readonly endless: boolean = false,
    private readonly runOpening: string | null = null,
  ) {
    this.clock = deps.clock ?? systemClock;
    this.served = this.serve(0);
  }

  // A queue that would hold nothing is refused, so the board never shows an item that is not there.
  // A new queue ends any run still open as replaced.
  static begin(deps: TrainingDeps, input: TrainingInput): TrainingRun {
    const { entries: queue, endless } = TrainingRun.materialize(deps, input);
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
      const runOpening = input.mode === "puzzles" ? (input.opening ?? null) : null;
      const run = new TrainingRun(deps, input.mode, queue, runId, runMotif, endless, runOpening);
      run.save();
      return run;
    })();
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

  private static materialize(deps: TrainingDeps, input: TrainingInput): DrawnQueue {
    if (input.mode === "found") return { entries: foundDrillQueueOf(deps, input), endless: false };
    if (input.mode === "srs") {
      const due = deps.desk.listDueCards(DUE_QUEUE_SIZE);
      return { entries: due.map((card) => ({ kind: "card", cardId: card.id })), endless: false };
    }
    if (input.mode === "openings") {
      if (!input.color) {
        throw new ActivityError("empty_queue", "choose White or Black for the opening drill");
      }
      const openingNames = openingNamesOfStart(deps.db, input);
      return drawFixedSet(deps, { motif: `opening-${input.color}`, openingNames });
    }
    if (input.opening !== undefined) {
      // The command schema refuses the pair first; this keeps a caller that skips it to one index.
      if (input.motif !== undefined) {
        throw new ActivityError("invalid_command", "a puzzle queue of one opening takes no motif");
      }
      // A tag no puzzle carries draws nothing, and `begin` refuses the empty queue by itself.
      return { entries: drawOpeningTagBatch(deps, input.opening, new Set()), endless: true };
    }
    if (input.motif !== undefined && !isFixedPracticeMotif(input.motif)) {
      if (!hasStoredMotifOrTheme(deps.db, input.motif)) {
        throw new ActivityError("empty_queue", "no puzzle matches");
      }
    }
    const rated = drawRatedBatch(deps, input.motif, new Set());
    // A motif no theme row names yet, such as the library's unrated ones, stays reachable as a set.
    if (rated.length === 0 && input.motif !== undefined) {
      return drawFixedSet(deps, { motif: input.motif });
    }
    return { entries: rated, endless: true };
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
      queue_outcomes: this.itemsShown().map(
        (_entry, index): QueueOutcome =>
          this.outcomes[index] ?? (index === this.position ? "current" : "pending"),
      ),
      student_rating: currentPuzzleRating(this.deps.db),
      rating_change: s.ratingChange,
      coach_comment: s.coachAsk === "none" ? null : s.coachAsk,
    };
  }

  // The items the progress draws: a queue with a length shows all of it, one without shows only
  // what has been served, so it never draws an item that is not there yet.
  private itemsShown(): QueueEntry[] {
    return this.endless ? this.queue.slice(0, this.position + 1) : this.queue;
  }

  private playedLine(s: Served): PlayedMove[] {
    if (s.attempt) {
      const start = s.item.kind === "puzzle" ? s.item.fen : s.item.prompt_fen;
      return lineFrom(start, playedSolution(s.attempt));
    }
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
    if (s.item.kind === "card" && !s.attempt) {
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
      this.rateFoundPosition(s, false);
      s.hintSquare = square;
      if (!s.hinted) {
        s.hinted = true;
        setTrainingItemHinted(this.deps.db, s.itemId);
      }
    });
  }

  /** Writes the notification a first-try solve held back, once, and wakes the coach. */
  askCoach(): void {
    const s = this.served;
    if (this.isOpen() || this.summary !== null || s.coachAsk === "none") {
      throw new ActivityError("not_in_training", "no solved item is waiting for a coach comment");
    }
    if (s.coachAsk === "requested") {
      throw new ActivityError("already_requested", "the coach was already asked about this item");
    }
    const item = s.item;
    const state = s.attempt as AttemptState;
    if (item.kind !== "puzzle") {
      throw new ActivityError("not_in_training", "only a puzzle can be asked about");
    }
    this.transition(() => {
      s.coachAsk = "requested";
      this.notify(this.puzzleResultOf(s, item, state, true, true));
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

  // The last item's next ends a queue with a length: the summary is written once, here. A queue
  // without one draws its next batch there instead, and ends only when nothing new is left to draw.
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
      if (this.position === this.queue.length - 1 && !this.refill()) {
        this.finish();
        return;
      }
      this.position += 1;
      this.served = this.serve(this.position);
    });
  }

  // Appends the next batch to the queue and to the run's stored items; false when there is none.
  private refill(): boolean {
    if (!this.endless) return false;
    const taken = new Set(
      this.queue.flatMap((entry) => (entry.kind === "puzzle" ? [entry.id] : [])),
    );
    const added =
      this.runOpening === null
        ? drawRatedBatch(this.deps, this.runMotif ?? undefined, taken)
        : drawOpeningTagBatch(this.deps, this.runOpening, taken);
    if (added.length === 0) return false;
    if (this.runId !== null)
      appendTrainingRunItems(this.deps.db, this.runId, added.map(storedItemOf));
    this.queue.push(...added);
    return true;
  }

  /** The student left the queue; a finished queue keeps the reason it already has. */
  end(): void {
    this.closeRun("ended");
  }

  /** The board moved on without the student ending the queue; a run already ended keeps its reason. */
  leave(): void {
    this.closeRun("left");
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

  // The ledger rows a step writes and the run row that follows them commit together, so the row
  // always says where the ledger says the run was.
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
      coach_ask: s.coachAsk,
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
    if (s.attempt) {
      this.tryCardLine(s, item, s.attempt, uci);
      return;
    }
    const card = getCard(this.deps.db, item.card_id);
    if (!card) throw new ActivityError("card_not_found", `card ${item.card_id} does not exist`);
    const correct = uci === card.expectedUci;
    this.recordTry(s, 0, uci, correct, s.fen);
    if (correct) this.finishCard(s, item.exposure_id, false);
  }

  // One step of a card reviewed through its puzzle's line, graded as the puzzle's own step is: a
  // wrong try keeps the step, a right one plays the reply. Only the ending is a card's, rated by
  // the student, so no attempt, rating move or new card is written.
  private tryCardLine(
    s: Served,
    item: TrainingItem & { kind: "card" },
    before: AttemptState,
    uci: string,
  ): void {
    const outcome = tryPuzzleMove(before, uci);
    if (!outcome.accepted) {
      const code = outcome.reason === "illegal" ? "illegal_move" : "item_finished";
      throw new ActivityError(code, `the card refused ${uci}: ${outcome.reason}`);
    }
    this.recordTry(s, before.cursor, uci, outcome.correct, before.fen);
    s.attempt = outcome.state;
    if (!outcome.correct) return;
    s.fen = outcome.state.fen;
    s.explore.restart(s.fen);
    if (outcome.state.status === "in_progress") {
      s.status = "in_progress";
      s.shown = [];
      s.lastMove = outcome.reply;
      return;
    }
    s.lastMove = uci;
    this.finishCard(s, item.exposure_id, false);
  }

  // The desk grades one answer per serving, so it is handed the first try: that is what the review
  // row's `correct` means. A card given up before any try is answered with the null move. A card
  // reviewed through a line is also told whether every step was right first time, since the first
  // move alone cannot say that a later one was missed. A hinted solve keeps the desk's grade but
  // never counts as first try.
  private finishCard(s: Served, exposureId: string, gaveUp: boolean): void {
    const line = s.attempt;
    const lineRight = !gaveUp && (line?.wrongTries ?? 0) === 0;
    const result = this.deps.desk.answer(exposureId, s.tries[0]?.uci ?? NO_MOVE_UCI, lineRight);
    this.closeItem(s, s.tries.at(-1)?.uci ?? null, result.correct && !s.hinted);
    s.gaveUp = gaveUp;
    this.attachReasoning(s);
    if (line) this.placeLineEnding(s, line, gaveUp);
    else this.placeMoveEnding(s, result, gaveUp);
    s.status = gaveUp ? "failed" : "solved";
    s.suggestedQuality = suggestedQualityOf(gaveUp, result.correct, s.hinted);
    this.tally(!gaveUp);
    this.wake = true;
  }

  // A right answer stays on the board, as a puzzle's last move does. A card given up keeps the
  // prompt position instead: `solution_line` is played from `fen`, so the client animates it.
  private placeMoveEnding(s: Served, result: AnswerResult, gaveUp: boolean): void {
    if (!gaveUp) s.fen = fenAfter(s.fen, [result.expected_uci]);
    s.explore.restart(s.fen);
    s.expected = gaveUp ? { uci: result.expected_uci, san: result.expected_san } : null;
    s.lastMove = gaveUp ? null : result.expected_uci;
    s.solutionLine = gaveUp ? [result.expected_uci] : null;
  }

  // A line solved already rests on its last move. One given up keeps the position of the step it
  // stopped at, and `solution_line` holds the moves left from there.
  private placeLineEnding(s: Served, line: AttemptState, gaveUp: boolean): void {
    if (!gaveUp) return;
    const state = giveUp(line);
    const expectedUci = state.solution[state.cursor] as string;
    s.attempt = state;
    s.explore.restart(s.fen);
    s.expected = { uci: expectedUci, san: sanFor(state.fen, expectedUci) };
    s.lastMove = null;
    s.solutionLine = solutionLineOf(state);
  }

  private tryPuzzle(s: Served, item: TrainingItem & { kind: "puzzle" }, uci: string): void {
    const before = s.attempt as AttemptState;
    const outcome = tryPuzzleMove(before, uci);
    if (!outcome.accepted) {
      const code = outcome.reason === "illegal" ? "illegal_move" : "item_finished";
      throw new ActivityError(code, `the puzzle refused ${uci}: ${outcome.reason}`);
    }
    this.rateFoundPosition(s, outcome.correct);
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
    this.rateFoundPosition(s, false);
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
      { ...missedStepOfCard(s, s.item.prompt_fen), reasoning: this.reasoning(s) },
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
    // A position from the student's games keeps its own schedule, so a miss stays off the review desk.
    if (!firstTry && this.mode !== "found") {
      this.cardFromMiss(item, state, s.tries.find((t) => !t.correct)?.uci ?? null);
    }
    // Nothing needed explaining, so the coach hears of it only when the student asks: a row written
    // now would still be flushed with the next wake or at the next start and draw the same reply.
    if (firstTry) {
      s.coachAsk = "offered";
      return;
    }
    this.notify(this.puzzleResultOf(s, item, state, firstTry, false));
  }

  private puzzleResultOf(
    s: Served,
    item: TrainingItem & { kind: "puzzle" },
    state: AttemptState,
    firstTry: boolean,
    requested: boolean,
  ): PuzzleResultNotification {
    return {
      type: "puzzle_result",
      puzzle_id: item.puzzle_id,
      motif: item.motif,
      difficulty: item.difficulty,
      fen: s.gaveUp ? state.fen : item.fen,
      solved: state.status === "solved",
      answered_uci: [...state.answered],
      expected_uci: s.expected?.uci ?? null,
      expected_san: s.expected?.san ?? null,
      first_try: firstTry,
      tries: state.wrongTries,
      gave_up: s.gaveUp,
      reasoning: this.reasoning(s),
      ...(requested ? { requested: true, solution_san: this.solutionSan(item, state) } : {}),
    };
  }

  private solutionSan(item: TrainingItem & { kind: "puzzle" }, state: AttemptState): string[] {
    return lineFrom(item.fen, state.solution).map((move) => move.san);
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

  // A position from the student's games is rated once, by the first thing the student does on it:
  // a right try passes it, and a wrong try, a hint or a give-up fails it. Each caller runs inside
  // `transition`, so the card moves with the step that rated it or not at all.
  private rateFoundPosition(s: Served, right: boolean): void {
    if (this.mode !== "found" || s.item.kind !== "puzzle") return;
    if (s.tries.length > 0 || s.hinted || s.gaveUp) return;
    rateFoundCard(this.deps.db, s.item.puzzle_id, right, this.clock.now());
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
    const position = { position_in_queue: index + 1 };
    const length = { queue_length: this.queue.length };
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
      coachAsk: "none" as const,
      solutionLine: null,
      suggestedQuality: null,
      hintSquare: null,
      hinted: false,
      ratingChange: null,
    });
    if (entry.kind === "card") {
      const card = this.deps.desk.serveCard(entry.cardId);
      const line = puzzleLineOfCard(this.deps.db, card.cardId);
      return {
        item: {
          kind: "card",
          card_id: card.cardId,
          exposure_id: card.exposureId,
          prompt_fen: card.promptFen,
          student_color: card.studentColor,
          rating_preview: this.deps.desk.previewRatings(card.cardId),
          ...position,
          ...length,
        },
        status: "prompt",
        fen: card.promptFen,
        orientation: card.studentColor,
        lastMove: null,
        expected: null,
        attempt: line ? startAttempt(card.promptFen, line) : null,
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
        opening_name: puzzle.openingName,
        ...position,
        ...(this.endless ? {} : length),
      },
      status: "prompt",
      fen: puzzle.fen,
      orientation: turnOf(puzzle.fen),
      lastMove: null,
      expected: null,
      attempt: startAttempt(puzzle.fen, puzzle.solution, entry.accepted),
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
    this.wake = true;
  }
}
