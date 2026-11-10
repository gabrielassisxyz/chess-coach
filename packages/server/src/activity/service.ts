import type {
  ActivityKind,
  ActivityState,
  PausedTraining,
  PromotionPiece,
  RepertoireScope,
  TrainingMode,
} from "@chess-coach/shared";
import { Chess } from "chess.js";
import {
  type GameRecord,
  getGame,
  listMoves,
  type MoveRecord,
  type PlayerColor,
} from "../db/games.js";
import type { Database } from "../db/open.js";
import { type ExplorationKind, findOpenTrainingRun, type TrainingRunRow } from "../db/training.js";
import { GameError } from "../game/errors.js";
import type { GameService, TurnReport } from "../game/service.js";
import type { GameSnapshot } from "../game/snapshot.js";
import { type Log, type LogFields, silentLog } from "../log.js";
import { ActivityError } from "./errors.js";
import { RepertoireSession } from "./repertoire-session.js";
import { demoState, liveGameState, reviewState } from "./state.js";
import {
  type DrillSize,
  type PracticeRunPort,
  pausedTrainingOf,
  type TrainingDeps,
  type TrainingItemRef,
  TrainingRun,
} from "./training.js";

export type LiveGamePort = Pick<
  GameService,
  "snapshot" | "current" | "onSnapshot" | "newGame" | "playerMove" | "undo" | "resign" | "abort"
>;

export interface ActivityServiceOptions {
  db: Database;
  game: LiveGamePort;
  /** What a training queue needs besides the database; without it training is unavailable. */
  training?: Omit<TrainingDeps, "db">;
  log?: Log;
}

type StateListener = (state: ActivityState | null) => void;

// What a demo returns to. A live game is re-read on return because its turn may have completed meanwhile.
// A training queue is kept in memory while its demo is on the board, then re-published.
type Underneath =
  | { kind: "live_game"; orientation: PlayerColor }
  | { kind: "review"; orientation: PlayerColor; gameId: number; ply: number }
  | { kind: "training"; orientation: PlayerColor };

interface DemoBoard {
  chess: Chess;
  played: string[];
}

interface ReviewData {
  game: GameRecord;
  moves: MoveRecord[];
}

export class ActivityService {
  private readonly db: Database;
  private readonly game: LiveGamePort;
  private readonly trainingDeps: Omit<TrainingDeps, "db"> | null;
  private readonly log: Log;
  private state: ActivityState | null = null;
  private nextId = 1;
  private demo: DemoBoard | null = null;
  private underneath: Underneath | null = null;
  private review: ReviewData | null = null;
  private run: PracticeRunPort | null = null;
  private readonly chains = new Map<ActivityKind, Promise<unknown>>();
  private readonly listeners = new Set<StateListener>();

  constructor(options: ActivityServiceOptions) {
    this.db = options.db;
    this.game = options.game;
    this.trainingDeps = options.training ?? null;
    this.log = options.log ?? silentLog;
    this.game.onSnapshot((snapshot) => this.followLiveGame(snapshot));
  }

  current(): ActivityState | null {
    return this.state;
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startDemo(fen: string): Promise<ActivityState> {
    return this.enqueue("demo", async () => {
      this.refuseOverLiveGame();
      this.refuseOverOpenTrainingItem();
      let chess: Chess;
      try {
        chess = new Chess(fen);
      } catch (error) {
        throw new ActivityError(
          "invalid_position",
          error instanceof Error ? error.message : String(error),
        );
      }
      // A demo started over a demo still returns to what was under the first one.
      if (this.state?.kind !== "demo") this.underneath = this.underneathOf(this.state);
      this.demo = { chess, played: [] };
      return this.publishDemo(this.nextId++, "startDemo");
    });
  }

  demoMove(san: string, expectedActivityId?: number): Promise<ActivityState> {
    return this.enqueue("demo", async () => {
      const demo = this.requireDemo(expectedActivityId);
      try {
        demo.chess.move(san);
      } catch {
        throw new ActivityError("illegal_move", `${san} is not legal in the demo position`);
      }
      demo.played.push(san);
      return this.publishDemo((this.state as ActivityState).activity_id, "demoMove");
    });
  }

  leaveDemo(expectedActivityId?: number): Promise<ActivityState | null> {
    return this.enqueue("demo", async () => {
      this.requireDemo(expectedActivityId);
      const back = this.underneath;
      this.demo = null;
      this.underneath = null;
      if (back?.kind === "live_game") return this.setLiveGame("leaveDemo");
      if (back?.kind === "review") return this.setReview(back.gameId, back.ply, "leaveDemo");
      if (back?.kind === "training") {
        if (!this.run) return this.publish(null, "leaveDemo");
        return this.publish(this.run.state(this.nextId++), "leaveDemo");
      }
      return this.publish(null, "leaveDemo");
    });
  }

  openGame(gameId: number): Promise<ActivityState> {
    const live = this.game.current();
    const isLive = live?.id === gameId && live.finishedAt === null;
    return this.enqueue(isLive ? "live_game" : "review", async () => {
      if (isLive) return this.setLiveGame("openGame");
      return this.setReview(gameId, null, "openGame");
    });
  }

  selectReviewPly(
    gameId: number,
    ply: number,
    expectedActivityId?: number,
  ): Promise<ActivityState> {
    return this.enqueue("review", async () => {
      this.checkFresh(expectedActivityId);
      const state = this.state;
      if (state?.kind !== "review" || state.game.id !== gameId || !this.review) {
        throw new ActivityError("not_in_review", `game ${gameId} is not open for review`);
      }
      if (ply < 0 || ply > this.review.moves.length) {
        throw new ActivityError("invalid_ply", `ply must be within 0..${this.review.moves.length}`);
      }
      const { game, moves } = this.review;
      return this.publish(reviewState(state.activity_id, game, moves, ply), "selectReviewPly");
    });
  }

  enterLiveGame(): Promise<ActivityState> {
    return this.enqueue("live_game", async () => this.setLiveGame("enterLiveGame"));
  }

  // The new game is entered only after it has settled, so no one sees its half-built first turn.
  newGame(input: { color: PlayerColor; elo?: number; fen?: string }): Promise<ActivityState> {
    return this.enqueue("live_game", async () => {
      await this.game.newGame(input);
      return this.setLiveGame("newGame");
    });
  }

  startTraining(input: {
    mode: TrainingMode;
    motif?: string;
    color?: PlayerColor;
    size?: DrillSize;
    repertoireId?: number;
    scope?: RepertoireScope;
  }): Promise<ActivityState> {
    return this.enqueue("training", async () => {
      if (!this.trainingDeps) {
        throw new ActivityError("not_in_training", "training is not available");
      }
      const deps = { ...this.trainingDeps, db: this.db };
      const run =
        input.mode === "repertoire"
          ? RepertoireSession.begin(deps, input)
          : TrainingRun.begin(deps, input);
      this.leaveSideBoards();
      this.run = run;
      return this.logServed(this.publish(run.state(this.nextId++), "startTraining"));
    });
  }

  // Stacks over a finished game, a review or a demo; a second session never replaces an open one.
  startTrainingItem(item: TrainingItemRef): Promise<ActivityState> {
    return this.enqueue("training", async () => {
      this.refuseOverLiveGame();
      if (!this.trainingDeps) {
        throw new ActivityError("not_in_training", "training is not available");
      }
      if (this.state?.kind === "training") {
        throw new ActivityError("training_active", "a training session is already open");
      }
      const run = TrainingRun.beginWith({ ...this.trainingDeps, db: this.db }, item);
      this.leaveSideBoards();
      this.run = run;
      return this.logServed(this.publish(run.state(this.nextId++), "startTrainingItem"));
    });
  }

  trainingTry(uci: string, expectedActivityId?: number): Promise<ActivityState> {
    return this.stepTraining(expectedActivityId, "trainingTry", (run) => run.tryMove(uci)).then(
      (state) => {
        if (state.kind === "training") {
          this.log.info("training.answer", {
            activity_id: state.activity_id,
            try: true,
            uci,
            correct: state.last_try?.correct ?? null,
            tries: state.tries,
            item: state.item,
            status: state.status,
            expected: state.expected,
          });
        }
        return state;
      },
    );
  }

  trainingShowSolution(expectedActivityId?: number): Promise<ActivityState> {
    return this.stepTraining(expectedActivityId, "trainingShowSolution", (run) =>
      run.showSolution(),
    ).then((state) => {
      if (state.kind === "training") {
        this.log.info("training.answer", {
          activity_id: state.activity_id,
          gave_up: true,
          tries: state.tries,
          item: state.item,
          status: state.status,
          solution_line: state.solution_line,
        });
      }
      return state;
    });
  }

  trainingHint(expectedActivityId?: number): Promise<ActivityState> {
    return this.stepTraining(expectedActivityId, "trainingHint", (run) => run.hint());
  }

  trainingExplore(
    input: { kind: ExplorationKind; uci?: string },
    expectedActivityId?: number,
  ): Promise<ActivityState> {
    return this.enqueue("training", async () => {
      this.checkFresh(expectedActivityId);
      if (this.state?.kind !== "training" || !this.run) {
        throw new ActivityError("not_exploring", "no training item is on the board");
      }
      this.run.explore(input.kind, input.uci);
      return this.publish(this.run.state(this.state.activity_id), "trainingExplore");
    });
  }

  // A chat line typed while an item is open belongs to it; the coach session reports each one here.
  linkUserMessage(messageId: number): void {
    this.run?.linkMessage(messageId);
  }

  rateCard(
    exposureId: string,
    quality: number,
    expectedActivityId?: number,
  ): Promise<ActivityState> {
    return this.stepTraining(expectedActivityId, "rateCard", (run) =>
      run.rate(exposureId, quality),
    ).then((state) => {
      this.log.info("srs.rated", {
        activity_id: state.activity_id,
        exposure_id: exposureId,
        quality,
      });
      return state;
    });
  }

  nextTrainingItem(expectedActivityId?: number): Promise<ActivityState> {
    return this.stepTraining(expectedActivityId, "nextTrainingItem", (run) => run.next()).then(
      (state) => this.logServed(state),
    );
  }

  // Back to what was under the queue: the live game if it is still unfinished, else an empty board.
  // A demo shown over a finished item keeps the run, so ending from that demo ends the same run.
  endTraining(expectedActivityId?: number): Promise<ActivityState | null> {
    return this.enqueue("training", async () => {
      if (this.state?.kind === "demo" && this.underneath?.kind === "training") {
        this.checkFresh(expectedActivityId);
        if (!this.run) throw new ActivityError("not_in_training", "no training is on the board");
        this.run.end();
        this.run = null;
        this.demo = null;
        this.underneath = null;
        if (this.game.current()?.finishedAt === null) return this.setLiveGame("endTraining");
        return this.publish(null, "endTraining");
      }
      this.requireTraining(expectedActivityId).end();
      this.run = null;
      if (this.game.current()?.finishedAt === null) return this.setLiveGame("endTraining");
      return this.publish(null, "endTraining");
    });
  }

  /** The practice queue that is open but not on the board, or null. */
  pausedTraining(): PausedTraining | null {
    const row = this.pausedRun();
    if (!row) return null;
    return row.mode === "repertoire" ? RepertoireSession.pausedOf(row) : pausedTrainingOf(row);
  }

  // The student asked for it from the hub, so it replaces whatever the board shows, as a start does.
  resumeTraining(): Promise<ActivityState> {
    return this.enqueue("training", async () => {
      const deps = this.requireTrainingDeps();
      const row = this.requirePausedRun();
      const run =
        row.mode === "repertoire"
          ? RepertoireSession.resume(deps, row)
          : TrainingRun.resume(deps, row);
      this.leaveSideBoards();
      this.run = run;
      return this.logServed(this.publish(run.state(this.nextId++), "resumeTraining"));
    });
  }

  // The board does not change; the state is published again so every tab learns the run is gone.
  discardTraining(): Promise<ActivityState | null> {
    return this.enqueue("training", async () => {
      const deps = this.requireTrainingDeps();
      TrainingRun.discard(deps, this.requirePausedRun().id);
      return this.publish(this.state, "discardTraining");
    });
  }

  private requireTrainingDeps(): TrainingDeps {
    if (!this.trainingDeps) {
      throw new ActivityError("not_in_training", "training is not available");
    }
    return { ...this.trainingDeps, db: this.db };
  }

  private requirePausedRun(): TrainingRunRow {
    const row = this.pausedRun();
    if (!row) throw new ActivityError("no_paused_training", "no practice session is paused");
    return row;
  }

  // An open run is paused unless it is the one on the board. A demo over training keeps
  // the run on the board, so it is not paused while its demo shows.
  private pausedRun(): TrainingRunRow | null {
    const row = findOpenTrainingRun(this.db);
    if (!row) return null;
    const trainingOnBoard =
      this.state?.kind === "training" ||
      (this.state?.kind === "demo" && this.underneath?.kind === "training");
    const onBoard = trainingOnBoard ? (this.run?.runId ?? null) : null;
    return row.id === onBoard ? null : row;
  }

  private stepTraining(
    expectedActivityId: number | undefined,
    cause: string,
    step: (run: PracticeRunPort) => void | Promise<void>,
  ): Promise<ActivityState> {
    return this.enqueue("training", async () => {
      const run = this.requireTraining(expectedActivityId);
      // A step that does not wait publishes in the same turn it changed the run, so no command for
      // another board can come in between. One that waited on the engine finds the board as it is
      // now: if the student left the drill meanwhile, the change stays with the paused run and the
      // board that replaced it is not taken back.
      const pending = step(run);
      if (pending) {
        await pending;
        if (this.run !== run) {
          if (this.state) return this.state;
          throw new ActivityError("not_in_training", "the drill left the board during its step");
        }
      }
      return this.publish(run.state((this.state as ActivityState).activity_id), cause);
    });
  }

  private logServed(state: ActivityState): ActivityState {
    if (state.kind === "training") {
      this.log.info("training.item_served", {
        activity_id: state.activity_id,
        mode: state.mode,
        item: state.item,
      });
    }
    return state;
  }

  private requireTraining(expected: number | undefined): PracticeRunPort {
    this.checkFresh(expected);
    if (this.state?.kind !== "training" || !this.run) {
      throw new ActivityError("not_in_training", "no training is on the board");
    }
    return this.run;
  }

  // Live commands skip the activity chains on purpose: a turn can take seconds and a demo must
  // not wait behind it. GameService serializes the game itself.
  playerMove(
    input: { from: string; to: string; promotion?: PromotionPiece },
    expectedActivityId?: number,
  ): Promise<TurnReport> {
    return this.guardLive(expectedActivityId, () => this.game.playerMove(input));
  }

  undo(expectedActivityId?: number): Promise<GameSnapshot> {
    return this.guardLive(expectedActivityId, () => this.game.undo());
  }

  resign(expectedActivityId?: number): Promise<GameSnapshot> {
    return this.guardLive(expectedActivityId, () => this.game.resign());
  }

  abort(expectedActivityId?: number): Promise<GameSnapshot> {
    return this.guardLive(expectedActivityId, () => this.game.abort());
  }

  private guardLive<T>(expected: number | undefined, run: () => Promise<T>): Promise<T> {
    try {
      this.checkFresh(expected);
      const kind = this.state?.kind;
      if (kind === "demo") {
        throw new ActivityError("demo_active", "only the coach moves pieces in a demo");
      }
      if (kind !== "live_game") {
        throw new ActivityError("not_in_live_game", "there is no live game on the board");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return run();
  }

  private enqueue<T>(key: ActivityKind, task: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(task);
    this.chains.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }

  private checkFresh(expected: number | undefined): void {
    if (expected === undefined || expected === this.state?.activity_id) return;
    throw new ActivityError(
      "stale_activity",
      `the board is on activity ${this.state?.activity_id ?? "none"}, not ${expected}`,
    );
  }

  // The coach's board tools are the only callers of startDemo and startTrainingItem. While the
  // student is playing, the board is theirs: alternatives are walked through after the game, and a
  // finished game still shows as live_game, so the post-game walk-through stays allowed.
  private refuseOverLiveGame(): void {
    if (this.state?.kind !== "live_game") return;
    if (this.game.current()?.finishedAt !== null) return;
    throw new ActivityError(
      "live_game_active",
      "the student is playing; the board stays on the live game until it ends",
    );
  }

  // While the student is still working on a practice item, the board is theirs: a demo may only
  // show the refutation once the item is answered, rated or the queue has ended.
  private refuseOverOpenTrainingItem(): void {
    if (this.state?.kind !== "training") return;
    if (this.state.summary !== null) return;
    if (this.state.status === "prompt" || this.state.status === "in_progress") {
      throw new ActivityError(
        "training_item_open",
        "the student is working on a practice item; the board stays on it until it is answered",
      );
    }
  }

  private requireDemo(expected: number | undefined): DemoBoard {
    this.checkFresh(expected);
    if (this.state?.kind !== "demo" || !this.demo) {
      throw new ActivityError("not_in_demo", "no demo is on the board");
    }
    return this.demo;
  }

  private underneathOf(state: ActivityState | null): Underneath | null {
    if (state?.kind === "live_game") return { kind: "live_game", orientation: state.orientation };
    if (state?.kind === "review") {
      return {
        kind: "review",
        orientation: state.orientation,
        gameId: state.game.id,
        ply: state.selected_ply,
      };
    }
    if (state?.kind === "training") return { kind: "training", orientation: state.orientation };
    return null;
  }

  private publishDemo(activityId: number, cause: string): ActivityState {
    const demo = this.demo as DemoBoard;
    const returnsTo = this.underneath?.kind ?? null;
    const orientation = this.underneath?.orientation ?? "white";
    return this.publish(
      demoState(activityId, demo.chess, [...demo.played], returnsTo, orientation),
      cause,
    );
  }

  private setLiveGame(cause: string): ActivityState {
    const snapshot = this.game.snapshot();
    if (!snapshot) throw new GameError("no_game", "there is no game");
    this.leaveSideBoards();
    return this.publish(liveGameState(this.nextId++, snapshot), cause);
  }

  // `ply` null opens at the final position.
  private setReview(gameId: number, ply: number | null, cause: string): ActivityState {
    const game = getGame(this.db, gameId);
    if (!game) throw new ActivityError("game_not_found", `no game ${gameId}`);
    const moves = listMoves(this.db, gameId);
    this.leaveSideBoards();
    this.review = { game, moves };
    return this.publish(reviewState(this.nextId++, game, moves, ply ?? moves.length), cause);
  }

  // Dropping the run pauses it: its row stays open until it is finished, ended, discarded or replaced.
  private leaveSideBoards(): void {
    this.run = null;
    this.demo = null;
    this.underneath = null;
  }

  private followLiveGame(snapshot: GameSnapshot): void {
    const state = this.state;
    if (state?.kind !== "live_game" || state.game_id !== snapshot.gameId) return;
    this.publish(liveGameState(state.activity_id, snapshot), "followLiveGame");
  }

  private publish<T extends ActivityState | null>(state: T, cause: string): T {
    const from = this.state;
    this.state = state;
    this.log.info("activity.change", { cause, ...transition(from, state) });
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (error) {
        // A broken listener must not stop the board from changing; it is recorded instead.
        this.log.error("activity.listener_failed", error, { cause });
      }
    }
    return state;
  }
}

// What an investigator needs to follow the board: which kind replaced which, and for the kinds
// that carry a position of their own, the position and how it got there.
function transition(from: ActivityState | null, to: ActivityState | null): LogFields {
  const fields: LogFields = {
    from_kind: from?.kind ?? null,
    from_activity_id: from?.activity_id ?? null,
    to_kind: to?.kind ?? null,
    to_activity_id: to?.activity_id ?? null,
  };
  if (to?.kind === "demo") {
    return { ...fields, fen: to.fen, played: to.moves_played, returns_to: to.returns_to };
  }
  if (to?.kind === "live_game") {
    return { ...fields, game_id: to.game_id, phase: to.phase, plies: to.moves.length };
  }
  if (to?.kind === "review") return { ...fields, game_id: to.game.id, ply: to.selected_ply };
  if (to?.kind === "training") {
    return { ...fields, mode: to.mode, item: to.item, status: to.status };
  }
  return fields;
}
