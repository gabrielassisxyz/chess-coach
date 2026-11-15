import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeValue,
  type FixtureRow,
  openFixtureCache,
  storedSet,
} from "../../test/support/eval-cache-fixture.js";
import { RecordingLog } from "../log.js";
import {
  chooseSet,
  decodeValue,
  type EvalCache,
  openEvalCache,
  packKey,
  type StoredSet,
  UnrepresentablePosition,
} from "./eval-cache.js";

const REPOSITORY_ROOT = join(import.meta.dirname, "../../../..");

interface GoldenCase {
  name: string;
  input: {
    fen: string;
    evals: Array<{
      depth: number;
      knodes: number;
      pvs: Array<{ cp?: number; mate?: number; line: string }>;
    }>;
  };
  key: string;
  depth: number;
  value: string;
}

// Written by the Python builder, so what the reader here must reproduce is what that one wrote.
const GOLDEN = JSON.parse(
  readFileSync(join(REPOSITORY_ROOT, "tools/testdata/eval_cache_golden.json"), "utf8"),
) as GoldenCase[];

// The sets the builder keeps from a source line: the deepest evaluation, then the deepest of those
// with the most lines when it has more, the first in the file winning a tie on depth.
function setsKeptFrom(input: GoldenCase["input"]): StoredSet[] {
  const firstDeepest = (items: GoldenCase["input"]["evals"]) =>
    items.reduce((best, item) => (item.depth > best.depth ? item : best));
  const deepest = firstDeepest(input.evals);
  const most = Math.max(...input.evals.map((item) => item.pvs.length));
  const kept =
    most <= deepest.pvs.length
      ? [deepest]
      : [deepest, firstDeepest(input.evals.filter((item) => item.pvs.length === most))];
  return kept.map((item) => ({
    depth: item.depth,
    knodes: Math.min(item.knodes, 2 ** 32 - 1),
    lines: item.pvs.map((pv) => ({
      mate: pv.mate !== undefined,
      score: Math.max(-32768, Math.min(32767, pv.mate ?? pv.cp ?? 0)),
      moves: pv.line.split(" ").filter((move) => move !== ""),
    })),
  }));
}

describe("the golden fixture", () => {
  it.each(GOLDEN)("is decoded and keyed as the builder wrote it: $name", (golden) => {
    expect(packKey(golden.input.fen).toString("hex")).toBe(golden.key);
    const sets = decodeValue(Buffer.from(golden.value, "hex"));
    expect(sets).toEqual(setsKeptFrom(golden.input));
    expect(sets[0]?.depth).toBe(golden.depth);
  });

  it.each(GOLDEN)("is encoded by the test fixtures as the builder wrote it: $name", (golden) => {
    expect(encodeValue(setsKeptFrom(golden.input)).toString("hex")).toBe(golden.value);
  });
});

describe("packKey", () => {
  it.each([
    ["a letter that is not a castling right", "4k3/8/8/8/8/8/8/4K3 w A -"],
    ["castling rights out of order", "4k3/8/8/8/8/8/8/4K3 w QK -"],
    ["a repeated castling right", "4k3/8/8/8/8/8/8/4K3 w KK -"],
    ["an en passant square on the wrong rank", "4k3/8/8/8/8/8/8/4K3 w - e4"],
    ["an en passant square on White's rank with Black to move", "4k3/8/8/8/8/8/8/4K3 b - e6"],
    ["a side to move that is not w or b", "4k3/8/8/8/8/8/8/4K3 x - -"],
    ["three fields", "4k3/8/8/8/8/8/8/4K3 w -"],
    ["seven ranks", "4k3/8/8/8/8/8/8 w - -"],
    ["a rank of nine squares", "4k4/8/8/8/8/8/8/4K3 w - -"],
    ["a letter that is no piece", "4k3/8/8/8/8/8/8/4X3 w - -"],
    ["two digits in a row", "4k3/8/8/8/8/8/8/31K3 w - -"],
  ])("refuses %s", (_name, epd) => {
    expect(() => packKey(epd)).toThrow(UnrepresentablePosition);
  });
});

describe("chooseSet", () => {
  // The golden case where the deepest evaluation has fewer lines than a shallower one.
  const sets = [
    storedSet(35, [[25, "d5c6 b8c6"]]),
    storedSet(28, [
      [22, "d5d6"],
      [18, "g1f3"],
      [5, "e2e4"],
    ]),
  ];

  it("takes the deepest set that has the lines and the depth asked for", () => {
    expect(chooseSet(sets, { lines: 1, depth: 18 })?.depth).toBe(35);
    expect(chooseSet(sets, { lines: 3, depth: 18 })?.depth).toBe(28);
  });

  it("does not let a set with fewer lines than asked answer, however deep", () => {
    expect(chooseSet(sets, { lines: 4, depth: 8 })).toBeNull();
  });

  it("does not let a set shallower than asked answer, however many lines", () => {
    expect(chooseSet(sets, { lines: 3, depth: 29 })).toBeNull();
    expect(chooseSet(sets, { lines: 1, depth: 36 })).toBeNull();
  });
});

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";
const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -";
const FOOLS_MATE = "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq -";
const BOTH_ROOKS_HOME = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq -";
const ROOK_ON_E1 = "3k4/8/8/8/8/8/8/K3R3 w - -";
const ROOK_ON_E8 = "4r2k/8/8/8/8/8/8/K7 b - -";
const BLACK_TO_CASTLE = "r3k2r/8/8/8/8/8/8/4K3 b kq -";

const opened: EvalCache[] = [];
afterEach(() => {
  for (const cache of opened.splice(0)) cache.close();
});

function cacheOf(rows: FixtureRow[]) {
  const fixture = openFixtureCache(rows);
  opened.push(fixture.cache);
  return fixture;
}

const fullFen = (epd: string): string => `${epd} 0 1`;

describe("a lookup", () => {
  const threeLinesAtThirty = storedSet(30, [
    [19, "e2e4 e7e5"],
    [15, "d2d4 g8f6"],
    [14, "g1f3 d7d5"],
  ]);

  it("answers 2 lines at depth 20 from a set of 3 lines at depth 30, at the depth it holds", () => {
    const { cache } = cacheOf([{ epd: START, sets: [threeLinesAtThirty] }]);
    expect(cache.lookup(fullFen(START), { lines: 2, depth: 20 })).toEqual({
      depth: 30,
      lines: [
        { moves: ["e2e4", "e7e5"], score: 19 },
        { moves: ["d2d4", "g8f6"], score: 15 },
      ],
    });
  });

  it("misses when the set is shallower than the depth asked for", () => {
    const { cache, log } = cacheOf([{ epd: START, sets: [threeLinesAtThirty] }]);
    expect(cache.lookup(fullFen(START), { lines: 1, depth: 31 })).toBeNull();
    expect(log.named("eval_cache.miss")[0]?.fields).toMatchObject({
      reason: "insufficient",
      stored: [{ depth: 30, lines: 3 }],
    });
  });

  it("does not let a row of one line satisfy a request for three", () => {
    const { cache } = cacheOf([{ epd: START, sets: [storedSet(60, [[19, "e2e4"]])] }]);
    expect(cache.lookup(fullFen(START), { lines: 3, depth: 18 })).toBeNull();
    expect(cache.lookup(fullFen(START), { lines: 1, depth: 18 })?.depth).toBe(60);
  });

  it("goes to the second set when the deepest one has too few lines", () => {
    const { cache } = cacheOf([
      {
        epd: START,
        sets: [storedSet(70, [[19, "e2e4"]]), threeLinesAtThirty],
      },
    ]);
    const hit = cache.lookup(fullFen(START), { lines: 3, depth: 18 });
    expect(hit?.depth).toBe(30);
    expect(hit?.lines).toHaveLength(3);
  });

  it("misses a position the file does not hold", () => {
    const { cache, log } = cacheOf([{ epd: START, sets: [threeLinesAtThirty] }]);
    expect(cache.lookup(fullFen(AFTER_E4), { lines: 1, depth: 18 })).toBeNull();
    expect(log.named("eval_cache.miss")[0]?.fields).toMatchObject({ reason: "not_stored" });
  });

  it("keys the position by its first four fields, so clocks never matter", () => {
    const { cache } = cacheOf([{ epd: START, sets: [threeLinesAtThirty] }]);
    const want = { lines: 1, depth: 18 };
    const early = cache.lookup(`${START} 0 1`, want);
    expect(early).not.toBeNull();
    expect(cache.lookup(`${START} 17 40`, want)).toEqual(early);
  });

  it("drops an en passant square that nothing can capture on, as the file does", () => {
    const { cache } = cacheOf([{ epd: AFTER_E4, sets: [storedSet(40, [[-20, "e7e5"]])] }]);
    const afterE4WithSquare = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
    expect(cache.lookup(afterE4WithSquare, { lines: 1, depth: 18 })?.depth).toBe(40);
  });

  it("keeps an en passant square that can be captured on", () => {
    const capturable = "rnbqkbnr/ppp1pppp/8/8/3pP3/5N2/PPPP1PPP/RNBQKB1R b KQkq e3";
    const { cache } = cacheOf([{ epd: capturable, sets: [storedSet(40, [[-20, "d4e3"]])] }]);
    expect(cache.lookup(fullFen(capturable), { lines: 1, depth: 18 })?.lines[0]?.moves).toEqual([
      "d4e3",
    ]);
  });
});

describe("a stored score", () => {
  const scoreOf = (cache: EvalCache, epd: string): number | undefined =>
    cache.lookup(fullFen(epd), { lines: 1, depth: 18 })?.lines[0]?.score;

  it("is White's, so the side to move sees it negated when that side is Black", () => {
    const { cache } = cacheOf([
      { epd: START, sets: [storedSet(30, [[19, "e2e4"]])] },
      { epd: AFTER_E4, sets: [storedSet(30, [[18, "e7e5"]])] },
    ]);
    expect(scoreOf(cache, START)).toBe(19);
    expect(scoreOf(cache, AFTER_E4)).toBe(-18);
  });

  it("reads a mate for White as a win for the side to move only when that side is White", () => {
    const { cache } = cacheOf([
      { epd: START, sets: [storedSet(30, [[3, "e2e4"]], { mate: true })] },
      { epd: AFTER_E4, sets: [storedSet(30, [[3, "e7e5"]], { mate: true })] },
    ]);
    expect(scoreOf(cache, START)).toBe(10000);
    expect(scoreOf(cache, AFTER_E4)).toBe(-10000);
  });

  it("reads a mate for Black, stored as a negative number, as a win for Black to move", () => {
    const { cache } = cacheOf([
      { epd: FOOLS_MATE, sets: [storedSet(245, [[-1, "d8h4"]], { mate: true })] },
    ]);
    expect(scoreOf(cache, FOOLS_MATE)).toBe(10000);
  });

  it("reads a mate in zero as a loss for the side to move, whichever it is", () => {
    const { cache } = cacheOf([
      { epd: START, sets: [storedSet(30, [[0, ""]], { mate: true })] },
      { epd: AFTER_E4, sets: [storedSet(30, [[0, ""]], { mate: true })] },
    ]);
    expect(scoreOf(cache, START)).toBe(-10000);
    expect(scoreOf(cache, AFTER_E4)).toBe(-10000);
  });
});

describe("a stored line", () => {
  const movesOf = (cache: EvalCache, epd: string): string[] | undefined =>
    cache.lookup(fullFen(epd), { lines: 1, depth: 18 })?.lines[0]?.moves;

  it("turns a king taking its rook, written e1h1, into castling when a king stands on e1", () => {
    const { cache } = cacheOf([
      { epd: BOTH_ROOKS_HOME, sets: [storedSet(30, [[12, "e1h1 e8a8"]])] },
    ]);
    expect(movesOf(cache, BOTH_ROOKS_HOME)).toEqual(["e1g1", "e8c8"]);
  });

  it("turns the other three castling texts the same way", () => {
    const { cache } = cacheOf([
      { epd: BOTH_ROOKS_HOME, sets: [storedSet(30, [[12, "e1a1 e8h8"]])] },
      { epd: BLACK_TO_CASTLE, sets: [storedSet(30, [[-5, "e8a8"]])] },
    ]);
    expect(movesOf(cache, BOTH_ROOKS_HOME)).toEqual(["e1c1", "e8g8"]);
    expect(movesOf(cache, BLACK_TO_CASTLE)).toEqual(["e8c8"]);
  });

  it("leaves the same text a rook's move when a rook stands on e1 or e8", () => {
    const { cache } = cacheOf([
      { epd: ROOK_ON_E1, sets: [storedSet(30, [[300, "e1h1"]])] },
      { epd: ROOK_ON_E8, sets: [storedSet(30, [[-300, "e8a8"]])] },
    ]);
    expect(movesOf(cache, ROOK_ON_E1)).toEqual(["e1h1"]);
    expect(movesOf(cache, ROOK_ON_E8)).toEqual(["e8a8"]);
  });

  it("stops at the first move the position does not allow", () => {
    const { cache } = cacheOf([
      { epd: START, sets: [storedSet(30, [[19, "e2e4 e7e5 e4e5 d7d5"]])] },
    ]);
    expect(movesOf(cache, START)).toEqual(["e2e4", "e7e5"]);
  });

  it("keeps the score of a line none of whose moves replays, with no moves", () => {
    const { cache } = cacheOf([{ epd: START, sets: [storedSet(30, [[19, "e7e5"]])] }]);
    expect(cache.lookup(fullFen(START), { lines: 1, depth: 18 })).toEqual({
      depth: 30,
      lines: [{ moves: [], score: 19 }],
    });
  });

  it("replays a line of the real file that ends in castling", () => {
    // From the Lichess evaluation file: 1.e4 e5 2.Nf3 Nc6 3.Nxe5, then ...Qe7 4.Nxc6 Qxe4+ 5.Be2
    // dxc6 6.O-O, which the file writes as e1h1.
    const afterNxe5 = "r1bqkbnr/pppp1ppp/2n5/4N3/4P3/8/PPPP1PPP/RNBQKB1R b KQkq -";
    const { cache } = cacheOf([
      { epd: afterNxe5, sets: [storedSet(40, [[7, "d8e7 e5c6 e7e4 f1e2 d7c6 e1h1"]])] },
    ]);
    expect(movesOf(cache, afterNxe5)).toEqual(["d8e7", "e5c6", "e7e4", "f1e2", "d7c6", "e1g1"]);
  });

  it("keeps a promotion's piece", () => {
    const promoting = "8/P1k5/8/8/8/8/5K2/8 w - -";
    const { cache } = cacheOf([
      { epd: promoting, sets: [storedSet(25, [[900, "a7a8q c7b6 a8a1"]])] },
    ]);
    expect(movesOf(cache, promoting)).toEqual(["a7a8q", "c7b6", "a8a1"]);
  });
});

describe("the events of a lookup", () => {
  it("logs a hit with what was asked for and what answered", () => {
    const { cache, log } = cacheOf([
      {
        epd: START,
        sets: [
          storedSet(30, [
            [19, "e2e4"],
            [15, "d2d4"],
            [14, "g1f3"],
          ]),
        ],
      },
    ]);
    cache.lookup(fullFen(START), { lines: 2, depth: 20 });
    expect(log.names()).toEqual(["eval_cache.hit"]);
    expect(log.events[0]).toMatchObject({
      level: "info",
      fields: { fen: fullFen(START), lines: 2, depth: 20, stored_depth: 30, stored_lines: 3 },
    });
    expect(typeof log.events[0]?.fields.duration_ms).toBe("number");
  });

  it("logs a miss with its reason", () => {
    const { cache, log } = cacheOf([]);
    cache.lookup(fullFen(START), { lines: 3, depth: 18 });
    expect(log.names()).toEqual(["eval_cache.miss"]);
    expect(log.events[0]?.fields).toMatchObject({
      fen: fullFen(START),
      lines: 3,
      depth: 18,
      reason: "not_stored",
    });
  });

  it("answers a damaged row with a miss and a failure in the log, never an error", () => {
    const { cache, log } = cacheOf([
      { epd: START, sets: [], value: Buffer.from([1, 1, 30]) },
      { epd: AFTER_E4, sets: [], value: Buffer.from([9, 1]) },
    ]);
    expect(cache.lookup(fullFen(START), { lines: 1, depth: 18 })).toBeNull();
    expect(cache.lookup(fullFen(AFTER_E4), { lines: 1, depth: 18 })).toBeNull();
    expect(log.names()).toEqual(["eval_cache.failed", "eval_cache.failed"]);
    expect(log.events[0]).toMatchObject({ level: "error", fields: { fen: fullFen(START) } });
  });

  it("answers a position that is not one with a miss and a failure in the log", () => {
    const { cache, log } = cacheOf([]);
    expect(cache.lookup("not a position", { lines: 1, depth: 18 })).toBeNull();
    expect(log.names()).toEqual(["eval_cache.failed"]);
  });
});

describe("a cache that is not there", () => {
  const scratchFile = (name: string, content: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), "eval-cache-bad-")), name);
    writeFileSync(path, content);
    return path;
  };

  it("with the setting unset logs one eval_cache.unavailable and misses every lookup", () => {
    const log = new RecordingLog();
    const cache = openEvalCache(null, log);
    expect(cache.lookup(fullFen(START), { lines: 1, depth: 8 })).toBeNull();
    expect(cache.lookup(fullFen(AFTER_E4), { lines: 1, depth: 8 })).toBeNull();
    cache.close();
    expect(log.events).toEqual([
      { level: "info", event: "eval_cache.unavailable", fields: { reason: "unset" } },
    ]);
  });

  it("with the file absent logs one eval_cache.unavailable naming the path", () => {
    const log = new RecordingLog();
    const path = join(tmpdir(), "no-such-evals.db");
    const cache = openEvalCache(path, log);
    expect(cache.lookup(fullFen(START), { lines: 1, depth: 8 })).toBeNull();
    expect(log.events).toEqual([
      { level: "warn", event: "eval_cache.unavailable", fields: { reason: "missing", path } },
    ]);
  });

  it("with a file that is no database logs one eval_cache.unavailable and misses", () => {
    const log = new RecordingLog();
    const cache = openEvalCache(scratchFile("evals.db", "this is not a database"), log);
    expect(cache.lookup(fullFen(START), { lines: 1, depth: 8 })).toBeNull();
    expect(log.names()).toEqual(["eval_cache.unavailable"]);
    expect(log.events[0]?.fields).toMatchObject({ reason: "unreadable" });
  });
});

describe("the documentation of the cache", () => {
  it("lists every event it logs under Events in AGENTS.md", () => {
    const agents = readFileSync(join(REPOSITORY_ROOT, "AGENTS.md"), "utf8");
    const events = /- \*\*Events:\*\*[\s\S]*?(?=\n- \*\*)/.exec(agents)?.[0] ?? "";
    for (const event of [
      "eval_cache.hit",
      "eval_cache.miss",
      "eval_cache.unavailable",
      "eval_cache.failed",
    ]) {
      expect(events).toContain(`\`${event}\``);
    }
  });
});
