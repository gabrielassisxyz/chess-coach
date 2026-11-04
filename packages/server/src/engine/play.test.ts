import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { choosePlayMove, randomMoveProbability, searchDepthForElo } from "./play.js";
import type { SearchRequest, SearchResult } from "./uci.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

class RecordingEngine {
  readonly options: Array<[string, string]> = [];
  readonly searches: SearchRequest[] = [];

  async setOption(name: string, value: string): Promise<void> {
    this.options.push([name, value]);
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    this.searches.push(request);
    return { fen: request.fen, bestmove: "g1f3", lines: [] };
  }
}

describe("choosePlayMove", () => {
  it("uses UCI_Elo and a one-second search at 1320 and above", async () => {
    const engine = new RecordingEngine();
    const choice = await choosePlayMove(engine, START, 1800, () => 0);
    expect(choice).toEqual({ moveUci: "g1f3", source: "engine" });
    expect(engine.options).toEqual([
      ["UCI_LimitStrength", "true"],
      ["UCI_Elo", "1800"],
    ]);
    expect(engine.searches).toEqual([{ fen: START, movetime: 1000 }]);
  });

  it("clamps the Elo to the supported range", async () => {
    const high = new RecordingEngine();
    await choosePlayMove(high, START, 9000, () => 0);
    expect(high.options).toContainEqual(["UCI_Elo", "3190"]);
    const low = new RecordingEngine();
    await choosePlayMove(low, START, 5, () => 0.99);
    expect(low.searches).toEqual([{ fen: START, depth: 1 }]);
  });

  it("plays a random legal move at Elo 400 when the source returns 0.1", async () => {
    const engine = new RecordingEngine();
    const choice = await choosePlayMove(engine, START, 400, () => 0.1);
    expect(choice.source).toBe("random");
    expect(engine.searches).toEqual([]);
    expect(engine.options).toEqual([["UCI_LimitStrength", "false"]]);
    expect(choice.moveUci).toBe(new Chess(START).moves({ verbose: true })[2]?.lan);
  });

  it("plays the engine's move at Elo 400 when the source returns 0.9", async () => {
    const engine = new RecordingEngine();
    const choice = await choosePlayMove(engine, START, 400, () => 0.9);
    expect(choice).toEqual({ moveUci: "g1f3", source: "engine" });
    expect(engine.searches).toEqual([{ fen: START, depth: 1 }]);
  });
});

describe("strength formulas", () => {
  it("scales the random-move probability down to zero at the Stockfish floor", () => {
    expect(randomMoveProbability(100)).toBeCloseTo(0.7856, 3);
    expect(randomMoveProbability(400)).toBeCloseTo(0.5924, 3);
    expect(randomMoveProbability(1320)).toBe(0);
    expect(randomMoveProbability(1800)).toBe(0);
  });

  it("derives the search depth from the Elo within 1..5", () => {
    expect([100, 250, 600, 1000, 1319].map(searchDepthForElo)).toEqual([1, 1, 2, 4, 5]);
  });
});
