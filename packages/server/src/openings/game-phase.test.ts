import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { positionPhaseOf } from "./game-phase.js";

// Pieces besides kings and pawns, both sides together, written next to each position.
const START_14 = new Chess().fen();
const TRADED_10 = "r1bq1rk1/pp3ppp/5n2/3p4/3P4/5N2/PP3PPP/R1BQ1RK1 w - - 0 21";
// Four of White's pieces and three of Black's, so a count of one side alone stays under the limit.
const ROOKS_KNIGHTS_BISHOP_7 = "r4rk1/pp3ppp/5n2/3p4/3P4/2B2N2/PP3PPP/R4RK1 w - - 0 30";
const ROOKS_KNIGHTS_6 = "r4rk1/pp3ppp/5n2/3p4/3P4/5N2/PP3PPP/R4RK1 w - - 0 30";
const KINGS_AND_PAWNS_0 = "6k1/pp3ppp/8/3p4/3P4/8/PP3PPP/6K1 w - - 0 40";

describe("positionPhaseOf", () => {
  it.each([2, 12, 30, 31, 41, 90])("calls 6 pieces an endgame at ply %i", (ply) => {
    expect(positionPhaseOf(ROOKS_KNIGHTS_6, ply)).toBe("endgame");
  });

  it("calls a position with only kings and pawns an endgame", () => {
    expect(positionPhaseOf(KINGS_AND_PAWNS_0, 80)).toBe("endgame");
  });

  it("counts both sides' pieces, so 7 is the opening up to ply 30 and the middlegame from 31", () => {
    expect(positionPhaseOf(ROOKS_KNIGHTS_BISHOP_7, 30)).toBe("opening");
    expect(positionPhaseOf(ROOKS_KNIGHTS_BISHOP_7, 31)).toBe("middlegame");
  });

  it("calls 14 pieces at ply 12 the opening and 10 pieces at ply 41 the middlegame", () => {
    expect(positionPhaseOf(START_14, 12)).toBe("opening");
    expect(positionPhaseOf(TRADED_10, 41)).toBe("middlegame");
  });
});
