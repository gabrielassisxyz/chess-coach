import { describe, expect, it } from "vitest";
import {
  giveUp,
  solutionLineOf,
  solvedFirstTry,
  startAttempt,
  type TryOutcome,
  tryMove,
} from "./attempt.js";

const MATE_IN_ONE = "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1";
const TWO_MATES = "6k1/5ppp/8/8/8/8/5PPP/RR4K1 w - - 0 1";
const ROOK_LIFT = "4k3/8/8/8/8/8/8/R3K3 w - - 0 1";
const PROMOTION = "8/4P3/8/8/8/8/k7/4K3 w - - 0 1";

function accepted(outcome: TryOutcome) {
  if (!outcome.accepted) throw new Error(`rejected: ${outcome.reason}`);
  return outcome;
}

describe("attempt state machine", () => {
  it("solves a single-move puzzle", () => {
    const out = accepted(tryMove(startAttempt(MATE_IN_ONE, ["a1a8"]), "a1a8"));
    expect(out.correct).toBe(true);
    expect(out.state).toMatchObject({ status: "solved", answered: ["a1a8"], failedPly: null });
    expect(out.reply).toBeNull();
    expect(solvedFirstTry(out.state)).toBe(true);
  });

  it("keeps the cursor and the position on a wrong try, and counts it", () => {
    const start = startAttempt(MATE_IN_ONE, ["a1a8"]);
    const out = accepted(tryMove(start, "a1a2"));
    expect(out.correct).toBe(false);
    expect(out.reply).toBeNull();
    expect(out.state).toMatchObject({
      status: "in_progress",
      cursor: 0,
      fen: MATE_IN_ONE,
      answered: ["a1a2"],
      failedPly: null,
      wrongTries: 1,
    });
  });

  it("solves after a wrong try, but not on the first try", () => {
    const missed = accepted(tryMove(startAttempt(MATE_IN_ONE, ["a1a8"]), "a1a2")).state;
    const out = accepted(tryMove(missed, "a1a8"));
    expect(out.state).toMatchObject({ status: "solved", answered: ["a1a2", "a1a8"] });
    expect(solvedFirstTry(out.state)).toBe(false);
  });

  it("plays the opponent reply on a right try and advances the cursor", () => {
    const start = startAttempt(ROOK_LIFT, ["a1a7", "e8d8", "a7a8"]);
    const first = accepted(tryMove(start, "a1a7"));
    expect(first.reply).toBe("e8d8");
    expect(first.state).toMatchObject({ status: "in_progress", cursor: 2 });
    expect(first.state.fen).toBe("3k4/R7/8/8/8/8/8/4K3 w - - 2 2");
    const second = accepted(tryMove(first.state, "a7a8"));
    expect(second.state).toMatchObject({ status: "solved", answered: ["a1a7", "a7a8"] });
  });

  it("keeps the second step open on a wrong try there", () => {
    const start = startAttempt(ROOK_LIFT, ["a1a7", "e8d8", "a7a8"]);
    const first = accepted(tryMove(start, "a1a7"));
    const second = accepted(tryMove(first.state, "a7b7"));
    expect(second.state).toMatchObject({ status: "in_progress", cursor: 2, wrongTries: 1 });
    expect(second.state.fen).toBe(first.state.fen);
  });

  it("solves a last step with a different move that is checkmate, and keeps the played move", () => {
    const solution = ["a1a8"];
    const out = accepted(tryMove(startAttempt(TWO_MATES, solution), "b1b8"));
    expect(out.correct).toBe(true);
    expect(out.state).toMatchObject({ status: "solved", answered: ["b1b8"], wrongTries: 0 });
    expect(out.state.solution).toEqual(["b1b8"]);
    expect(solution).toEqual(["a1a8"]);
    expect(solvedFirstTry(out.state)).toBe(true);
  });

  it("keeps a last step open on a legal move that is not checkmate", () => {
    const out = accepted(tryMove(startAttempt(TWO_MATES, ["a1a8"]), "a1a7"));
    expect(out.correct).toBe(false);
    expect(out.state).toMatchObject({ status: "in_progress", cursor: 0, wrongTries: 1 });
    expect(out.state.fen).toBe(TWO_MATES);
  });

  it("stays strict on an earlier step even when the move is checkmate", () => {
    const start = startAttempt(TWO_MATES, ["a1a7", "g8f8", "a7a8"]);
    const out = accepted(tryMove(start, "b1b8"));
    expect(out.correct).toBe(false);
    expect(out.state).toMatchObject({ status: "in_progress", cursor: 0, wrongTries: 1 });
  });

  it("gives up at step 0 with the whole line left to show", () => {
    const start = startAttempt(ROOK_LIFT, ["a1a7", "e8d8", "a7a8"]);
    const gaveUp = giveUp(start);
    expect(gaveUp).toMatchObject({ status: "failed", failedPly: 0, cursor: 0 });
    expect(solutionLineOf(gaveUp)).toEqual(["a1a7", "e8d8", "a7a8"]);
    expect(solvedFirstTry(gaveUp)).toBe(false);
  });

  it("gives up mid-way with only the rest of the line to show", () => {
    const start = startAttempt(ROOK_LIFT, ["a1a7", "e8d8", "a7a8"]);
    const first = accepted(tryMove(start, "a1a7"));
    const gaveUp = giveUp(first.state);
    expect(gaveUp).toMatchObject({ status: "failed", failedPly: 2, fen: first.state.fen });
    expect(solutionLineOf(gaveUp)).toEqual(["a7a8"]);
    expect(tryMove(gaveUp, "a7a8")).toMatchObject({ accepted: false, reason: "finished" });
  });

  it("compares promotion exactly", () => {
    const start = startAttempt(PROMOTION, ["e7e8q"]);
    expect(accepted(tryMove(start, "e7e8n")).correct).toBe(false);
    expect(accepted(tryMove(start, "e7e8q")).state.status).toBe("solved");
  });

  it("rejects an illegal try without changing the state", () => {
    const start = startAttempt(PROMOTION, ["e7e8q"]);
    for (const bad of ["e7e8", "e1d1q", "e7e5", "zz"]) {
      const out = tryMove(start, bad);
      expect(out).toEqual({ accepted: false, state: start, reason: "illegal" });
    }
  });

  it("refuses tries once the attempt is over", () => {
    const solved = accepted(tryMove(startAttempt(MATE_IN_ONE, ["a1a8"]), "a1a8")).state;
    expect(tryMove(solved, "e1e2")).toMatchObject({ accepted: false, reason: "finished" });
    expect(giveUp(solved)).toBe(solved);
  });
});
