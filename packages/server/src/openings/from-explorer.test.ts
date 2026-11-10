import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, FakeExplorer } from "../../test/fakes/fake-explorer.js";
import { setGrading } from "../db/games.js";
import { type Database, openDatabase } from "../db/open.js";
import { insertGeneratedPuzzle, listPuzzles } from "../db/puzzles.js";
import type { Searcher, SearchRequest, SearchResult } from "../engine/uci.js";
import { importFinishedGame } from "../import/pgn.js";
import { ExplorerError, type ExplorerFetcher } from "./explorer-client.js";
import { generateExplorerPuzzles } from "./from-explorer.js";
import { positionKey, puzzleId } from "./from-games.js";
import { parseOpeningTable } from "./names.js";

const WHITE_ONE =
  '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 1-0';
const WHITE_TWO =
  '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3 d6 6. O-O O-O 7. Bb3 a6 1-0';
const WHITE_THREE =
  '[Result "1-0"]\n\n1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 h6 7. Bh4 b6 1-0';
const BLACK_ONE =
  '[Result "0-1"]\n\n1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 h6 7. Bh4 b6 0-1';

function fenAfter(...sans: string[]): string {
  const game = new Chess();
  for (const san of sans) game.move(san);
  return game.fen();
}

const START = fenAfter();
const AFTER_E4_E5 = fenAfter("e4", "e5");
const AFTER_E4_C5 = fenAfter("e4", "c5");
const AFTER_D4_D5 = fenAfter("d4", "d5");
const AFTER_E4_D5 = fenAfter("e4", "d5");
const AFTER_ITALIAN = fenAfter("e4", "e5", "Nf3", "Nc6", "Bc4");

const italianNames = parseOpeningTable(
  `eco\tname\tpgn\tuci\tepd\nC50\tItalian Game\t1. e4 e5 2. Nf3 Nc6 3. Bc4\te2e4\t${positionKey(AFTER_ITALIAN)}\n`,
);

class ItalianPathExplorer implements ExplorerFetcher {
  private readonly replies = new Map([
    [positionKey(fenAfter("e4")), "e5"],
    [positionKey(fenAfter("e4", "e5", "Nf3")), "Nc6"],
    [positionKey(AFTER_ITALIAN), "Bc5"],
  ]);

  async fetch(fen: string): Promise<string> {
    const san = this.replies.get(positionKey(fen));
    if (!san) return JSON.stringify({ white: 0, draws: 0, black: 0, moves: [] });
    return JSON.stringify({
      white: 500,
      draws: 0,
      black: 500,
      moves: [{ san, white: 500, draws: 0, black: 500 }],
    });
  }
}

const BEST_BY_KEY: Record<string, string> = {
  [positionKey(AFTER_E4_E5)]: "g1f3",
  [positionKey(AFTER_E4_C5)]: "g1f3",
  [positionKey(fenAfter("d4", "d5", "c4"))]: "e7e6",
  [positionKey(fenAfter("e4", "d5", "exd5"))]: "d8d5",
};

/** Plays the scripted best move where one is named, else the first legal move, a fixed gap ahead. */
class ScriptedSearcher implements Searcher {
  readonly searched: string[] = [];
  readonly gapByKey = new Map<string, number>();

  async search(request: SearchRequest): Promise<SearchResult> {
    const key = positionKey(request.fen);
    this.searched.push(key);
    const [first] = new Chess(request.fen).moves({ verbose: true });
    const best = BEST_BY_KEY[key] ?? (first ? `${first.from}${first.to}` : "a2a3");
    const gap = this.gapByKey.get(key) ?? 80;
    return {
      fen: request.fen,
      bestmove: best,
      lines: [
        { moves: [best], score: 100 },
        { moves: ["h2h3"], score: 100 - gap },
      ],
    };
  }
}

let tmp: string;
let cacheDir: string;
let db: Database;
let clock: FakeClock;
let explorer: FakeExplorer;
let engine: ScriptedSearcher;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-explorer-"));
  cacheDir = join(tmp, "explorer-cache");
  db = openDatabase(tmp);
  clock = new FakeClock();
  explorer = new FakeExplorer(clock);
  engine = new ScriptedSearcher();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function addGame(pgn: string, color: "white" | "black", id: string, grading = "done"): void {
  const gameId = importFinishedGame(db, { pgn, playerColor: color, source: "pgn", sourceId: id });
  if (gameId === null) throw new Error("fixture game was not imported");
  setGrading(db, gameId, grading as "done");
}

const rows = () =>
  db.prepare("SELECT * FROM puzzles WHERE source = 'lichess-explorer' ORDER BY id").all() as Array<{
    id: string;
    motif: string;
    fen: string;
    difficulty: string;
    solution_uci: string;
    solution_san: string;
    explanation: string;
    opening_name: string | null;
  }>;

const run = (options: Parameters<typeof generateExplorerPuzzles>[5] = {}) =>
  generateExplorerPuzzles(db, engine, explorer, cacheDir, clock, {
    repertoireTurns: 1,
    maxPly: 4,
    ...options,
  });

function seedWhite(): void {
  addGame(WHITE_ONE, "white", "w1");
  addGame(WHITE_TWO, "white", "w2");
  addGame(WHITE_THREE, "white", "w3");
}

describe("generateExplorerPuzzles", () => {
  it("keeps the Italian name on a drill past its last named position", async () => {
    addGame(WHITE_TWO, "white", "italian");
    const result = await generateExplorerPuzzles(
      db,
      engine,
      new ItalianPathExplorer(),
      cacheDir,
      clock,
      { color: "white", repertoireTurns: 3, maxPly: 7 },
      italianNames,
    );
    expect(result.created).toBe(1);
    expect(rows()).toMatchObject([
      {
        fen: fenAfter("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"),
        opening_name: "Italian Game",
      },
    ]);
  });
  it("expands the student's first move into the replies played at the band", async () => {
    seedWhite();
    const result = await run({ color: "white" });
    const stored = rows();
    const expectedId = `explorer:${createHash("sha256").update(positionKey(AFTER_E4_E5)).digest("hex").slice(0, 16)}`;
    expect(stored.map((row) => row.id)).toContain(expectedId);
    expect(stored).toHaveLength(2);
    const e5 = stored.find((row) => row.id === expectedId);
    expect(e5).toMatchObject({
      motif: "opening-white",
      difficulty: "beginner",
      fen: AFTER_E4_E5,
      solution_uci: '["g1f3"]',
      solution_san: '["Nf3"]',
      explanation: "Played by 45% of opponents at 0-1199 after 1. e4 e5. Best: Nf3.",
    });
    // e6 and d5 stay out: e5 and c5 already cover 70 percent of the games.
    expect(stored.map((row) => row.fen).sort()).toEqual([AFTER_E4_C5, AFTER_E4_E5].sort());
    expect(result).toMatchObject({ created: 2, requests: 3, cacheHits: 0, truncated: false });
  });

  it("derives a black repertoire per turn when a position was never seen", async () => {
    addGame(BLACK_ONE, "black", "b1");
    const result = await run({ color: "black" });
    // 1.d4 was met by d5 in the game; 1.e4 was not, so the turn-one habit answers it.
    expect(explorer.calls.map((call) => call.key)).toEqual([
      positionKey(START),
      positionKey(AFTER_D4_D5),
      positionKey(AFTER_E4_D5),
    ]);
    expect(
      rows()
        .map((row) => [row.motif, row.solution_san, row.explanation])
        .sort(),
    ).toEqual([
      [
        "opening-black",
        '["Qxd5"]',
        "Played by 73% of opponents at 0-1199 after 1. e4 d5 2. exd5. Best: Qxd5.",
      ],
      [
        "opening-black",
        '["e6"]',
        "Played by 64% of opponents at 0-1199 after 1. d4 d5 2. c4. Best: e6.",
      ],
    ]);
    expect(result.created).toBe(2);
  });

  it("does nothing for a colour the student has no graded games with", async () => {
    addGame(WHITE_ONE, "white", "w1", "pending");
    const result = await run();
    expect(result).toMatchObject({ created: 0, requests: 0 });
    expect(explorer.calls).toEqual([]);
  });

  it("makes no request on a second run and refetches an entry older than 90 days", async () => {
    seedWhite();
    await run({ color: "white" });
    const again = new FakeExplorer(clock);
    const second = await generateExplorerPuzzles(db, engine, again, cacheDir, clock, {
      color: "white",
      repertoireTurns: 1,
      maxPly: 4,
    });
    expect(again.calls).toEqual([]);
    expect(second).toMatchObject({ requests: 0, cacheHits: 3, created: 0 });
    expect(readdirSync(cacheDir).every((name) => /^[0-9a-f]{64}\.json$/.test(name))).toBe(true);

    clock.advance(90 * 24 * 60 * 60 * 1000 + 1);
    const stale = new FakeExplorer(clock);
    await generateExplorerPuzzles(db, engine, stale, cacheDir, clock, {
      color: "white",
      repertoireTurns: 1,
      maxPly: 4,
    });
    expect(stale.calls).toHaveLength(3);
  });

  it("spaces requests by at least the gap", async () => {
    seedWhite();
    await run({ color: "white" });
    const times = explorer.calls.map((call) => call.at);
    expect(times).toHaveLength(3);
    for (let i = 1; i < times.length; i += 1) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(1100);
    }
  });

  it("waits 30 seconds after a 429 and retries once, then gives up", async () => {
    seedWhite();
    explorer.rateLimitFirst = 1;
    await run({ color: "white" });
    expect(clock.sleeps).toContain(30_000);
    expect(explorer.calls.filter((call) => call.key === explorer.calls[0]?.key)).toHaveLength(2);
    expect(rows()).toHaveLength(2);

    rmSync(cacheDir, { recursive: true });
    explorer.rateLimitFirst = 2;
    await expect(run({ color: "white" })).rejects.toBeInstanceOf(ExplorerError);
  });

  it("skips a position that already exists as an own-games puzzle", async () => {
    seedWhite();
    insertGeneratedPuzzle(db, {
      id: puzzleId(positionKey(AFTER_E4_E5)),
      source: "own-games",
      motif: "opening-white",
      difficulty: "beginner",
      fen: AFTER_E4_E5,
      solutionUci: ["g1f3"],
      solutionSan: ["Nf3"],
      explanation: "From 2 of your games.",
    });
    const result = await run({ color: "white" });
    expect(rows().map((row) => row.fen)).toEqual([AFTER_E4_C5]);
    expect(result).toMatchObject({ created: 1, skippedOwn: 1 });
  });

  it("stores no puzzle when the runner-up is within the clear gap", async () => {
    seedWhite();
    engine.gapByKey.set(positionKey(AFTER_E4_C5), 29);
    await run({ color: "white" });
    expect(rows().map((row) => row.fen)).toEqual([AFTER_E4_E5]);
  });

  it("stops at the ply limit", async () => {
    seedWhite();
    await run({ color: "white", maxPly: 2 });
    expect(explorer.calls).toHaveLength(1);
    expect(engine.searched).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("does not expand a position the explorer has under 200 games for", async () => {
    seedWhite();
    // 1.e4 c5 2.Nf3 holds 120 games, so only the e5 branch goes on to ply 6.
    await run({ color: "white", maxPly: 6 });
    expect(explorer.calls).toHaveLength(4);
    expect(explorer.calls.map((call) => call.key)).toContain(
      positionKey(fenAfter("e4", "c5", "Nf3")),
    );
  });

  it("shares the motif with own-games puzzles, so one opening drill serves both", async () => {
    seedWhite();
    insertGeneratedPuzzle(db, {
      id: "own:feedfacefeedface",
      source: "own-games",
      motif: "opening-white",
      difficulty: "beginner",
      fen: fenAfter("d4", "d5"),
      solutionUci: ["c2c4"],
      solutionSan: ["c4"],
      explanation: "From 1 of your games.",
    });
    await run({ color: "white" });
    const ids = listPuzzles(db, { motif: "opening-white" }).puzzles.map((p) => p.id);
    expect(ids.filter((id) => id.startsWith("own:"))).toHaveLength(1);
    expect(ids.filter((id) => id.startsWith("explorer:"))).toHaveLength(2);
  });

  it("leaves out a reply under the game floor", async () => {
    seedWhite();
    // c5 holds 250 games after 1.e4, below a floor of 300.
    await run({ color: "white", minGames: 300 });
    expect(rows().map((row) => row.fen)).toEqual([AFTER_E4_E5]);
  });

  it("honours a lower request budget by stopping and reporting it", async () => {
    seedWhite();
    const result = await run({ color: "white", maxRequests: 2 });
    expect(result).toMatchObject({ truncated: true, requests: 2 });
    expect(explorer.calls).toHaveLength(2);
    expect(existsSync(cacheDir)).toBe(true);
  });
});
