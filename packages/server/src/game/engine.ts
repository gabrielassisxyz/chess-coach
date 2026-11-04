import {
  evaluatePlayerMove,
  type PlayerMoveEvaluation,
  type StudentColor,
} from "../engine/evaluate.js";
import { choosePlayMove, type PlayChoice } from "../engine/play.js";
import type { EnginePool } from "../engine/pool.js";

/** What the game needs from the engines; tests script it instead of speaking UCI. */
export interface GameEngine {
  evaluate(
    fenBefore: string,
    moveUci: string,
    studentColor: StudentColor,
  ): Promise<PlayerMoveEvaluation>;
  play(fen: string, elo: number): Promise<PlayChoice>;
}

export function poolGameEngine(
  pool: Pick<EnginePool, "evaluation" | "play">,
  random: () => number = Math.random,
): GameEngine {
  return {
    evaluate: (fenBefore, moveUci, studentColor) =>
      evaluatePlayerMove(pool.evaluation, fenBefore, moveUci, studentColor),
    play: (fen, elo) => choosePlayMove(pool.play, fen, elo, random),
  };
}
