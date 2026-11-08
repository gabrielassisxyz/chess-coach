import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "../clock.js";
import { type Database, openDatabase } from "../db/open.js";
import { RecordingLog } from "../log.js";
import { importLichessPuzzles, parseCsvLine, pickMotif } from "./lichess-import.js";

const HEADER =
  "PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate";

// Sample 00sHx is the one on the Lichess puzzle page; the others are real rows with the themes
// and popularity edited to reach each branch.
const MATE = [
  "00sHx",
  "q3k1nr/1pp1nQpp/3p4/1P2p3/4P3/B1PP1b2/B5PP/5K2 b k - 0 17",
  "e8d7 a2e6 d7d8 f7f8",
  "1498",
  "76",
  "87",
  "178",
  "mate mateIn2 middlegame short",
  "https://lichess.org/game/yyznGmXs/black#34",
  "Italian_Game Italian_Game_Classical_Variation",
  "",
].join(",");
const SKEWER_AND_FORK = [
  "0000D",
  "5rk1/1p3ppp/pq3b2/8/8/1P1Q1N2/P4PPP/3R2K1 w - - 2 27",
  "d3d6 f8d8 d6d8 f6d8",
  "1433",
  "75",
  "96",
  "37700",
  "advantage fork skewer short",
  "https://lichess.org/game/F8M8OS71#53",
  "",
  "",
].join(",");
const UNMAPPED_NEGATIVE = [
  "00008",
  "r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24",
  "f2g3 e6e7 b2b1 b3c1 b1c1 h6c1",
  "1819",
  "77",
  "-12",
  "10446",
  "crushing hangingPiece long middlegame",
  "https://lichess.org/game/787zsVup/black#48",
  "",
  "",
].join(",");
const FORK_SACRIFICE = [
  "0000H",
  "r4rk1/pp3ppp/8/2bqp2b/3N4/P2Bn2P/1PPN1P2/R1BQ1RK1 w - - 1 15",
  "d1h5 d5g2",
  "1032",
  "78",
  "100",
  "92",
  "fork sacrifice",
  "https://lichess.org/game/EwHRkfas#29",
  "French_Defense",
  "",
].join(",");
const ILLEGAL_MOVE = [
  "0bad1",
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "e2e5 e7e5 d1h5",
  "1500",
  "80",
  "50",
  "10",
  "fork",
  "https://lichess.org/game/none",
  "",
  "",
].join(",");
const TOO_FEW_FIELDS = "0bad2,rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1,e2e4";

const FIXTURE = [
  HEADER,
  MATE,
  SKEWER_AND_FORK,
  UNMAPPED_NEGATIVE,
  FORK_SACRIFICE,
  ILLEGAL_MOVE,
  TOO_FEW_FIELDS,
];

async function* linesOf(rows: readonly string[]): AsyncGenerator<string> {
  for (const row of rows) yield row;
}

const fixedClock: Clock = { now: () => new Date("2026-01-01T00:00:00Z") };

let tmp: string;
let db: Database;
let log: RecordingLog;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-lichess-"));
  db = openDatabase(tmp);
  log = new RecordingLog();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const run = (rows: readonly string[] = FIXTURE, batchSize = 5000) =>
  importLichessPuzzles({ lines: linesOf(rows), db, clock: fixedClock, log, batchSize });

interface StoredRow {
  id: string;
  source: string;
  motif: string;
  difficulty: string;
  fen: string;
  solution_uci: string;
  solution_san: string;
  explanation: string;
  lichess_id: string;
  difficulty_rating: number;
  popularity: number;
  plays: number;
  rating_deviation: number;
  themes: string;
  opening_tags: string;
  game_url: string;
}

const stored = (puzzleId: string): StoredRow =>
  db.prepare("SELECT * FROM puzzles WHERE id = ?").get(`lichess-db:${puzzleId}`) as StoredRow;

const count = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("parseCsvLine", () => {
  it("splits plain fields and keeps empty ones", () => {
    expect(parseCsvLine("a,b,,d")).toEqual(["a", "b", "", "d"]);
  });

  it("keeps a comma and a doubled quote inside a quoted field", () => {
    expect(parseCsvLine('a,"b,c","say ""x""",d')).toEqual(["a", "b,c", 'say "x"', "d"]);
  });
});

describe("pickMotif", () => {
  it("takes the rarest qualifying motif, so fork and skewer give skewer", () => {
    expect(pickMotif(["fork", "skewer"])).toBe("skewer");
    expect(pickMotif(["pin", "fork"])).toBe("pin");
    expect(pickMotif(["endgame", "mate"])).toBe("checkmate");
    expect(pickMotif(["underPromotion"])).toBe("promotion");
    expect(pickMotif(["backRankMate", "mate"])).toBe("back_rank_mate");
  });

  it("falls back to tactics when no theme maps", () => {
    expect(pickMotif(["crushing", "hangingPiece", "long"])).toBe("tactics");
    expect(pickMotif([])).toBe("tactics");
  });
});

describe("importLichessPuzzles", () => {
  it("counts rows added, skipped and failed", async () => {
    expect(await run()).toEqual({ added: 4, skipped: 0, failed: 2 });
    expect(count("puzzles")).toBe(4);
  });

  it("stores the position after the setup move and the solution from the second move", async () => {
    await run();
    const row = stored("00sHx");
    expect(row.fen).toBe("q5nr/1ppknQpp/3p4/1P2p3/4P3/B1PP1b2/B5PP/5K2 w - - 1 18");
    expect(JSON.parse(row.solution_uci)).toEqual(["a2e6", "d7d8", "f7f8"]);
    expect(JSON.parse(row.solution_san)).toEqual(["Be6+", "Kd8", "Qf8#"]);
  });

  it("fills the row shape from the CSV", async () => {
    await run();
    expect(stored("00sHx")).toMatchObject({
      id: "lichess-db:00sHx",
      source: "lichess-db",
      motif: "checkmate",
      difficulty: "intermediate",
      lichess_id: "00sHx",
      difficulty_rating: 1498,
      rating_deviation: 76,
      popularity: 87,
      plays: 178,
      themes: "mate mateIn2 middlegame short",
      opening_tags: "Italian_Game Italian_Game_Classical_Variation",
      game_url: "https://lichess.org/game/yyznGmXs/black#34",
    });
    expect(stored("00sHx").explanation).not.toBe("");
    expect(stored("0000H").difficulty).toBe("beginner");
    expect(stored("00008").difficulty).toBe("advanced");
  });

  it("files a puzzle with both fork and skewer under skewer", async () => {
    await run();
    expect(stored("0000D").motif).toBe("skewer");
  });

  it("gives a puzzle with no mapped theme the tactics motif and keeps negative popularity", async () => {
    await run();
    expect(stored("00008")).toMatchObject({ motif: "tactics", popularity: -12 });
  });

  it("writes one puzzle_themes row per theme at the puzzle's rating", async () => {
    await run();
    const rows = db
      .prepare(
        "SELECT theme, rating, puzzle_id FROM puzzle_themes WHERE puzzle_id = ? ORDER BY theme",
      )
      .all("lichess-db:0000H");
    expect(rows).toEqual([
      { theme: "fork", rating: 1032, puzzle_id: "lichess-db:0000H" },
      { theme: "sacrifice", rating: 1032, puzzle_id: "lichess-db:0000H" },
    ]);
    expect(count("puzzle_themes")).toBe(14);
  });

  it("skips a row that fails to replay and goes on to the next", async () => {
    await run([HEADER, ILLEGAL_MOVE, MATE]);
    expect(count("puzzles")).toBe(1);
    expect(log.named("import_lichess.done")[0]?.fields).toMatchObject({ added: 1, failed: 1 });
  });

  it("skips a PuzzleId already stored as a lichess_id", async () => {
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation, lichess_id)
       VALUES ('lichess-12', 'lichess', 'fork', 'beginner', 'x', '[]', '[]', 'why', '00sHx')`,
    ).run();
    expect(await run([HEADER, MATE, FORK_SACRIFICE])).toEqual({ added: 1, skipped: 1, failed: 0 });
    expect(count("puzzles")).toBe(2);
    expect(count("puzzle_themes")).toBe(2);
  });

  it("adds nothing on a second run", async () => {
    await run();
    expect(await run()).toEqual({ added: 0, skipped: 4, failed: 2 });
    expect(count("puzzles")).toBe(4);
    expect(count("puzzle_themes")).toBe(14);
  });

  it("leaves a stored id alone when only the new id collides", async () => {
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
       VALUES ('lichess-db:00sHx', 'x', 'fork', 'beginner', 'x', '[]', '[]', 'why')`,
    ).run();
    expect(await run([HEADER, MATE])).toEqual({ added: 0, skipped: 1, failed: 0 });
    expect(count("puzzle_themes")).toBe(0);
  });

  it("commits in batches and reports progress", async () => {
    const result = await run(FIXTURE, 2);
    expect(result.added).toBe(4);
    expect(count("puzzles")).toBe(4);
  });

  it("logs a progress event per 100000 rows and a done event with the counts", async () => {
    await run();
    expect(log.named("import_lichess.progress")).toEqual([]);
    const done = log.named("import_lichess.done");
    expect(done).toHaveLength(1);
    expect(done[0]?.fields).toMatchObject({ added: 4, skipped: 0, failed: 2, duration_ms: 0 });
  });

  it("emits progress when the row count crosses a multiple of 100000", async () => {
    const rows = [HEADER];
    for (let i = 0; i < 100_000; i += 1) rows.push(TOO_FEW_FIELDS);
    await run(rows);
    expect(log.named("import_lichess.progress")).toHaveLength(1);
    expect(log.named("import_lichess.progress")[0]?.fields).toMatchObject({ rows: 100_000 });
  });
});
