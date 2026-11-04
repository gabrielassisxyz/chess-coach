import { describe, expect, it } from "vitest";
import { type AnswerOutcome, answer, startAttempt } from "./attempt.js";

const MATE_IN_ONE = "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1";
const ROOK_LIFT = "4k3/8/8/8/8/8/8/R3K3 w - - 0 1";
const PROMOTION = "8/4P3/8/8/8/8/k7/4K3 w - - 0 1";

function accepted(outcome: AnswerOutcome) {
  if (!outcome.accepted) throw new Error(`rejected: ${outcome.reason}`);
  return outcome;
}

describe("attempt state machine", () => {
  it("solves a single-move puzzle", () => {
    const out = accepted(answer(startAttempt(MATE_IN_ONE, ["a1a8"]), "a1a8"));
    expect(out.state).toMatchObject({ status: "solved", answered: ["a1a8"], failedPly: null });
    expect(out.reply).toBeNull();
  });

  it("fails a single-move puzzle on a legal wrong move", () => {
    const out = accepted(answer(startAttempt(MATE_IN_ONE, ["a1a8"]), "a1a2"));
    expect(out.state).toMatchObject({ status: "failed", answered: ["a1a2"], failedPly: 0 });
  });

  it("plays the opponent reply and solves a three-ply puzzle", () => {
    const start = startAttempt(ROOK_LIFT, ["a1a7", "e8d8", "a7a8"]);
    const first = accepted(answer(start, "a1a7"));
    expect(first.reply).toBe("e8d8");
    expect(first.state).toMatchObject({ status: "in_progress", cursor: 2 });
    expect(first.state.fen).toBe("3k4/R7/8/8/8/8/8/4K3 w - - 2 2");
    const second = accepted(answer(first.state, "a7a8"));
    expect(second.state).toMatchObject({
      status: "solved",
      answered: ["a1a7", "a7a8"],
    });
  });

  it("fails on the second student move with failed_ply 2", () => {
    const start = startAttempt(ROOK_LIFT, ["a1a7", "e8d8", "a7a8"]);
    const first = accepted(answer(start, "a1a7"));
    const second = accepted(answer(first.state, "a7b7"));
    expect(second.state).toMatchObject({ status: "failed", failedPly: 2 });
    expect(second.state.answered).toEqual(["a1a7", "a7b7"]);
  });

  it("compares promotion exactly", () => {
    const start = startAttempt(PROMOTION, ["e7e8q"]);
    expect(accepted(answer(start, "e7e8n")).state.status).toBe("failed");
    expect(accepted(answer(start, "e7e8q")).state.status).toBe("solved");
  });

  it("rejects an illegal answer without changing the state", () => {
    const start = startAttempt(PROMOTION, ["e7e8q"]);
    for (const bad of ["e7e8", "e1d1q", "e7e5", "zz"]) {
      const out = answer(start, bad);
      expect(out).toEqual({ accepted: false, state: start, reason: "illegal" });
    }
  });

  it("refuses answers once the attempt is over", () => {
    const solved = accepted(answer(startAttempt(MATE_IN_ONE, ["a1a8"]), "a1a8")).state;
    expect(answer(solved, "e1e2")).toMatchObject({ accepted: false, reason: "finished" });
  });
});
