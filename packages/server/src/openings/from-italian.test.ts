import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, FakeExplorer } from "../../test/fakes/fake-explorer.js";
import { type Database, openDatabase } from "../db/open.js";
import type { Searcher, SearchRequest, SearchResult } from "../engine/uci.js";
import { CachedExplorer, EXPLORER_RATINGS, ITALIAN_WHITE_RATINGS } from "./explorer-client.js";
import { positionKey } from "./from-games.js";
import {
  generateItalianPuzzles,
  ITALIAN_MAX_PLY,
  italianPuzzleId,
  pickItalianWhiteUci,
} from "./from-italian.js";
import { type OpeningNames, parseOpeningTable } from "./names.js";

const START_FEN = new Chess().fen();

function fenAfter(...sans: string[]): string {
  const game = new Chess();
  for (const san of sans) game.move(san);
  return game.fen();
}

const AFTER_ITALIAN = fenAfter("e4", "e5", "Nf3", "Nc6", "Bc4");
const italianNames = parseOpeningTable(
  `eco\tname\tpgn\tuci\tepd\nC50\tItalian Game\t1. e4 e5 2. Nf3 Nc6 3. Bc4\te2e4\t${positionKey(AFTER_ITALIAN)}\n`,
);

/** Returns the same five lines every time, so each move-choice case controls the scores. */
class ScriptedItalianSearcher implements Searcher {
  constructor(private readonly lines: Array<{ moves: string[]; score: number }>) {}

  async search(request: SearchRequest): Promise<SearchResult> {
    return { fen: request.fen, bestmove: this.lines[0]?.moves[0] ?? null, lines: this.lines };
  }
}

/** Serves the Italian fixture by position and records which rating band each call used. */
class ItalianFixtureExplorer {
  readonly calls: Array<{ key: string; ratings: string | undefined }> = [];
  private readonly answers = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../test/fixtures/explorer/italian-tree.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;

  constructor(
    private readonly clock: FakeClock,
    private readonly extraReplies: ReadonlyMap<string, string> = new Map(),
  ) {}

  async fetch(fen: string, ratings?: string): Promise<string> {
    const key = positionKey(fen);
    this.calls.push({ key, ratings });
    this.clock.advance(1100);
    const reply = this.extraReplies.get(key);
    if (reply) {
      return JSON.stringify({
        white: 500,
        draws: 0,
        black: 500,
        moves: [{ san: reply, white: 500, draws: 0, black: 500 }],
      });
    }
    return JSON.stringify(this.answers[key] ?? { white: 0, draws: 0, black: 0, moves: [] });
  }
}

/** Engine whose best move follows the Italian setup wherever the test walks. */
class ItalianWalkEngine implements Searcher {
  private readonly bestByKey: Record<string, string>;

  constructor() {
    this.bestByKey = {
      [positionKey(START_FEN)]: "e2e4",
      [positionKey(fenAfter("e4", "e5"))]: "g1f3",
      [positionKey(fenAfter("e4", "c5"))]: "g1f3",
      [positionKey(fenAfter("e4", "e5", "Nf3", "Nc6"))]: "f1c4",
    };
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    const key = positionKey(request.fen);
    const fallback = new Chess(request.fen).moves({ verbose: true })[0];
    const bestUci = this.bestByKey[key] ?? (fallback ? `${fallback.from}${fallback.to}` : "a2a3");
    return {
      fen: request.fen,
      bestmove: bestUci,
      lines: [
        { moves: [bestUci], score: 100 },
        { moves: ["a2a3"], score: 90 },
        { moves: ["h2h3"], score: 80 },
        { moves: ["g2g3"], score: 70 },
        { moves: ["b2b3"], score: 60 },
      ],
    };
  }
}

let tmp: string;
let cacheDir: string;
let db: Database;
let clock: FakeClock;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-italian-"));
  cacheDir = join(tmp, "explorer-cache");
  db = openDatabase(tmp);
  clock = new FakeClock();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function positionFromFake(fen: string) {
  const explorer = new FakeExplorer(clock);
  const cached = new CachedExplorer(explorer, cacheDir, clock);
  return cached.position(fen);
}

describe("pickItalianWhiteUci", () => {
  it("accepts the most played move when it stays within 50 cp", async () => {
    const position = await positionFromFake(START_FEN);
    const searcher = new ScriptedItalianSearcher([
      { moves: ["d2d4"], score: 100 },
      { moves: ["e2e4"], score: 90 },
      { moves: ["g1f3"], score: 80 },
      { moves: ["c2c4"], score: 70 },
      { moves: ["e2e3"], score: 60 },
    ]);
    const lines = (await searcher.search({ fen: START_FEN })).lines;
    expect(pickItalianWhiteUci(START_FEN, position, lines, 4)).toBe("d2d4");
  });

  it("rejects the most played move at 80 cp and takes the next qualifier", async () => {
    const position = await positionFromFake(START_FEN);
    const searcher = new ScriptedItalianSearcher([
      { moves: ["e2e4"], score: 100 },
      { moves: ["d2d4"], score: 20 },
      { moves: ["g1f3"], score: 90 },
      { moves: ["c2c4"], score: 80 },
      { moves: ["e2e3"], score: 70 },
    ]);
    const lines = (await searcher.search({ fen: START_FEN })).lines;
    expect(pickItalianWhiteUci(START_FEN, position, lines, 4)).toBe("e2e4");
  });

  it("prefers the setup move on turns 1-3 when it qualifies", async () => {
    const position = await positionFromFake(START_FEN);
    const searcher = new ScriptedItalianSearcher([
      { moves: ["d2d4"], score: 100 },
      { moves: ["e2e4"], score: 90 },
      { moves: ["g1f3"], score: 80 },
      { moves: ["c2c4"], score: 70 },
      { moves: ["e2e3"], score: 60 },
    ]);
    const lines = (await searcher.search({ fen: START_FEN })).lines;
    expect(pickItalianWhiteUci(START_FEN, position, lines, 1)).toBe("e2e4");
  });

  it("falls back to the engine best when no popular move qualifies", async () => {
    const position = await positionFromFake(START_FEN);
    const searcher = new ScriptedItalianSearcher([
      { moves: ["h2h4"], score: 100 },
      { moves: ["d2d4"], score: 20 },
      { moves: ["e2e4"], score: 10 },
      { moves: ["g1f3"], score: 0 },
      { moves: ["c2c4"], score: -10 },
    ]);
    const lines = (await searcher.search({ fen: START_FEN })).lines;
    expect(pickItalianWhiteUci(START_FEN, position, lines, 4)).toBe("h2h4");
  });
});

describe("generateItalianPuzzles", () => {
  const rows = () =>
    db
      .prepare("SELECT * FROM puzzles WHERE source = 'italian-explorer' ORDER BY id")
      .all() as Array<{
      id: string;
      motif: string;
      fen: string;
      solution_uci: string;
      explanation: string;
      opening_name: string | null;
    }>;

  const run = (
    explorer: ItalianFixtureExplorer,
    engine: Searcher,
    options: Parameters<typeof generateItalianPuzzles>[5] = {},
    names?: OpeningNames,
  ) =>
    generateItalianPuzzles(db, engine, explorer, cacheDir, clock, { maxPly: 4, ...options }, names);

  it("keeps the Italian name on a White drill past its last named position", async () => {
    const explorer = new ItalianFixtureExplorer(
      clock,
      new Map([[positionKey(AFTER_ITALIAN), "Bc5"]]),
    );
    await run(explorer, new ItalianWalkEngine(), { maxPly: 7 }, italianNames);
    expect(
      rows().find((row) => row.fen === fenAfter("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"))
        ?.opening_name,
    ).toBe("Italian Game");
    expect(rows().find((row) => row.fen === START_FEN)?.opening_name).toBeNull();
  });

  it("stores every White node as an italian puzzle with the expected shape", async () => {
    const explorer = new ItalianFixtureExplorer(clock);
    const result = await run(explorer, new ItalianWalkEngine());
    const stored = rows();
    expect(stored.length).toBeGreaterThan(1);
    for (const row of stored) {
      expect(row.id).toMatch(/^italian:[0-9a-f]{16}$/);
      expect(row.motif).toBe("opening-italian");
      expect(JSON.parse(row.solution_uci)).toHaveLength(1);
    }
    const startId = italianPuzzleId(positionKey(START_FEN));
    expect(stored.map((row) => row.id)).toContain(startId);
    const start = stored.find((row) => row.id === startId);
    expect(start?.explanation).toContain("Italian Opening");
    expect(start?.explanation).toContain("Best: e4.");
    const afterE5 = stored.find((row) => row.fen === fenAfter("e4", "e5"));
    expect(afterE5?.explanation).toContain("1. e4 e5");
    expect(afterE5?.explanation).toContain("Best: Nf3.");
    expect(result).toMatchObject({ created: stored.length, truncated: false });
    expect(result.requests).toBeGreaterThan(0);
  });

  it("requests the high band at White nodes and the low band at Black nodes", async () => {
    const explorer = new ItalianFixtureExplorer(clock);
    await run(explorer, new ItalianWalkEngine());
    const byFen = new Map(explorer.calls.map((call) => [call.key, call.ratings]));
    expect(byFen.get(positionKey(START_FEN))).toBe(ITALIAN_WHITE_RATINGS);
    expect(byFen.get(positionKey(fenAfter("e4")))).toBe(EXPLORER_RATINGS);
    expect(byFen.get(positionKey(fenAfter("e4", "e5")))).toBe(ITALIAN_WHITE_RATINGS);
    expect(explorer.calls.length).toBeGreaterThan(0);
    for (const call of explorer.calls) {
      expect([EXPLORER_RATINGS, ITALIAN_WHITE_RATINGS]).toContain(call.ratings);
    }
  });

  it("keeps deviations at moves 1-2 when the fixture has them", async () => {
    const explorer = new ItalianFixtureExplorer(clock);
    await run(explorer, new ItalianWalkEngine());
    const fens = rows().map((row) => row.fen);
    expect(fens).toContain(fenAfter("e4", "e5"));
    expect(fens).toContain(fenAfter("e4", "c5"));
  });

  it("stops at the ply limit", async () => {
    const first = new ItalianFixtureExplorer(clock);
    await run(first, new ItalianWalkEngine(), { maxPly: 2 });
    expect(rows().map((row) => row.fen)).toEqual([START_FEN]);
    expect(first.calls).toHaveLength(2);
  });

  it("reruns add nothing new", async () => {
    const explorer = new ItalianFixtureExplorer(clock);
    const engine = new ItalianWalkEngine();
    const first = await run(explorer, engine);
    const again = new ItalianFixtureExplorer(clock);
    const second = await generateItalianPuzzles(db, engine, again, cacheDir, clock, { maxPly: 4 });
    expect(second.created).toBe(0);
    expect(second.requests).toBe(0);
    expect(second.cacheHits).toBeGreaterThan(0);
    expect(rows()).toHaveLength(first.created);
  });

  it("stops at ply 24 by default", () => {
    expect(ITALIAN_MAX_PLY).toBe(24);
  });
});
