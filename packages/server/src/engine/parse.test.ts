import { describe, expect, it } from "vitest";
import { loadFixture } from "../../test/support/fake-engine-process.js";
import { parseBestmove, parseInfoLine } from "./parse.js";

describe("parseInfoLine", () => {
  it("reads centipawns and the principal variation", () => {
    expect(parseInfoLine("info depth 5 multipv 2 score cp -34 nodes 9 pv e7e5 g1f3")).toEqual({
      multipv: 2,
      score: -34,
      moves: ["e7e5", "g1f3"],
    });
  });

  it("maps mate scores to the sign of the distance times 10000", () => {
    expect(parseInfoLine("info depth 3 score mate 2 pv h5f7")?.score).toBe(10000);
    expect(parseInfoLine("info depth 3 score mate -4 pv a1a2")?.score).toBe(-10000);
  });

  it("reads a mated side to move as lost", () => {
    expect(parseInfoLine("info depth 0 score mate 0")).toEqual({
      multipv: 1,
      score: -10000,
      moves: [],
    });
  });

  it("ignores lines without a usable variation", () => {
    expect(parseInfoLine("info string NNUE evaluation using nn.nnue")).toBeNull();
    expect(parseInfoLine("info depth 9 currmove e2e4 currmovenumber 1")).toBeNull();
    expect(parseInfoLine("info depth 9 score cp 12 lowerbound pv e2e4")).toBeNull();
    expect(parseInfoLine("bestmove e2e4")).toBeNull();
  });

  it("parses every recorded info line", () => {
    for (const name of ["opening", "middlegame", "tactical", "endgame", "mate-in-one"]) {
      for (const lines of loadFixture(name).values()) {
        const infos = lines.filter((line) => line.startsWith("info "));
        expect(infos.length).toBeGreaterThan(0);
        for (const line of infos) expect(parseInfoLine(line)).not.toBeNull();
      }
    }
  });
});

describe("parseBestmove", () => {
  it("returns the move, or null for (none)", () => {
    expect(parseBestmove("bestmove e2e4 ponder e7e5")).toBe("e2e4");
    expect(parseBestmove("bestmove (none)")).toBeNull();
  });
});
