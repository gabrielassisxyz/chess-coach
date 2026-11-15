import { describe, expect, it } from "vitest";
import type { EnginePool } from "../engine/pool.js";
import type { Searcher, SearchRequest, SearchResult } from "../engine/uci.js";
import { poolGameEngine } from "./engine.js";

const OPENING = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Keeps every request so a test can see what the engine was asked.
class RecordingSearcher implements Searcher {
  readonly requests: SearchRequest[] = [];

  async search(request: SearchRequest): Promise<SearchResult> {
    this.requests.push(request);
    return { fen: request.fen, bestmove: "e2e4", lines: [{ moves: ["e2e4"], score: 30 }] };
  }
}

describe("poolGameEngine", () => {
  // A cap would stop a grade at whatever depth the clock allowed and store a different grade.
  it("grades the student's move with searches that carry no time cap", async () => {
    const evaluation = new RecordingSearcher();
    // Grading never reaches the playing engine, so a bare stand-in is enough for it.
    const play = {} as EnginePool["play"];
    const engine = poolGameEngine({ evaluation, play });

    await engine.evaluate(OPENING, "e2e4", "w");

    expect(evaluation.requests).toHaveLength(2);
    expect(evaluation.requests.every((request) => !("capMs" in request))).toBe(true);
  });
});
