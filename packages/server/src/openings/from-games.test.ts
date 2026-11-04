import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMoves, setGrading } from "../db/games.js";
import { type Database, openDatabase } from "../db/open.js";
import { classifyCpLoss } from "../engine/evaluate.js";
import { applyUci } from "../engine/moves.js";
import type { Searcher, SearchRequest, SearchResult } from "../engine/uci.js";
import { importFinishedGame } from "../import/pgn.js";
import { contentDir } from "../paths.js";
import { seedPuzzles } from "../puzzles/seed.js";
import { generateOpeningPuzzles, MIN_CLEAR_GAP_CP } from "./from-games.js";

const WHITE_ONE =
  '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 1-0';
const WHITE_TWO =
  '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3 d6 6. O-O O-O 7. Bb3 a6 8. Nbd2 Ba7 9. h3 h6 10. Re1 Re8 1-0';
const BLACK_ONE =
  '[Result "0-1"]\n\n1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 h6 7. Bh4 b6 8. Bxf6 Bxf6 9. cxd5 exd5 10. Bd3 Bb7 0-1';

const fenKey = (fen: string): string => fen.split(" ").slice(0, 4).join(" ");

/** Answers every position with its first two legal moves, a fixed gap apart unless told otherwise. */
class FakeEngine implements Searcher {
  readonly searched: string[] = [];
  readonly gapByKey = new Map<string, number>();
  gap = 80;

  async search(request: SearchRequest): Promise<SearchResult> {
    this.searched.push(fenKey(request.fen));
    const position = new Chess(request.fen);
    const [first, second] = position.moves({ verbose: true });
    if (!first || !second) throw new Error("fixture position has fewer than two moves");
    const uci = (m: { from: string; to: string }) => `${m.from}${m.to}`;
    const gap = this.gapByKey.get(fenKey(request.fen)) ?? this.gap;
    applyUci(position, uci(first));
    const next = position.moves({ verbose: true })[0];
    return {
      fen: request.fen,
      bestmove: uci(first),
      lines: [
        { moves: [uci(first), ...(next ? [uci(next)] : [])], score: 100 },
        { moves: [uci(second)], score: 100 - gap },
      ],
    };
  }
}

let tmp: string;
let db: Database;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-openings-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function addGame(pgn: string, color: "white" | "black", id: string, grading = "done"): number {
  const gameId = importFinishedGame(db, { pgn, playerColor: color, source: "pgn", sourceId: id });
  if (gameId === null) throw new Error("fixture game was not imported");
  setGrading(db, gameId, grading as "done");
  return gameId;
}

const rows = () =>
  db.prepare("SELECT * FROM puzzles WHERE source = 'own-games' ORDER BY id").all() as Array<{
    id: string;
    motif: string;
    fen: string;
    difficulty: string;
    solution_uci: string;
    solution_san: string;
    explanation: string;
  }>;

function seedFixtureGames(): void {
  addGame(WHITE_ONE, "white", "w1");
  addGame(WHITE_TWO, "white", "w2");
  addGame(BLACK_ONE, "black", "b1");
}

describe("generateOpeningPuzzles", () => {
  it("makes one puzzle per distinct student-to-move position, by colour", async () => {
    seedFixtureGames();
    const result = await generateOpeningPuzzles(db, new FakeEngine());
    // Ten white plies per white game with three shared positions, plus ten black plies.
    expect(result).toEqual({ positions: 27, created: 27, updated: 0 });
    const all = rows();
    expect(all).toHaveLength(27);
    expect(all.filter((r) => r.motif === "opening-white")).toHaveLength(17);
    expect(all.filter((r) => r.motif === "opening-black")).toHaveLength(10);
    expect(all.every((r) => /^own:[0-9a-f]{16}$/.test(r.id))).toBe(true);
    expect(all.every((r) => r.difficulty === "beginner")).toBe(true);
    for (const row of all) {
      const turn = row.fen.split(" ")[1];
      expect(row.motif).toBe(turn === "w" ? "opening-white" : "opening-black");
      expect(JSON.parse(row.solution_uci)).toHaveLength(1);
    }
  });

  it("writes the game count, best move and engine line into the explanation", async () => {
    seedFixtureGames();
    await generateOpeningPuzzles(db, new FakeEngine());
    const start = rows().find((r) => fenKey(r.fen) === fenKey(new Chess().fen()));
    expect(start?.explanation).toBe("From 2 of your games. Best: a3. Engine line: a3 Nc6.");
    expect(JSON.parse(start?.solution_san ?? "[]")).toEqual(["a3"]);
    const lone = rows().find((r) => r.explanation.startsWith("From 1 of your games."));
    expect(lone).toBeDefined();
  });

  it("treats a position reached with different move counters as the same one", async () => {
    addGame(WHITE_ONE, "white", "w1");
    addGame('[Result "1-0"]\n\n1. Nf3 Nf6 2. Ng1 Ng8 3. e4 e5 1-0', "white", "shuffle");
    const result = await generateOpeningPuzzles(db, new FakeEngine());
    expect(result.positions).toBe(11);
    expect(rows().find((r) => r.fen === new Chess().fen())?.explanation).toMatch(/^From 2 of/);
  });

  it("skips a position whose top two moves are within the gap", async () => {
    seedFixtureGames();
    const engine = new FakeEngine();
    engine.gapByKey.set(fenKey(new Chess().fen()), MIN_CLEAR_GAP_CP - 20);
    const result = await generateOpeningPuzzles(db, engine);
    expect(result.positions).toBe(27);
    expect(result.created).toBe(26);
    expect(rows().some((r) => fenKey(r.fen) === fenKey(new Chess().fen()))).toBe(false);
  });

  it("keeps a position exactly at the gap threshold", async () => {
    addGame(WHITE_ONE, "white", "w1");
    const engine = new FakeEngine();
    engine.gap = MIN_CLEAR_GAP_CP;
    expect((await generateOpeningPuzzles(db, engine)).created).toBe(10);
  });

  it("updates the game count on a second run without searching again or creating rows", async () => {
    addGame(WHITE_ONE, "white", "w1");
    const first = new FakeEngine();
    await generateOpeningPuzzles(db, first);
    expect(rows().every((r) => r.explanation.startsWith("From 1 of your games."))).toBe(true);
    addGame(WHITE_TWO, "white", "w2");
    const second = new FakeEngine();
    const result = await generateOpeningPuzzles(db, second);
    expect(result).toEqual({ positions: 17, created: 7, updated: 3 });
    expect(rows()).toHaveLength(17);
    expect(rows().filter((r) => r.explanation.startsWith("From 2 of your games."))).toHaveLength(3);
    expect(second.searched).toHaveLength(7);
    const third = await generateOpeningPuzzles(db, new FakeEngine());
    expect(third).toEqual({ positions: 17, created: 0, updated: 0 });
  });

  it("ignores games that are not graded and plies past move 15", async () => {
    addGame(WHITE_ONE, "white", "w1", "pending");
    expect((await generateOpeningPuzzles(db, new FakeEngine())).positions).toBe(0);
    setGrading(db, 1, "done");
    db.prepare("UPDATE moves SET ply = ply + 30 WHERE game_id = 1 AND ply > 9").run();
    expect((await generateOpeningPuzzles(db, new FakeEngine())).positions).toBe(5);
  });

  it("skips a position when the stored best move disagrees with the search", async () => {
    const id = addGame(WHITE_ONE, "white", "w1");
    const first = listMoves(db, id)[0];
    db.prepare(
      "UPDATE moves SET best_move_uci = 'e2e4', cp_loss = 0, classification = ? WHERE id = ?",
    ).run(classifyCpLoss(0), first?.id);
    const result = await generateOpeningPuzzles(db, new FakeEngine());
    expect(result.created).toBe(9);
  });

  it("leaves generated rows alone when the content is seeded again", async () => {
    addGame(WHITE_ONE, "white", "w1");
    await generateOpeningPuzzles(db, new FakeEngine());
    const before = rows();
    seedPuzzles(db, contentDir());
    seedPuzzles(db, contentDir());
    expect(rows()).toEqual(before);
  });
});
