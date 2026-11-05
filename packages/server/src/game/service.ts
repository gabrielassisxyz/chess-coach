import { Chess } from "chess.js";
import { type Clock, systemClock } from "../clock.js";
import {
  completeTurn,
  createGame,
  type Finish,
  findUnfinishedGame,
  finishGame,
  type GameRecord,
  getGame,
  listMoves,
  type MoveRecord,
  type NewMove,
  type PlayerColor,
  recordPlayerMove,
  removeLastPlies,
} from "../db/games.js";
import type { Database } from "../db/open.js";
import { applyStreakAdjustment, getCurrentElo } from "../db/settings.js";
import { EngineFault } from "../engine/errors.js";
import type { PlayerMoveEvaluation } from "../engine/evaluate.js";
import { applyUci } from "../engine/moves.js";
import { MAX_ELO, MIN_ELO } from "../engine/play.js";
import { type Log, silentLog } from "../log.js";
import type { GameEngine } from "./engine.js";
import { GameError } from "./errors.js";
import {
  gameEndContent,
  type NotificationSink,
  turnContent,
  writeNotification,
} from "./notifications.js";
import { buildSnapshot, type GameSnapshot, type Promotion } from "./snapshot.js";

export interface TurnReport {
  playerMove: MoveRecord;
  evaluation: PlayerMoveEvaluation;
  engineReply: MoveRecord | null;
}

export interface GameServiceOptions {
  db: Database;
  engine: GameEngine;
  clock?: Clock;
  /** Absent in tests that do not involve a coach; turns then write no notification rows. */
  notifications?: NotificationSink;
  log?: Log;
}

interface LiveState {
  game: GameRecord;
  moves: MoveRecord[];
  chess: Chess;
}

const START_FEN = new Chess().fen();

/** The moves rows are the truth; replaying them keeps repetition and fifty-move state, a bare FEN would not. */
type ReplayedMove = Pick<MoveRecord, "ply" | "uci" | "fenBefore">;

function replay(game: GameRecord, moves: ReplayedMove[]): Chess {
  const chess = new Chess(game.initialFen);
  for (const move of moves) {
    if (chess.fen() !== move.fenBefore) {
      throw new Error(`game ${game.id} ply ${move.ply} does not follow from the previous one`);
    }
    applyUci(chess, move.uci);
  }
  return chess;
}

// Times one engine call without changing what it resolves to.
async function timed<T>(work: Promise<T>, done: (ms: number) => void): Promise<T> {
  const startedAt = performance.now();
  try {
    return await work;
  } finally {
    done(Math.round(performance.now() - startedAt));
  }
}

function pgnOf(chess: Chess, result: string | null): string {
  if (result) chess.setHeader("Result", result);
  return chess.pgn();
}

function finishOf(chess: Chess, finishedAt: string): Finish | null {
  if (!chess.isGameOver()) return null;
  if (chess.isCheckmate()) {
    return {
      result: chess.turn() === "w" ? "0-1" : "1-0",
      termination: "checkmate",
      finishedAt,
    };
  }
  return {
    result: "1/2-1/2",
    termination: chess.isStalemate() ? "stalemate" : "draw",
    finishedAt,
  };
}

export class GameService {
  private readonly db: Database;
  private readonly engine: GameEngine;
  private readonly clock: Clock;
  private readonly notifications: NotificationSink | undefined;
  private readonly log: Log;
  private state: LiveState | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private turnInFlight = false;
  private readonly snapshotListeners = new Set<(snapshot: GameSnapshot) => void>();
  private readonly turnListeners = new Set<(report: TurnReport) => void>();
  private readonly notificationListeners = new Set<() => void>();
  private readonly faultListeners = new Set<(fault: EngineFault) => void>();

  constructor(options: GameServiceOptions) {
    this.db = options.db;
    this.engine = options.engine;
    this.clock = options.clock ?? systemClock;
    this.notifications = options.notifications;
    this.log = options.log ?? silentLog;
    const unfinished = findUnfinishedGame(this.db);
    if (unfinished) this.state = this.load(unfinished);
  }

  current(): GameRecord | null {
    return this.state?.game ?? null;
  }

  snapshot(): GameSnapshot | null {
    return this.state ? buildSnapshot(this.state.game, this.state.moves, this.state.chess) : null;
  }

  onSnapshot(listener: (snapshot: GameSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  onTurn(listener: (report: TurnReport) => void): () => void {
    this.turnListeners.add(listener);
    return () => this.turnListeners.delete(listener);
  }

  /** Fires after a committed turn or resignation has left notification rows for the coach. */
  onNotification(listener: () => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  /** Fires when an engine fails a turn for good; the game stays in `evaluating` for the next boot. */
  onEngineFault(listener: (fault: EngineFault) => void): () => void {
    this.faultListeners.add(listener);
    return () => this.faultListeners.delete(listener);
  }

  /** Called once at boot: finishes a turn that was cut off after the student's ply was saved. */
  recover(): Promise<void> {
    return this.enqueue(async () => {
      const phase = this.state?.game.phase;
      if (phase === "evaluating" || phase === "engine_turn") {
        this.log.info("game.recovering", { game_id: this.state?.game.id, phase });
        await this.finishTurn();
      }
    });
  }

  newGame(input: { color: PlayerColor; elo?: number; fen?: string }): Promise<GameSnapshot> {
    return this.enqueue(async () => {
      if (this.state && this.state.game.finishedAt === null) {
        throw new GameError("game_in_progress", "a game is already running");
      }
      const elo = input.elo ?? getCurrentElo(this.db);
      if (!Number.isInteger(elo) || elo < MIN_ELO || elo > MAX_ELO) {
        throw new GameError("invalid_elo", `elo must be an integer in ${MIN_ELO}..${MAX_ELO}`);
      }
      const initialFen = this.startFen(input.fen);
      const game = createGame(this.db, {
        playerColor: input.color,
        targetElo: elo,
        initialFen,
        phase: input.color === "white" ? "player_turn" : "engine_turn",
        startedAt: this.clock.now().toISOString(),
      });
      this.state = this.load(game);
      this.log.info("game.new", {
        game_id: game.id,
        color: input.color,
        target_elo: elo,
        initial_fen: initialFen,
      });
      if (game.phase === "engine_turn") await this.finishTurn();
      else this.emitSnapshot();
      return this.requireSnapshot();
    });
  }

  playerMove(input: { from: string; to: string; promotion?: Promotion }): Promise<TurnReport> {
    // Checked before queueing: a second move sent while the first is still being graded is out of turn.
    if (this.turnInFlight) {
      return Promise.reject(new GameError("not_player_turn", "the previous move is still in play"));
    }
    this.turnInFlight = true;
    return this.enqueue(async () => {
      try {
        const live = this.requireUnfinished();
        if (live.game.phase !== "player_turn") {
          throw new GameError(
            "not_player_turn",
            `it is not the player's turn (${live.game.phase})`,
          );
        }
        this.applyPlayerMove(live, input);
        this.emitSnapshot();
        const report = await this.finishTurn();
        if (!report) throw new Error("turn finished without a report");
        return report;
      } finally {
        this.turnInFlight = false;
      }
    });
  }

  undo(): Promise<GameSnapshot> {
    if (this.turnInFlight) {
      return Promise.reject(new GameError("not_player_turn", "a move is still being graded"));
    }
    return this.enqueue(async () => {
      const live = this.requireUnfinished();
      const [beforeEngine, engine] = live.moves.slice(-2);
      if (
        live.game.phase !== "player_turn" ||
        !beforeEngine?.isPlayer ||
        engine?.isPlayer !== false
      ) {
        throw new GameError("nothing_to_undo", "undo needs a player ply followed by an engine ply");
      }
      const kept = live.moves.slice(0, -2);
      const pgn = pgnOf(replay(live.game, kept), null);
      removeLastPlies(this.db, live.game.id, 2, pgn);
      this.log.info("game.undo", {
        game_id: live.game.id,
        removed: [beforeEngine, engine].map((move) => ({ ply: move.ply, san: move.san })),
      });
      this.reload();
      this.emitSnapshot();
      return this.requireSnapshot();
    });
  }

  resign(): Promise<GameSnapshot> {
    return this.enqueue(async () => {
      const { game } = this.requireUnfinished();
      return this.end(
        {
          result: game.playerColor === "white" ? "0-1" : "1-0",
          termination: "resign",
          finishedAt: this.clock.now().toISOString(),
        },
        true,
      );
    });
  }

  abort(): Promise<GameSnapshot> {
    return this.enqueue(async () => {
      this.requireUnfinished();
      return this.end(
        { result: null, termination: "abort", finishedAt: this.clock.now().toISOString() },
        false,
      );
    });
  }

  // A rejected command must not stall the ones queued behind it.
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private startFen(fen: string | undefined): string {
    if (fen === undefined) return START_FEN;
    try {
      const chess = new Chess(fen);
      if (chess.isGameOver()) throw new Error("the position is already over");
      return chess.fen();
    } catch (error) {
      throw new GameError(
        "invalid_position",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private load(game: GameRecord): LiveState {
    const moves = listMoves(this.db, game.id);
    return { game, moves, chess: replay(game, moves) };
  }

  private reload(): LiveState {
    const live = this.requireGame();
    const game = getGame(this.db, live.game.id);
    if (!game) throw new Error("the live game disappeared");
    this.state = this.load(game);
    return this.state;
  }

  private requireGame(): LiveState {
    if (!this.state) throw new GameError("no_game", "there is no game");
    return this.state;
  }

  private requireUnfinished(): LiveState {
    const live = this.requireGame();
    if (live.game.finishedAt !== null) throw new GameError("game_finished", "the game is over");
    return live;
  }

  private requireSnapshot(): GameSnapshot {
    const snapshot = this.snapshot();
    if (!snapshot) throw new GameError("no_game", "there is no game");
    return snapshot;
  }

  private applyPlayerMove(
    live: LiveState,
    input: { from: string; to: string; promotion?: Promotion },
  ): void {
    const next = replay(live.game, live.moves);
    let move: ReturnType<Chess["move"]>;
    try {
      move = next.move(input.promotion ? input : { from: input.from, to: input.to });
    } catch {
      throw new GameError("illegal_move", `${input.from}${input.to} is not legal here`);
    }
    const ply = live.moves.length + 1;
    const record: NewMove = {
      ply,
      san: move.san,
      uci: move.lan,
      fenBefore: move.before,
      fenAfter: move.after,
      isPlayer: true,
      createdAt: this.clock.now().toISOString(),
    };
    const pgn = pgnOf(replay(live.game, [...live.moves, record]), null);
    recordPlayerMove(this.db, live.game.id, record, pgn);
    this.reload();
  }

  /** Step 3 of the turn: grade the student's ply and choose the reply together, then commit both once. */
  private async finishTurn(): Promise<TurnReport | null> {
    const live = this.requireUnfinished();
    const last = live.moves.at(-1);
    const playerPly = last?.isPlayer ? last : undefined;
    const needsReply = !live.chess.isGameOver() && (last === undefined || last.isPlayer);
    const colorLetter = live.game.playerColor === "white" ? "w" : "b";
    let evaluation: PlayerMoveEvaluation | null;
    let choice: Awaited<ReturnType<GameEngine["play"]>> | null;
    const timing = { evaluate: 0, reply: 0 };
    try {
      [evaluation, choice] = await Promise.all([
        playerPly
          ? timed(this.engine.evaluate(playerPly.fenBefore, playerPly.uci, colorLetter), (ms) => {
              timing.evaluate = ms;
            })
          : Promise.resolve(null),
        needsReply
          ? timed(this.engine.play(live.chess.fen(), live.game.targetElo), (ms) => {
              timing.reply = ms;
            })
          : Promise.resolve(null),
      ]);
    } catch (error) {
      if (error instanceof EngineFault) this.emitFault(error, live.game.id);
      throw error;
    }
    // Cloning by FEN would drop the history that repetition and the fifty-move rule read.
    const after = replay(live.game, live.moves);
    let engineMove: NewMove | null = null;
    if (choice) {
      const played = applyUci(after, choice.moveUci);
      engineMove = {
        ply: live.moves.length + 1,
        san: played.san,
        uci: played.lan,
        fenBefore: played.before,
        fenAfter: played.after,
        isPlayer: false,
        createdAt: this.clock.now().toISOString(),
      };
    }
    const finish = finishOf(after, this.clock.now().toISOString());
    const pgn = pgnOf(after, finish?.result ?? null);
    const notify = this.turnNotifier({
      gameId: live.game.id,
      playerColor: live.game.playerColor,
      player: playerPly,
      evaluation,
      engineMove,
      finish,
      fen: after.fen(),
    });
    const hook = this.withDifficulty(notify, live.game.id, finish);
    completeTurn(this.db, {
      gameId: live.game.id,
      evaluation: playerPly && evaluation ? { ply: playerPly.ply, value: evaluation } : null,
      engineMove,
      pgn,
      finish,
      ...(hook ? { notify: hook } : {}),
    });
    const settled = this.reload();
    this.logTurn(live.game.id, playerPly, evaluation, engineMove, finish, timing);
    this.emitSnapshot();
    if (notify) this.emitNotification();
    if (!playerPly || !evaluation) return null;
    const report: TurnReport = {
      playerMove: settled.moves.find((move) => move.ply === playerPly.ply) as MoveRecord,
      evaluation,
      engineReply: engineMove ? (settled.moves.at(-1) ?? null) : null,
    };
    for (const listener of this.turnListeners) this.notify(() => listener(report));
    return report;
  }

  private end(finish: Finish, announce: boolean): GameSnapshot {
    const live = this.requireUnfinished();
    const sessionId = announce ? this.notifications?.sessionId() : undefined;
    const notify =
      sessionId === undefined
        ? undefined
        : (db: Database): void =>
            writeNotification(
              db,
              sessionId,
              gameEndContent(db, {
                gameId: live.game.id,
                finish,
                playerColor: live.game.playerColor,
                fen: live.chess.fen(),
                clock: this.clock,
              }),
              this.clock,
            );
    finishGame(
      this.db,
      live.game.id,
      finish,
      pgnOf(replay(live.game, live.moves), finish.result),
      this.withDifficulty(notify, live.game.id, finish),
    );
    this.log.info("game.finished", {
      game_id: live.game.id,
      result: finish.result,
      termination: finish.termination,
    });
    this.reload();
    this.emitSnapshot();
    if (notify) this.emitNotification();
    return this.requireSnapshot();
  }

  // The level moves in the finish transaction so a game and its effect on the level cannot disagree.
  private withDifficulty(
    notify: ((db: Database) => void) | undefined,
    gameId: number,
    finish: Finish | null,
  ): ((db: Database) => void) | undefined {
    if (!finish || finish.termination === "abort") return notify;
    return (db) => {
      notify?.(db);
      const change = applyStreakAdjustment(db, gameId, this.clock);
      if (!change || !this.notifications) return;
      writeNotification(
        db,
        this.notifications.sessionId(),
        {
          type: "difficulty_change",
          from_elo: change.from_elo,
          to_elo: change.to_elo,
          reason: change.reason,
          game_id: gameId,
        },
        this.clock,
      );
    };
  }

  // The rows are written by the turn's own transaction: a failed write must undo the turn, never leave it unannounced.
  private turnNotifier(input: {
    gameId: number;
    playerColor: PlayerColor;
    player: MoveRecord | undefined;
    evaluation: PlayerMoveEvaluation | null;
    engineMove: NewMove | null;
    finish: Finish | null;
    fen: string;
  }): ((db: Database) => void) | undefined {
    const graded = input.player?.isPlayer && input.evaluation ? input.player : undefined;
    if (!this.notifications || !(graded || input.finish)) return undefined;
    const sessionId = this.notifications.sessionId();
    return (db) => {
      if (graded && input.evaluation) {
        const content = turnContent({
          gameId: input.gameId,
          player: graded,
          evaluation: input.evaluation,
          engineReply: input.engineMove,
          fen: input.fen,
        });
        writeNotification(db, sessionId, content, this.clock);
      }
      if (input.finish) {
        const content = gameEndContent(db, {
          gameId: input.gameId,
          finish: input.finish,
          playerColor: input.playerColor,
          fen: input.fen,
          clock: this.clock,
        });
        writeNotification(db, sessionId, content, this.clock);
      }
    };
  }

  private emitNotification(): void {
    for (const listener of this.notificationListeners) this.notify(listener);
  }

  private emitFault(fault: EngineFault, gameId: number): void {
    this.log.error("engine.fault", fault, { game_id: gameId, reason: fault.reason });
    for (const listener of this.faultListeners) this.notify(() => listener(fault));
  }

  private logTurn(
    gameId: number,
    player: MoveRecord | undefined,
    evaluation: PlayerMoveEvaluation | null,
    engineMove: NewMove | null,
    finish: Finish | null,
    timing: { evaluate: number; reply: number },
  ): void {
    if (player && evaluation) {
      this.log.info("game.player_move", {
        game_id: gameId,
        ply: player.ply,
        san: player.san,
        uci: player.uci,
        cp_loss: evaluation.cpLoss,
        classification: evaluation.classification,
        best_san: evaluation.bestMoveSan,
        eval_before_cp: evaluation.evalBeforeCp,
        eval_after_cp: evaluation.evalAfterCp,
        duration_ms: timing.evaluate,
      });
    }
    if (engineMove) {
      this.log.info("game.engine_move", {
        game_id: gameId,
        ply: engineMove.ply,
        san: engineMove.san,
        uci: engineMove.uci,
        duration_ms: timing.reply,
      });
    }
    if (finish) {
      this.log.info("game.finished", {
        game_id: gameId,
        result: finish.result,
        termination: finish.termination,
      });
    }
  }

  private emitSnapshot(): void {
    const snapshot = this.snapshot();
    if (!snapshot) return;
    for (const listener of this.snapshotListeners) this.notify(() => listener(snapshot));
  }

  // A listener that throws must not abort a turn whose rows are already committed.
  private notify(call: () => void): void {
    try {
      call();
    } catch (error) {
      // The turn is already durable, so the failure is recorded and the turn goes on.
      this.log.error("game.listener_failed", error);
    }
  }
}
