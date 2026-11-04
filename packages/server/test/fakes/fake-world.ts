import { ActivityService } from "../../src/activity/service.js";
import type { CoachWorld } from "../../src/coach/game-tools.js";
import type { Database } from "../../src/db/open.js";
import type { SearchResult } from "../../src/engine/uci.js";
import { GameService } from "../../src/game/service.js";
import { ScriptedEngine } from "./scripted-engine.js";

export interface FakeWorld {
  world: CoachWorld;
  game: GameService;
  activity: ActivityService;
  engine: ScriptedEngine;
  analyzed: string[];
  /** Replace to script what the next `analyze` call resolves or rejects with. */
  answer: { next: () => Promise<SearchResult> };
}

// Real game and activity services over a real database, so error codes are the ones production
// gives; only the engines are scripted.
export function makeWorld(db: Database, replies: string[] = []): FakeWorld {
  const engine = new ScriptedEngine(replies);
  const game = new GameService({ db, engine });
  const activity = new ActivityService({ db, game });
  const analyzed: string[] = [];
  const answer = {
    next: (): Promise<SearchResult> =>
      Promise.resolve({
        fen: "",
        bestmove: "e2e4",
        lines: [
          { moves: ["e2e4", "e7e5", "g1f3"], score: 35 },
          { moves: ["d2d4", "d7d5"], score: 28 },
          { moves: ["c2c4"], score: 20 },
        ],
      }),
  };
  const world: CoachWorld = {
    game,
    activity,
    analyze: (fen) => {
      analyzed.push(fen);
      return answer.next();
    },
  };
  return { world, game, activity, engine, analyzed, answer };
}
