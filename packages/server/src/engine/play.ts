import { Chess } from "chess.js";
import type { Searcher, UciEngine } from "./uci.js";

export const MIN_ELO = 100;
export const MAX_ELO = 3190;
/** Stockfish refuses UCI_Elo below this, so weaker play is shaped by depth and random moves. */
export const STOCKFISH_ELO_FLOOR = 1320;

export interface PlayChoice {
  moveUci: string;
  source: "engine" | "random";
}

export type PlayEngine = Searcher & Pick<UciEngine, "setOption">;

export function randomMoveProbability(elo: number): number {
  return Math.max(0, 0.85 - (elo / STOCKFISH_ELO_FLOOR) * 0.85);
}

export function searchDepthForElo(elo: number): number {
  return Math.max(1, Math.min(5, Math.floor(elo / 250)));
}

export async function choosePlayMove(
  engine: PlayEngine,
  fen: string,
  elo: number,
  random: () => number,
): Promise<PlayChoice> {
  const target = Math.round(Math.min(MAX_ELO, Math.max(MIN_ELO, elo)));
  if (target >= STOCKFISH_ELO_FLOOR) {
    await engine.setOption("UCI_LimitStrength", "true");
    await engine.setOption("UCI_Elo", String(target));
    return engineMove(engine, { fen, movetime: 1000 });
  }
  await engine.setOption("UCI_LimitStrength", "false");
  if (random() < randomMoveProbability(target)) {
    const legal = new Chess(fen).moves({ verbose: true });
    const pick = legal[Math.min(legal.length - 1, Math.floor(random() * legal.length))];
    if (pick) return { moveUci: pick.lan, source: "random" };
  }
  return engineMove(engine, { fen, depth: searchDepthForElo(target) });
}

async function engineMove(
  engine: Searcher,
  request: { fen: string; depth?: number; movetime?: number },
): Promise<PlayChoice> {
  const { bestmove } = await engine.search(request);
  if (!bestmove) throw new Error("no legal move to play: the position is terminal");
  return { moveUci: bestmove, source: "engine" };
}
