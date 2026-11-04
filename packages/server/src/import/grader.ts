import {
  findGameToGrade,
  type GameRecord,
  gradingProgress,
  listMoves,
  recordMoveEvaluation,
  setGrading,
} from "../db/games.js";
import type { Database } from "../db/open.js";
import type { PlayerMoveEvaluation, StudentColor } from "../engine/evaluate.js";

export type EvaluateMove = (
  fenBefore: string,
  moveUci: string,
  studentColor: StudentColor,
) => Promise<PlayerMoveEvaluation>;

export interface GraderOptions {
  db: Database;
  evaluate: EvaluateMove;
  log?: (message: string) => void;
  /** Runs once after each game finishes grading; a failure is logged and never fails the game. */
  onGraded?: () => Promise<unknown>;
}

/**
 * Grades imported games one at a time, in the background. The queue lives in the grading column,
 * so a restart picks up where it stopped: plies that already carry a loss are not searched again.
 */
export class ImportGrader {
  private readonly db: Database;
  private readonly evaluate: EvaluateMove;
  private readonly log: (message: string) => void;
  private readonly onGraded: (() => Promise<unknown>) | undefined;
  private working: Promise<void> | null = null;

  constructor(options: GraderOptions) {
    this.db = options.db;
    this.evaluate = options.evaluate;
    this.log = options.log ?? ((message) => console.error(message));
    this.onGraded = options.onGraded;
  }

  /** Starts the worker when it is idle; calling it while it runs is harmless. */
  kick(): void {
    if (this.working) return;
    this.working = this.drain().finally(() => {
      this.working = null;
    });
  }

  /** Resolves once the queue is empty; tests and shutdown wait on it. */
  async idle(): Promise<void> {
    while (this.working) await this.working;
  }

  progress() {
    return gradingProgress(this.db);
  }

  private async drain(): Promise<void> {
    for (let game = findGameToGrade(this.db); game; game = findGameToGrade(this.db)) {
      await this.grade(game);
    }
  }

  private async grade(game: GameRecord): Promise<void> {
    setGrading(this.db, game.id, "running");
    const color: StudentColor = game.playerColor === "white" ? "w" : "b";
    try {
      for (const move of listMoves(this.db, game.id)) {
        if (!move.isPlayer || move.cpLoss !== null) continue;
        const value = await this.evaluate(move.fenBefore, move.uci, color);
        recordMoveEvaluation(this.db, move.id, value);
      }
      setGrading(this.db, game.id, "done");
    } catch (error) {
      setGrading(this.db, game.id, "failed");
      this.log(`grading game ${game.id} failed: ${error instanceof Error ? error.message : error}`);
      return;
    }
    await this.afterGraded(game.id);
  }

  private async afterGraded(gameId: number): Promise<void> {
    try {
      await this.onGraded?.();
    } catch (error) {
      this.log(`after grading game ${gameId}: ${error instanceof Error ? error.message : error}`);
    }
  }
}
