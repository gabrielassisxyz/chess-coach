import type {
  ActivityKind,
  ActivityState,
  PromotionPiece,
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
import type { ExplorationKind } from "../db/training.js";
import { GameError } from "../game/errors.js";
import type { GameService, TurnReport } from "../game/service.js";
import type { GameSnapshot } from "../game/snapshot.js";
import { ActivityError } from "./errors.js";
import { demoState, liveGameState, reviewState } from "./state.js";
import { type TrainingDeps, TrainingRun } from "./training.js";

export type LiveGamePort = Pick<
  GameService,
  "snapshot" | "current" | "onSnapshot" | "newGame" | "playerMove" | "undo" | "resign" | "abort"
>;

export interface ActivityServiceOptions {
  db: Database;
  game: LiveGamePort;
  /** What a training queue needs besides the database; without it training is unavailable. */
  training?: Omit<TrainingDeps, "db">;
}

type StateListener = (state: ActivityState | null) => void;

// What a demo returns to. A live game is re-read on return because its turn may have completed meanwhile.
type Underneath =
  | { kind: "live_game"; orientation: PlayerColor }
  | { kind: "review"; orientation: PlayerColor; gameId: number; ply: number };

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
  private state: ActivityState | null = null;
  private nextId = 1;
  private demo: DemoBoard | null = null;
  private underneath: Underneath | null = null;
  private review: ReviewData | null = null;
  private run: TrainingRun | null = null;
  private readonly chains = new Map<ActivityKind, Promise<unknown>>();
  private readonly listeners = new Set<StateListener>();

  constructor(options: ActivityServiceOptions) {
    this.db = options.db;
    this.game = options.game;
    this.trainingDeps = options.training ?? null;
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
      return this.publishDemo(this.nextId++);
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
      return this.publishDemo((this.state as ActivityState).activity_id);
    });
  }

  leaveDemo(expectedActivityId?: number): Promise<ActivityState | null> {
    return this.enqueue("demo", async () => {
      this.requireDemo(expectedActivityId);
      const back = this.underneath;
      this.demo = null;
      this.underneath = null;
      if (back?.kind === "live_game") return this.setLiveGame();
      if (back?.kind === "review") return this.setReview(back.gameId, back.ply);
      return this.publish(null);
    });
  }

  openGame(gameId: number): Promise<ActivityState> {
    const live = this.game.current();
    const isLive = live?.id === gameId && live.finishedAt === null;
    return this.enqueue(isLive ? "live_game" : "review", async () => {
      if (isLive) return this.setLiveGame();
      return this.setReview(gameId, null);
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
      return this.publish(reviewState(state.activity_id, game, moves, ply));
    });
  }

  enterLiveGame(): Promise<ActivityState> {
    return this.enqueue("live_game", async () => this.setLiveGame());
  }

  // The new game is entered only after it has settled, so no one sees its half-built first turn.
  newGame(input: { color: PlayerColor; elo?: number; fen?: string }): Promise<ActivityState> {
    return this.enqueue("live_game", async () => {
      await this.game.newGame(input);
      return this.setLiveGame();
    });
  }

  startTraining(input: { mode: TrainingMode; motif?: string }): Promise<ActivityState> {
    return this.enqueue("training", async () => {
      if (!this.trainingDeps) {
        throw new ActivityError("not_in_training", "training is not available");
      }
      const run = TrainingRun.begin({ ...this.trainingDeps, db: this.db }, input);
      this.leaveSideBoards();
      this.run = run;
      return this.publish(run.state(this.nextId++));
    });
  }

  trainingAnswer(uci: string, expectedActivityId?: number): Promise<ActivityState> {
    return this.stepTraining(expectedActivityId, (run) => run.answer(uci));
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
      return this.publish(this.run.state(this.state.activity_id));
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
    return this.stepTraining(expectedActivityId, (run) => run.rate(exposureId, quality));
  }

  nextTrainingItem(expectedActivityId?: number): Promise<ActivityState> {
    return this.stepTraining(expectedActivityId, (run) => run.next());
  }

  // Back to what was under the queue: the live game if it is still unfinished, else an empty board.
  endTraining(expectedActivityId?: number): Promise<ActivityState | null> {
    return this.enqueue("training", async () => {
      this.requireTraining(expectedActivityId);
      this.run = null;
      if (this.game.current()?.finishedAt === null) return this.setLiveGame();
      return this.publish(null);
    });
  }

  private stepTraining(
    expectedActivityId: number | undefined,
    step: (run: TrainingRun) => void,
  ): Promise<ActivityState> {
    return this.enqueue("training", async () => {
      const run = this.requireTraining(expectedActivityId);
      step(run);
      return this.publish(run.state((this.state as ActivityState).activity_id));
    });
  }

  private requireTraining(expected: number | undefined): TrainingRun {
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
    return null;
  }

  private publishDemo(activityId: number): ActivityState {
    const demo = this.demo as DemoBoard;
    const returnsTo = this.underneath?.kind ?? null;
    const orientation = this.underneath?.orientation ?? "white";
    return this.publish(
      demoState(activityId, demo.chess, [...demo.played], returnsTo, orientation),
    );
  }

  private setLiveGame(): ActivityState {
    const snapshot = this.game.snapshot();
    if (!snapshot) throw new GameError("no_game", "there is no game");
    this.leaveSideBoards();
    return this.publish(liveGameState(this.nextId++, snapshot));
  }

  // `ply` null opens at the final position.
  private setReview(gameId: number, ply: number | null): ActivityState {
    const game = getGame(this.db, gameId);
    if (!game) throw new ActivityError("game_not_found", `no game ${gameId}`);
    const moves = listMoves(this.db, gameId);
    this.leaveSideBoards();
    this.review = { game, moves };
    return this.publish(reviewState(this.nextId++, game, moves, ply ?? moves.length));
  }

  private leaveSideBoards(): void {
    this.run = null;
    this.demo = null;
    this.underneath = null;
  }

  private followLiveGame(snapshot: GameSnapshot): void {
    const state = this.state;
    if (state?.kind !== "live_game" || state.game_id !== snapshot.gameId) return;
    this.publish(liveGameState(state.activity_id, snapshot));
  }

  private publish<T extends ActivityState | null>(state: T): T {
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // A broken listener must not stop the board from changing.
      }
    }
    return state;
  }
}
