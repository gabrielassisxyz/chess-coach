import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepertoireCoverageSchema } from "@chess-coach/shared";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../db/open.js";
import {
  createRepertoireVariation,
  insertRepertoireOwnMove,
  type RepertoireMoveSource,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { UciEngine } from "../engine/uci.js";
import { CachedExplorer } from "./explorer-client.js";
import { positionKey } from "./from-games.js";
import {
  CONCESSION_ALLOWANCE_CP,
  repertoireCoverage,
  SOUNDNESS_FLOOR_CONCESSION_CP,
  soundnessFromConcession,
} from "./repertoire-coverage.js";

const SETUP = ["e4", "e5", "Nf3", "Nc6", "Bc4"];
const GIUOCO = [...SETUP, "Bc5"];
const AFTER_C3 = [...GIUOCO, "c3"];
const TWO_KNIGHTS = [...SETUP, "Nf6"];
const AFTER_NG5 = [...TWO_KNIGHTS, "Ng5"];
// Main line of the Giuoco Piano, every move legal: White's c3, d4, cxd4, Bd2 and Nbxd2.
const MAIN = [...AFTER_C3, "Nf6", "d4", "exd4", "cxd4", "Bb4+", "Bd2", "Bxd2+", "Nbxd2"];

type Counts = readonly [wins: number, draws: number, losses: number];
// Plenty of games, so a move set up by the opening is never the end of a line by accident.
const MANY: Counts = [600, 100, 300];

let tmp: string;
let db: Database;
let variationCount = 0;

beforeEach(() => {
  variationCount = 0;
  tmp = mkdtempSync(join(tmpdir(), "cc-repertoire-coverage-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function placeOf(line: readonly string[], san: string): { positionKey: string; uci: string } {
  const board = new Chess();
  for (const played of line) board.move(played);
  const key = positionKey(board.fen());
  const move = board.move(san);
  return { positionKey: key, uci: `${move.from}${move.to}${move.promotion ?? ""}` };
}

interface OwnSpec {
  reach: number;
  cp?: number;
  games?: Counts | null;
  source?: RepertoireMoveSource;
}

interface ReplySpec {
  reach: number;
  source?: RepertoireMoveSource;
}

// Writes the rows a generator run leaves, one call to a row, with every number a test reads set by
// the test: nothing here asks the explorer or the engine.
class StoredVariation {
  readonly id: number;

  constructor() {
    variationCount += 1;
    this.id = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: `Fixture ${variationCount}`,
    }).id;
  }

  /** White's move after `line`, played in the position that line makes. */
  own(line: readonly string[], san: string, spec: OwnSpec): this {
    const games = spec.games === undefined ? MANY : spec.games;
    insertRepertoireOwnMove(db, {
      repertoireId: this.id,
      ...placeOf(line, san),
      ply: line.length + 1,
      line: [...line],
      reach: spec.reach,
      openingName: null,
      san,
      share: null,
      source: spec.source ?? "explorer",
      cpLoss: spec.cp ?? 0,
      evalCp: 25,
      results: games ? { wins: games[0], draws: games[1], losses: games[2] } : null,
    });
    return this;
  }

  /** Black's reply in the position `line` makes, which ends on White's move. */
  reply(line: readonly string[], san: string, spec: ReplySpec): this {
    upsertRepertoireReply(db, {
      repertoireId: this.id,
      ...placeOf(line, san),
      ply: line.length + 1,
      line: [...line],
      reach: spec.reach,
      openingName: null,
      san,
      share: spec.source === "engine" ? null : spec.reach,
      source: spec.source ?? "explorer",
    });
    return this;
  }

  /** The Italian opening as the generator stores it: every move fixed, nothing below the goal. */
  setup(): this {
    const fixed: OwnSpec = { reach: 1, source: "setup" };
    return this.own([], "e4", fixed)
      .reply(["e4"], "e5", { reach: 1, source: "setup" })
      .own(["e4", "e5"], "Nf3", fixed)
      .reply(["e4", "e5", "Nf3"], "Nc6", { reach: 1, source: "setup" })
      .own(["e4", "e5", "Nf3", "Nc6"], "Bc4", { ...fixed, cp: 10 });
  }

  coverage() {
    const coverage = repertoireCoverage(db, this.id);
    if (!coverage) throw new Error("the variation was not found");
    return RepertoireCoverageSchema.parse(coverage);
  }
}

// After 3.Bc4 Black plays 3...Bc5 in 6 games of 10 and 3...Nf6 in 4. Each is answered once and
// the line stops there: the numbers every score test below works out by hand.
function branching(): StoredVariation {
  return new StoredVariation()
    .setup()
    .reply(SETUP, "Bc5", { reach: 0.6 })
    .reply(SETUP, "Nf6", { reach: 0.4 })
    .own(GIUOCO, "c3", { reach: 0.6, cp: 20, games: [150, 60, 90] })
    .own(TWO_KNIGHTS, "Ng5", { reach: 0.4, cp: 70, games: [60, 40, 100] });
}

describe("the walk of the stored moves", () => {
  it("lists a position for each White move, the likeliest reply first, and opens where Black first has a choice", () => {
    const coverage = branching().coverage();
    expect(coverage.positions.map((position) => position.line.join(" "))).toEqual([
      "e4",
      "e4 e5 Nf3",
      "e4 e5 Nf3 Nc6 Bc4",
      "e4 e5 Nf3 Nc6 Bc4 Bc5 c3",
      "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5",
    ]);
    expect(coverage.positions.map((position) => position.parent)).toEqual([null, 0, 1, 2, 2]);
    expect(coverage.start).toBe(2);
    const choice = coverage.positions[coverage.start];
    expect(choice?.replies.map((reply) => [reply.san, reply.incidence, reply.next])).toEqual([
      ["Bc5", 0.6, 3],
      ["Nf6", 0.4, 4],
    ]);
  });

  it("opens on the last position of a variation stored only as far as its opening", () => {
    const stored = new StoredVariation().own([], "e4", { reach: 1, source: "setup" });
    expect(stored.coverage().start).toBe(0);
  });

  it("answers an empty list for a variation with nothing stored", () => {
    const coverage = new StoredVariation().coverage();
    expect(coverage).toMatchObject({
      covered_percent: null,
      gaps: [],
      largest_gap: null,
      start: 0,
      positions: [],
      scores: { line_ends: 0, expected_score: null, soundness: null },
    });
  });

  it("finds no coverage for a variation that does not exist", () => {
    expect(repertoireCoverage(db, 999)).toBeNull();
  });

  it("walks a position reached by two move orders once and points both replies at it", () => {
    const stored = new StoredVariation()
      .own([], "e4", { reach: 1 })
      .reply(["e4"], "e5", { reach: 0.6 })
      .reply(["e4"], "Nf6", { reach: 0.4 })
      .own(["e4", "e5"], "Nf3", { reach: 0.6 })
      .own(["e4", "Nf6"], "Nf3", { reach: 0.4 })
      .reply(["e4", "e5", "Nf3"], "Nf6", { reach: 0.3 })
      .reply(["e4", "Nf6", "Nf3"], "e5", { reach: 0.2 })
      .own(["e4", "e5", "Nf3", "Nf6"], "Nxe5", { reach: 0.3 });
    const coverage = stored.coverage();
    expect(coverage.positions.map((position) => position.line.join(" "))).toEqual([
      "e4",
      "e4 e5 Nf3",
      "e4 e5 Nf3 Nf6 Nxe5",
      "e4 Nf6 Nf3",
    ]);
    const viaE5 = coverage.positions[1]?.replies[0];
    const viaNf6 = coverage.positions[3]?.replies[0];
    expect([viaE5?.next, viaNf6?.next]).toEqual([2, 2]);
    expect([viaE5?.status, viaNf6?.status]).toEqual(["covered", "covered"]);
    expect(coverage.gaps).toEqual([]);
  });

  it("does not loop on a position that comes back to one the walk is inside", () => {
    const stored = new StoredVariation()
      .own([], "Nf3", { reach: 1 })
      .reply(["Nf3"], "Nf6", { reach: 1 })
      .own(["Nf3", "Nf6"], "Ng1", { reach: 1 })
      .reply(["Nf3", "Nf6", "Ng1"], "Ng8", { reach: 1 });
    const coverage = stored.coverage();
    expect(coverage.positions.map((position) => position.line.join(" "))).toEqual([
      "Nf3",
      "Nf3 Nf6 Ng1",
    ]);
    expect(coverage.positions[1]?.replies).toMatchObject([{ san: "Ng8", next: 0 }]);
  });

  it("leaves out a White move that no reply of the variation leads to", () => {
    const stored = branching().own(["d4", "d5"], "c4", { reach: 0.9 });
    expect(stored.coverage().positions).toHaveLength(5);
  });

  it("keeps the source of each reply and reads 0 for the engine's, which no game played", () => {
    const stored = branching()
      .reply(AFTER_C3, "Nf6", { reach: 0.008, source: "mainline" })
      .reply(AFTER_C3, "d6", { reach: 0, source: "engine" })
      .own([...AFTER_C3, "Nf6"], "d4", { reach: 0.008 })
      .own([...AFTER_C3, "d6"], "d4", { reach: 0 });
    const replies = stored.coverage().positions[3]?.replies;
    expect(
      replies?.map((reply) => [reply.san, reply.source, reply.incidence, reply.status]),
    ).toEqual([
      ["Nf6", "mainline", 0.008, "covered"],
      ["d6", "engine", 0, "covered"],
    ]);
  });
});

describe("coverage and gaps", () => {
  // Below 3...Bc5 4.c3 White answers 4...Nf6, and 4...d6 and 4...a6 have no answer. After 4.Ng5
  // (against 3...Nf6) White answers 4...d5, and 4...Nxe4 has none. Two replies are rarer than 1 in 50.
  function withGaps(): StoredVariation {
    return branching()
      .reply(AFTER_C3, "Nf6", { reach: 0.3 })
      .reply(AFTER_C3, "d6", { reach: 0.18 })
      .reply(AFTER_C3, "a6", { reach: 0.02 })
      .reply(AFTER_C3, "g6", { reach: 0.0199 })
      .reply(AFTER_C3, "h6", { reach: 0.006 })
      .own([...AFTER_C3, "Nf6"], "d4", { reach: 0.3 })
      .reply(AFTER_NG5, "d5", { reach: 0.3 })
      .reply(AFTER_NG5, "Nxe4", { reach: 0.1 })
      .own([...AFTER_NG5, "d5"], "exd5", { reach: 0.3 });
  }

  it("marks a reply with an answer covered, one without it a gap at 1 in 50 or likelier, and a rarer one not required", () => {
    const replies = withGaps().coverage().positions[3]?.replies;
    expect(replies?.map((reply) => [reply.san, reply.status])).toEqual([
      ["Nf6", "covered"],
      ["d6", "gap"],
      ["a6", "gap"],
      ["g6", "not_required"],
      ["h6", "not_required"],
    ]);
  });

  it("lists the gaps with the line through the reply and the chance of reaching them, likeliest first", () => {
    const coverage = withGaps().coverage();
    expect(coverage.goal_one_in).toBe(50);
    expect(coverage.gaps).toEqual([
      { line: [...AFTER_C3, "d6"], incidence: 0.18, position: 3 },
      { line: [...AFTER_NG5, "Nxe4"], incidence: 0.1, position: 5 },
      { line: [...AFTER_C3, "a6"], incidence: 0.02, position: 3 },
    ]);
    expect(coverage.largest_gap).toEqual(coverage.gaps[0]);
  });

  it("reads the covered share as the games that end in a prepared line over those and the gaps", () => {
    // Prepared lines end after 5.d4 (0.3) and 5.exd5 (0.3); the gaps hold 0.18, 0.1 and 0.02.
    // 0.6 / (0.6 + 0.3) = 66.7 percent.
    expect(withGaps().coverage().covered_percent).toBe(66.7);
  });

  it("reads everything covered as 100 and leaves out of it what is too rare to need an answer", () => {
    const stored = branching()
      .reply(AFTER_C3, "h6", { reach: 0.006 })
      .reply(AFTER_C3, "Nf6", { reach: 0.2 })
      .own([...AFTER_C3, "Nf6"], "d4", { reach: 0.2 });
    const coverage = stored.coverage();
    expect(coverage.gaps).toEqual([]);
    expect(coverage.largest_gap).toBeNull();
    expect(coverage.covered_percent).toBe(100);
  });

  it("reads a variation cut short in its opening as nothing covered", () => {
    const stored = new StoredVariation()
      .own([], "e4", { reach: 1, source: "setup" })
      .reply(["e4"], "e5", { reach: 1, source: "setup" });
    const coverage = stored.coverage();
    expect(coverage.gaps).toEqual([{ line: ["e4", "e5"], incidence: 1, position: 0 }]);
    expect(coverage.covered_percent).toBe(0);
  });

  it("counts a reply below 1 in 50 that has an answer as covered, whichever way it came", () => {
    const stored = branching()
      .reply(AFTER_C3, "d6", { reach: 0.015, source: "mainline" })
      .own([...AFTER_C3, "d6"], "d4", { reach: 0.015 });
    const reply = stored.coverage().positions[3]?.replies[0];
    expect(reply).toMatchObject({ san: "d6", status: "covered", incidence: 0.015 });
  });
});

describe("soundness", () => {
  it("maps 0 centipawns to 99 and 200 to 1, linearly between, and holds to that range", () => {
    expect(soundnessFromConcession(0)).toBe(99);
    expect(soundnessFromConcession(SOUNDNESS_FLOOR_CONCESSION_CP)).toBe(1);
    expect(soundnessFromConcession(100)).toBe(50);
    expect(soundnessFromConcession(30)).toBeCloseTo(84.3, 5);
    expect(soundnessFromConcession(1000)).toBe(1);
    expect(soundnessFromConcession(-20)).toBe(99);
  });

  it("allows 10 centipawns on each White move and counts only what a move gives up beyond them", () => {
    expect(CONCESSION_ALLOWANCE_CP).toBe(10);
    // A line whose moves give up 0, 5, 10, 30 and 20 concedes 0 + 0 + 0 + 20 + 10 = 30, which is 84.
    const stored = new StoredVariation()
      .own([], "e4", { reach: 1, cp: 0, games: [600, 100, 300] })
      .reply(["e4"], "e5", { reach: 1 })
      .own(["e4", "e5"], "Nf3", { reach: 1, cp: 5 })
      .reply(["e4", "e5", "Nf3"], "Nc6", { reach: 1 })
      .own(["e4", "e5", "Nf3", "Nc6"], "Bc4", { reach: 1, cp: 10 })
      .reply(SETUP, "Bc5", { reach: 1 })
      .own(GIUOCO, "c3", { reach: 1, cp: 30 })
      .reply(AFTER_C3, "Nf6", { reach: 1 })
      .own([...AFTER_C3, "Nf6"], "d4", { reach: 1, cp: 20 });
    expect(stored.coverage().scores).toMatchObject({ line_ends: 1, soundness: 84 });
  });

  it("counts each move on its own, so a move inside the allowance does not pay for another's loss", () => {
    // 100 then 0 centipawns concede 90; netting the allowance over the line would read 80.
    const stored = new StoredVariation()
      .own([], "e4", { reach: 1, cp: 100 })
      .reply(["e4"], "e5", { reach: 1 })
      .own(["e4", "e5"], "Nf3", { reach: 1, cp: 0 });
    expect(stored.coverage().scores.soundness).toBe(Math.round(soundnessFromConcession(90)));
  });

  it("averages the concession of the line ends by how often each arises", () => {
    // 0.6 of the games end after 4.c3 (10 conceded) and 0.4 after 4.Ng5 (60): 6 + 24 = 30 on the
    // scale gives 84, where counting the two ends alike would give a mean of 35 and a score of 82.
    expect(branching().coverage().scores.soundness).toBe(84);
  });
});

describe("expected score", () => {
  it("weights the result at each line end by how often the line arises, to one decimal", () => {
    // After 4.c3 White scores (150 + 60/2) / 300 = 0.6 and after 4.Ng5 (60 + 40/2) / 200 = 0.4,
    // so 0.6 * 0.6 + 0.4 * 0.4 = 0.52. Counting the ends alike would read 50.0.
    expect(branching().coverage().scores).toEqual({
      line_ends: 2,
      expected_score: 52,
      soundness: 84,
    });
  });

  it("reads one decimal of a result that does not come out even", () => {
    const stored = new StoredVariation()
      .own([], "e4", { reach: 1, games: [100, 0, 200] })
      .reply(["e4"], "e5", { reach: 1 })
      .own(["e4", "e5"], "Nf3", { reach: 1, games: [100, 0, 200] });
    expect(stored.coverage().scores.expected_score).toBe(33.3);
  });

  it("ends a line at its deepest White move with 200 games or more, not at the last move", () => {
    const stored = lineThatThins();
    const scores = stored.coverage().scores;
    // 4.c3 has 250 games and scores (100 + 50/2) / 250 = 0.5; 5.d4, with 120 games, would score 0.79.
    // Its concession is 0 + 0 + 20 + 10 = 30, and the 70 that 5.d4 gives up beyond the allowance is left out.
    expect(scores).toEqual({ line_ends: 1, expected_score: 50, soundness: 84 });
  });

  it("counts a position with exactly 200 games as enough and one with 199 as too few", () => {
    const enough = lineThatThins({ c3: [100, 0, 100] }).coverage().scores;
    expect(enough.expected_score).toBe(50);
    const tooFew = lineThatThins({ c3: [100, 0, 99] }).coverage().scores;
    // 4.c3 now has 199 games, so the line ends at 3.Bc4, which has 600 and scores (360 + 60 / 2) / 600.
    expect(tooFew.expected_score).toBe(65);
  });

  it("ends a line below a move with too few games when a deeper one has enough", () => {
    // 4.c3 has 300 games, 5.d4 only 50 and 6.cxd4 250: the line ends at 6.cxd4, which scores 0.7.
    const stored = new StoredVariation()
      .setup()
      .reply(SETUP, "Bc5", { reach: 0.5 })
      .own(GIUOCO, "c3", { reach: 0.5, games: [200, 50, 50] })
      .reply(AFTER_C3, "Nf6", { reach: 0.25 })
      .own([...AFTER_C3, "Nf6"], "d4", { reach: 0.25, games: [30, 10, 10] })
      .reply(MAIN.slice(0, 9), "exd4", { reach: 0.2 })
      .own(MAIN.slice(0, 10), "cxd4", { reach: 0.2, games: [150, 50, 50] });
    expect(stored.coverage().scores).toMatchObject({ line_ends: 1, expected_score: 70 });
  });

  it("reads no score where no White move has the games to say anything", () => {
    const stored = new StoredVariation()
      .own([], "e4", { reach: 1, games: [20, 10, 10] })
      .reply(["e4"], "e5", { reach: 1 })
      .own(["e4", "e5"], "Nf3", { reach: 1, games: null });
    expect(stored.coverage().scores).toEqual({
      line_ends: 0,
      expected_score: null,
      soundness: null,
    });
  });
});

// The opening, then 3...Bc5 4.c3 Nf6 5.d4, each position with fewer games than the one before, so
// the line has to end before its last move. `counts` replaces the games after 4.c3.
function lineThatThins(counts: { c3?: Counts } = {}): StoredVariation {
  return new StoredVariation()
    .own([], "e4", { reach: 1, games: [600, 100, 300] })
    .reply(["e4"], "e5", { reach: 1, source: "setup" })
    .own(["e4", "e5"], "Nf3", { reach: 1, cp: 5, games: [480, 80, 240] })
    .reply(["e4", "e5", "Nf3"], "Nc6", { reach: 1, source: "setup" })
    .own(["e4", "e5", "Nf3", "Nc6"], "Bc4", { reach: 1, cp: 30, games: [360, 60, 180] })
    .reply(SETUP, "Bc5", { reach: 0.5 })
    .own(GIUOCO, "c3", { reach: 0.5, cp: 20, games: counts.c3 ?? [100, 50, 100] })
    .reply(AFTER_C3, "Nf6", { reach: 0.25 })
    .own([...AFTER_C3, "Nf6"], "d4", { reach: 0.25, cp: 80, games: [90, 10, 20] });
}

describe("what the scores read", () => {
  it("asks neither the network, the explorer nor the engine for the coverage or either score", () => {
    const refuse = (asked: string) => (): never => {
      throw new Error(`the coverage asked ${asked}`);
    };
    const network = vi.fn(refuse("the network"));
    vi.stubGlobal("fetch", network);
    const explorer = vi
      .spyOn(CachedExplorer.prototype, "position")
      .mockImplementation(refuse("the explorer"));
    const engine = vi.spyOn(UciEngine.prototype, "search").mockImplementation(refuse("the engine"));

    const coverage = branching().coverage();

    expect(coverage.scores).toMatchObject({ expected_score: 52, soundness: 84 });
    expect(coverage.covered_percent).toBe(100);
    expect(network).not.toHaveBeenCalled();
    expect(explorer).not.toHaveBeenCalled();
    expect(engine).not.toHaveBeenCalled();
  });

  it("follows the counts and centipawn losses stored on the moves", () => {
    const stored = branching();
    db.prepare(
      "UPDATE repertoire_positions SET wins = 200, draws = 0, losses = 0, cp_loss = 10 WHERE repertoire_id = ? AND move_san = 'c3'",
    ).run(stored.id);
    // 4.c3 now scores 1.0 and concedes nothing: 0.6 * 1.0 + 0.4 * 0.4 = 0.76, and 0.4 * 60 = 24.
    expect(stored.coverage().scores).toMatchObject({
      expected_score: 76,
      soundness: Math.round(soundnessFromConcession(24)),
    });
  });
});
