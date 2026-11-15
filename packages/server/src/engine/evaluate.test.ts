import { describe, expect, it } from "vitest";
import {
  FakeEngineProcess,
  loadFixture,
  replayFixture,
} from "../../test/support/fake-engine-process.js";
import { classifyCpLoss, evaluatePlayerMove } from "./evaluate.js";
import { type Searcher, type SearchRequest, type SearchResult, UciEngine } from "./uci.js";

/** Answers every search with one scored line and keeps the requests it was sent. */
class RecordingSearcher implements Searcher {
  readonly requests: SearchRequest[] = [];

  async search(request: SearchRequest): Promise<SearchResult> {
    this.requests.push(request);
    return { fen: request.fen, bestmove: "e2e4", lines: [{ moves: ["e2e4"], score: 30 }] };
  }
}

async function recordedEngine(fixtureName: string): Promise<UciEngine> {
  const behavior = replayFixture(loadFixture(fixtureName));
  const engine = new UciEngine(() => new FakeEngineProcess(behavior), { searchSlackMs: 200 });
  await engine.start();
  return engine;
}

const MIDDLEGAME = "r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7";
const TACTICAL = "rnb1kbnr/pppp1ppp/8/4p3/4P2q/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3";
const ENDGAME = "8/5pk1/6p1/8/5P2/6P1/5K2/3r4 w - - 0 1";
const MATE_IN_ONE = "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4";
const OPENING = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("evaluatePlayerMove", () => {
  it("grades a quiet move as a small loss and reports the engine's best move", async () => {
    const engine = await recordedEngine("middlegame");
    const result = await evaluatePlayerMove(engine, MIDDLEGAME, "h2h3", "w");
    expect(result).toEqual({
      evalBeforeCp: 14,
      evalAfterCp: -2,
      cpLoss: 16,
      classification: "great",
      bestMoveUci: "c3a4",
      bestMoveSan: "Na4",
    });
  });

  it("puts the post-move score in the student's view by negating it", async () => {
    const engine = await recordedEngine("opening");
    const result = await evaluatePlayerMove(engine, OPENING, "e2e4", "w");
    expect(result.evalBeforeCp).toBe(39);
    // Black to move reports -32 after e4, which is +32 for the student who played it.
    expect(result.evalAfterCp).toBe(32);
    expect(result.cpLoss).toBe(7);
  });

  it("grades a missed winning shot as a blunder", async () => {
    const engine = await recordedEngine("tactical");
    const result = await evaluatePlayerMove(engine, TACTICAL, "d2d3", "w");
    expect(result.evalBeforeCp).toBe(907);
    expect(result.evalAfterCp).toBe(101);
    expect(result.classification).toBe("blunder");
    expect(result.bestMoveSan).toBe("Nxh4");
  });

  it("grades the engine's own move as best", async () => {
    const engine = await recordedEngine("tactical");
    const result = await evaluatePlayerMove(engine, TACTICAL, "f3h4", "w");
    expect(result.bestMoveUci).toBe("f3h4");
    expect(result.cpLoss).toBeLessThanOrEqual(60);
  });

  it("treats delivering mate as a score of +10000 and no loss", async () => {
    const engine = await recordedEngine("mate-in-one");
    const result = await evaluatePlayerMove(engine, MATE_IN_ONE, "h5f7", "w");
    expect(result).toMatchObject({
      evalBeforeCp: 10000,
      evalAfterCp: 10000,
      cpLoss: 0,
      classification: "best",
      bestMoveSan: "Qxf7#",
    });
  });

  it("grades a missed mate in one as a blunder", async () => {
    const engine = await recordedEngine("mate-in-one");
    const result = await evaluatePlayerMove(engine, MATE_IN_ONE, "h5h4", "w");
    expect(result.evalBeforeCp).toBe(10000);
    expect(result.evalAfterCp).toBeLessThan(0);
    expect(result.classification).toBe("blunder");
  });

  it("clamps a negative loss to zero when the move rates higher than the position before it", async () => {
    const engine = await recordedEngine("endgame");
    const result = await evaluatePlayerMove(engine, ENDGAME, "f2e2", "w");
    expect(result.evalBeforeCp).toBe(-692);
    expect(result.evalAfterCp).toBe(-669);
    expect(result.cpLoss).toBe(0);
    expect(result.classification).toBe("best");
  });

  it("sends neither of its two searches with a time cap", async () => {
    // A live game cannot wait the 30 s a batch of opening searches can. Without a cap a slow search
    // fails once it is past the engine's slack, rather than holding the grade for up to 30 s.
    const engine = new RecordingSearcher();
    await evaluatePlayerMove(engine, OPENING, "e2e4", "w");
    expect(engine.requests).toHaveLength(2);
    expect(engine.requests.map((request) => request.capMs)).toEqual([undefined, undefined]);
    expect(engine.requests.every((request) => !("capMs" in request))).toBe(true);
  });

  it("sends both searches with the time cap when one is given", async () => {
    const engine = new RecordingSearcher();
    await evaluatePlayerMove(engine, OPENING, "e2e4", "w", 2000);
    expect(engine.requests).toHaveLength(2);
    expect(engine.requests.map((request) => request.capMs)).toEqual([2000, 2000]);
  });
});

describe("classifyCpLoss", () => {
  it.each([
    [0, "best"],
    [1, "great"],
    [30, "great"],
    [31, "good"],
    [80, "good"],
    [81, "inaccuracy"],
    [150, "inaccuracy"],
    [151, "mistake"],
    [300, "mistake"],
    [301, "blunder"],
  ] as const)("cp loss %i is %s", (loss, expected) => {
    expect(classifyCpLoss(loss)).toBe(expected);
  });
});
