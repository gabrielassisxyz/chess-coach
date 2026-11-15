import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openFixtureCache, storedSet } from "../../test/support/eval-cache-fixture.js";
import type { StoredSet } from "./eval-cache.js";
import { spawnStockfish } from "./process.js";
import { UciEngine } from "./uci.js";

const SEARCH_DEPTH = 14;

interface RealRecord {
  name: string;
  /** The first four FEN fields of a position with Black to move. */
  epd: string;
  /** The set stored for it in the Lichess evaluation file, copied as the file holds it. */
  set: StoredSet;
}

// Each record was read from the evaluation file itself, which scores from White's side; the engine
// scores from the side to move. Every position has Black to move, where the two disagree in sign,
// so a reader that took the file's number as the mover's would be caught here.
const RECORDS: RealRecord[] = [
  {
    name: "Black mates in one after 1.f3 e5 2.g4, stored as mate -1",
    epd: "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq -",
    set: storedSet(245, [[-1, "d8h4"]], { mate: true }),
  },
  {
    name: "Black is better after 1.e4 e5 2.Nf3 Nc6 3.Nxe5, stored as -230",
    epd: "r1bqkbnr/pppp1ppp/2n5/4N3/4P3/8/PPPP1PPP/RNBQKB1R b KQkq -",
    set: storedSet(40, [
      [-230, "c6e5 d2d4 e5g6 b1c3 f8b4 f1c4"],
      [7, "d8e7 e5c6 e7e4 f1e2 d7c6 e1h1"],
    ]),
  },
  {
    name: "Black is better after 1.e4 e5 2.Ke2, stored as -137",
    epd: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPPKPPP/RNBQ1BNR b kq -",
    set: storedSet(40, [
      [-137, "g8f6 d2d3 d7d5 b1c3 b8c6 c1g5"],
      [-137, "b8c6 d2d3 d7d5 b1d2 g8f6 g1f3"],
    ]),
  },
];

describe.skipIf(process.env.CHESS_COACH_STOCKFISH !== "1")(
  "the evaluation cache's score sign against the real engine",
  () => {
    const engine = new UciEngine(() => spawnStockfish());

    beforeAll(() => engine.start());
    afterAll(() => engine.stop());

    it.each(RECORDS)("agrees with the engine on who is better: $name", async (record) => {
      const { cache } = openFixtureCache([{ epd: record.epd, sets: [record.set] }]);
      const fen = `${record.epd} 0 1`;
      const cached = cache.lookup(fen, { lines: 1, depth: 8 })?.lines[0]?.score;
      const searched = (await engine.search({ fen, depth: SEARCH_DEPTH, multipv: 1 })).lines[0]
        ?.score;
      cache.close();

      // Black is better in all three and is the side to move, so both scores are positive.
      expect(searched).toBeGreaterThan(0);
      expect(cached).toBeGreaterThan(0);
      expect(Math.sign(cached ?? 0)).toBe(Math.sign(searched ?? 0));
    });
  },
);
