import type { PlayerMoveEvaluation } from "../../src/engine/evaluate.js";
import type { PlayChoice } from "../../src/engine/play.js";
import type { GameEngine } from "../../src/game/engine.js";

const EVALUATION: PlayerMoveEvaluation = {
  evalBeforeCp: 20,
  evalAfterCp: -10,
  cpLoss: 30,
  classification: "great",
  bestMoveUci: "d2d4",
  bestMoveSan: "d4",
};

// Plays the engine's replies from a script; `gate` holds every search until a test releases it.
export class ScriptedEngine implements GameEngine {
  gate: Promise<void> | null = null;
  constructor(private readonly replies: string[]) {}

  async evaluate(): Promise<PlayerMoveEvaluation> {
    await this.gate;
    return EVALUATION;
  }

  async play(): Promise<PlayChoice> {
    await this.gate;
    const moveUci = this.replies.shift();
    if (!moveUci) throw new Error("the scripted engine ran out of replies");
    return { moveUci, source: "engine" };
  }

  hold(): () => void {
    let release = (): void => {};
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.gate = null;
      release();
    };
  }
}
