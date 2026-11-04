import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Classification, evaluatePlayerMove } from "./evaluate.js";
import { spawnStockfish } from "./process.js";
import { UciEngine } from "./uci.js";

const LATENCY_BUDGET_MS = 2000;

interface Case {
  name: string;
  fen: string;
  move: string;
  allowed: Classification[];
}

const CASES: Case[] = [
  {
    name: "opening",
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    move: "e2e4",
    allowed: ["best", "great"],
  },
  {
    name: "middlegame",
    fen: "r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7",
    move: "h2h3",
    allowed: ["best", "great", "good"],
  },
  {
    name: "tactical",
    fen: "rnb1kbnr/pppp1ppp/8/4p3/4P2q/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
    move: "d2d3",
    allowed: ["blunder"],
  },
  {
    name: "endgame",
    fen: "8/5pk1/6p1/8/5P2/6P1/5K2/3r4 w - - 0 1",
    move: "f2e2",
    allowed: ["best", "great"],
  },
  {
    name: "mate-in-one",
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4",
    move: "h5f7",
    allowed: ["best"],
  },
];

describe.skipIf(process.env.CHESS_COACH_STOCKFISH !== "1")("real Stockfish", () => {
  const engine = new UciEngine(() => spawnStockfish());

  beforeAll(() => engine.start());
  afterAll(() => engine.stop());

  it.each(CASES)("grades the $name position within the latency budget", async (testCase) => {
    const started = performance.now();
    const result = await evaluatePlayerMove(engine, testCase.fen, testCase.move, "w");
    const elapsedMs = Math.round(performance.now() - started);
    console.info(
      `[latency] ${testCase.name}: ${elapsedMs} ms, ${result.classification}, cpLoss ${result.cpLoss}`,
    );
    expect(testCase.allowed).toContain(result.classification);
    expect(elapsedMs).toBeLessThan(LATENCY_BUDGET_MS);
  });
});
