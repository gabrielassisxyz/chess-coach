import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrainingActivitySchema } from "@chess-coach/shared";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, FakeExplorer } from "../../test/fakes/fake-explorer.js";
import { TrainingRun } from "../activity/training.js";
import { composeServer } from "../compose.js";
import { type PlayerColor, setGrading } from "../db/games.js";
import { type Database, openDatabase } from "../db/open.js";
import { insertGeneratedPuzzle, recordPuzzleAttempt } from "../db/puzzles.js";
import { syncImportedRepertoireUnit } from "../db/repertoire-import.js";
import { createRepertoireVariation } from "../db/repertoires.js";
import { type Classification, classifyCpLoss } from "../engine/evaluate.js";
import { applyUci } from "../engine/moves.js";
import type { Searcher, SearchRequest, SearchResult } from "../engine/uci.js";
import type { EvaluateMove } from "../import/grader.js";
import { importFinishedGame } from "../import/pgn.js";
import { RecordingLog } from "../log.js";
import { contentDir } from "../paths.js";
import { seedPuzzles } from "../puzzles/seed.js";
import { ReviewDesk } from "../srs/review.js";
import { generateOpeningPuzzles, positionKey, puzzleId } from "./from-games.js";
import { NO_REPERTOIRE_BRANCH_BOOK } from "./from-repertoire.js";
import { NO_OPENING_NAMES, parseOpeningTable } from "./names.js";
import { readPgnRepertoire } from "./pgn-repertoire.js";
import { reviewRepertoireGame } from "./repertoire-review.js";

const WHITE_ONE =
  '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 1-0';
const WHITE_TWO =
  '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d3 d6 6. O-O O-O 7. Bb3 a6 8. Nbd2 Ba7 9. h3 h6 10. Re1 Re8 1-0';
const BLACK_ONE =
  '[Result "0-1"]\n\n1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 h6 7. Bh4 b6 8. Bxf6 Bxf6 9. cxd5 exd5 10. Bd3 Bb7 0-1';
// 42 plies, for a move well past the opening.
const LONG_WHITE =
  '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Na5 10. Bc2 c5 11. d4 Qc7 12. Nbd2 cxd4 13. cxd4 Nc6 14. Nb3 a5 15. Be3 a4 16. Nbd2 Bd7 17. Rc1 Qb7 18. Qe2 Rfe8 19. Bd3 Rac8 20. a3 Bf8 21. Bb1 h6 1-0';
// The knights go back and out again, so WHITE_ONE's position after 3...a6 comes at ply 11, not 7.
const SHUFFLED_WHITE =
  '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Ng1 Nb8 4. Nf3 Nc6 5. Bb5 a6 6. Ba4 Nf6 1-0';

function fenAfter(...sans: string[]): string {
  const game = new Chess();
  for (const san of sans) game.move(san);
  return game.fen();
}

const italianNames = parseOpeningTable(
  [
    "eco\tname\tpgn\tuci\tepd",
    `B00\tKing's Pawn Game\t1. e4\te2e4\t${positionKey(fenAfter("e4"))}`,
    `C50\tItalian Game\t1. e4 e5 2. Nf3 Nc6 3. Bc4\te2e4\t${positionKey(fenAfter("e4", "e5", "Nf3", "Nc6", "Bc4"))}`,
    "",
  ].join("\n"),
);

// Names on the line of a Black game only, so a name carried into the next game shows on a White
// game whose own line no name covers.
const queensGambitNames = parseOpeningTable(
  [
    "eco\tname\tpgn\tuci\tepd",
    `D06\tQueen's Gambit\t1. d4 d5 2. c4\td2d4\t${positionKey(fenAfter("d4", "d5", "c4"))}`,
    `D30\tQueen's Gambit Declined\t1. d4 d5 2. c4 e6\td2d4\t${positionKey(fenAfter("d4", "d5", "c4", "e6"))}`,
    "",
  ].join("\n"),
);

const uciOf = (move: { from: string; to: string; promotion?: string }): string =>
  `${move.from}${move.to}${move.promotion ?? ""}`;
const legalMoves = (fen: string): string[] => new Chess(fen).moves({ verbose: true }).map(uciOf);

/**
 * Answers each position with one line per entry of `below`, the centipawns that line scores under
 * the best, over the position's legal moves in chess.js order unless a key is given its own moves.
 */
class FakeEngine implements Searcher {
  readonly requests: SearchRequest[] = [];
  readonly belowByKey = new Map<string, number[]>();
  readonly movesByKey = new Map<string, string[]>();
  below = [0, 80];
  reached: Pick<SearchResult, "depth" | "cutByTime"> = {};

  get searched(): string[] {
    return this.requests.map((request) => positionKey(request.fen));
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    this.requests.push(request);
    const key = positionKey(request.fen);
    const moves = this.movesByKey.get(key) ?? legalMoves(request.fen);
    const below = (this.belowByKey.get(key) ?? this.below).slice(0, moves.length);
    const lines = below.map((gap, index) => ({
      moves: [moves[index] as string],
      score: 100 - gap,
    }));
    return { fen: request.fen, bestmove: lines[0]?.moves[0] ?? null, lines, ...this.reached };
  }
}

/** Holds every search until `open`, so another run can store the same position meanwhile. */
class HeldEngine extends FakeEngine {
  private open: () => void = () => {};
  private readonly gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });

  override async search(request: SearchRequest): Promise<SearchResult> {
    await this.gate;
    return super.search(request);
  }

  release(): void {
    this.open();
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

const DAY = (day: number): string => `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`;

function importGame(pgn: string, color: PlayerColor, sourceId: string, playedAt = DAY(1)): number {
  const gameId = importFinishedGame(db, {
    pgn,
    playerColor: color,
    source: "pgn",
    sourceId,
    playedAt,
  });
  if (gameId === null) throw new Error("fixture game was not imported");
  setGrading(db, gameId, "done");
  return gameId;
}

function grade(
  gameId: number,
  ply: number,
  classification: Classification,
  bestUci: string | null = null,
): void {
  db.prepare(
    "UPDATE moves SET classification = ?, best_move_uci = ? WHERE game_id = ? AND ply = ?",
  ).run(classification, bestUci, gameId, ply);
}

function gradeEveryStudentMove(gameId: number, classification: Classification): void {
  db.prepare("UPDATE moves SET classification = ? WHERE game_id = ? AND is_player = 1").run(
    classification,
    gameId,
  );
}

function moveAt(
  gameId: number,
  ply: number,
): { fen_before: string; fen_after: string; uci: string } {
  const row = db
    .prepare("SELECT fen_before, fen_after, uci FROM moves WHERE game_id = ? AND ply = ?")
    .get(gameId, ply) as { fen_before: string; fen_after: string; uci: string } | undefined;
  if (!row) throw new Error(`game ${gameId} has no ply ${ply}`);
  return row;
}

const fenBeforePly = (gameId: number, ply: number): string => moveAt(gameId, ply).fen_before;
const idOf = (fen: string): string => puzzleId(positionKey(fen));

interface FoundRow {
  id: string;
  fen: string;
  color: string;
  phase: string;
  from_mistake: number;
  from_repeat: number;
  from_departure: number;
  accepted_uci: string;
  listed: number;
  reached_games: number;
  best_games: number;
  last_reached_at: string;
  game_id: number;
  ply: number;
  first_found_at: string;
}

const foundRows = (): FoundRow[] =>
  db.prepare("SELECT * FROM found_positions ORDER BY id").all() as FoundRow[];

function foundAt(fen: string): FoundRow {
  const row = db.prepare("SELECT * FROM found_positions WHERE id = ?").get(idOf(fen));
  if (!row) throw new Error(`no found position for ${fen}`);
  return row as FoundRow;
}

const acceptedAt = (fen: string): string[] => JSON.parse(foundAt(fen).accepted_uci) as string[];

interface PuzzleRow {
  id: string;
  source: string;
  motif: string;
  difficulty: string;
  fen: string;
  solution_uci: string;
  solution_san: string;
  explanation: string;
  opening_name: string | null;
  difficulty_rating: number | null;
}

const ownPuzzles = (): PuzzleRow[] =>
  db.prepare("SELECT * FROM puzzles WHERE source = 'own-games' ORDER BY id").all() as PuzzleRow[];

const puzzleAt = (fen: string): PuzzleRow | undefined =>
  db.prepare("SELECT * FROM puzzles WHERE id = ?").get(idOf(fen)) as PuzzleRow | undefined;

// The rule reads the outcome and the ply of a review row, never which unit it names.
function addReview(gameId: number, outcome: string, leftPly: number | null): void {
  const unit = db.prepare("SELECT id FROM repertoires ORDER BY id LIMIT 1").get() as
    | { id: number }
    | undefined;
  const repertoireId =
    unit?.id ??
    createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "Classical Variation (4.c3)",
    }).id;
  db.prepare(
    `INSERT INTO repertoire_game_reviews
       (game_id, repertoire_id, reviewed_at, outcome, followed_plies, passed_moves, left_ply)
     VALUES (?, ?, 't', ?, 0, 0, ?)`,
  ).run(gameId, repertoireId, outcome, leftPly);
}

// A graded game of the student's moves alone, each from a position of its own and graded a mistake
// whose best move is the fake engine's first line: the rules read positions and plies, so a position
// deep in a game needs no game played up to it.
function storeStudentMoves(
  color: PlayerColor,
  moves: Array<{ ply: number; fen: string }>,
  playedAt = DAY(1),
): number {
  const game = db
    .prepare(
      `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase,
         result, termination, source, played_at, grading)
       VALUES (?, ?, ?, 800, ?, 'finished', '1-0', 'resign', 'pgn', ?, 'done') RETURNING id`,
    )
    .get(playedAt, playedAt, color, new Chess().fen(), playedAt) as { id: number };
  const insert = db.prepare(
    `INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after, is_player, classification,
       best_move_uci)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'mistake', ?)`,
  );
  for (const { ply, fen } of moves) {
    const [best, played] = legalMoves(fen) as [string, string];
    const board = new Chess(fen);
    const san = applyUci(board, played).san;
    insert.run(game.id, ply, san, played, fen, board.fen(), best);
  }
  return game.id;
}

describe("generateOpeningPuzzles: which positions are found", () => {
  it("records the position before an inaccuracy, a mistake or a blunder, at ply 12 and at ply 41 alike", async () => {
    const black = importGame(BLACK_ONE, "black", "b1");
    const long = importGame(LONG_WHITE, "white", "long");
    grade(black, 12, "inaccuracy");
    grade(long, 21, "mistake");
    grade(long, 41, "blunder");
    await generateOpeningPuzzles(db, new FakeEngine());
    expect(foundRows()).toHaveLength(3);
    expect(foundAt(fenBeforePly(black, 12))).toMatchObject({
      color: "black",
      from_mistake: 1,
      from_repeat: 0,
      from_departure: 0,
      game_id: black,
      ply: 12,
    });
    expect(foundAt(fenBeforePly(long, 21))).toMatchObject({ from_mistake: 1, ply: 21 });
    expect(foundAt(fenBeforePly(long, 41))).toMatchObject({
      color: "white",
      from_mistake: 1,
      game_id: long,
      ply: 41,
    });
  });

  it("records nothing for a good, great or best move at a position no other rule finds", async () => {
    const game = importGame(WHITE_ONE, "white", "w1");
    grade(game, 3, "good");
    grade(game, 5, "great");
    grade(game, 7, "best");
    const engine = new FakeEngine();
    const result = await generateOpeningPuzzles(db, engine);
    expect(foundRows()).toEqual([]);
    expect(engine.requests).toEqual([]);
    expect(result).toMatchObject({ candidates: 0, searched: 0 });
  });

  it("records a position two graded games reached with the student to move as a repeat, and none that one reached", async () => {
    importGame(WHITE_ONE, "white", "w1");
    importGame(WHITE_TWO, "white", "w2");
    await generateOpeningPuzzles(db, new FakeEngine());
    // The two games share 1.e4 e5 and 2.Nf3 Nc6, and nothing after it.
    const shared = [fenAfter("e4", "e5"), fenAfter("e4", "e5", "Nf3", "Nc6")];
    expect(foundRows().map((row) => row.id)).toEqual(shared.map(idOf).sort());
    for (const fen of shared) {
      expect(foundAt(fen)).toMatchObject({
        from_repeat: 1,
        from_mistake: 0,
        from_departure: 0,
        reached_games: 2,
      });
    }
  });

  it("counts a game that reached a position twice as one game", async () => {
    importGame(WHITE_ONE, "white", "w1");
    // Back at 2...Nc6 a second time at ply 9, after the knights went home.
    const shuffled = importGame(SHUFFLED_WHITE, "white", "shuffled");
    grade(shuffled, 5, "best");
    grade(shuffled, 9, "best");
    await generateOpeningPuzzles(db, new FakeEngine());
    expect(foundAt(fenAfter("e4", "e5", "Nf3", "Nc6"))).toMatchObject({
      reached_games: 2,
      best_games: 1,
    });
  });

  it("never records the position before ply 1, whatever the number of games or the move played there", async () => {
    for (const [pgn, id] of [
      [WHITE_ONE, "w1"],
      [WHITE_TWO, "w2"],
      [LONG_WHITE, "long"],
    ] as const) {
      grade(importGame(pgn, "white", id), 1, "blunder");
    }
    // This one is back at the starting position at ply 5, the only game there after ply 1.
    importGame('[Result "1-0"]\n\n1. Nf3 Nf6 2. Ng1 Ng8 3. e4 e5 1-0', "white", "back");
    await generateOpeningPuzzles(db, new FakeEngine());
    expect(foundRows().map((row) => row.id)).not.toContain(idOf(new Chess().fen()));
    // Reached with other move counters by the last game, 1.e4 e5 is the same position all the same.
    expect(foundAt(fenAfter("e4", "e5")).reached_games).toBe(4);
  });

  it.each<[string, number]>([
    ["not_reached", 4],
    ["reply_added", 8],
    ["reply_not_stored", 28],
  ])(
    "records the position after the opponent's move that left the unit on %s at ply %i",
    async (outcome, leftPly) => {
      const game = importGame(LONG_WHITE, "white", "long");
      addReview(game, outcome, leftPly);
      await generateOpeningPuzzles(db, new FakeEngine());
      const departure = moveAt(game, leftPly).fen_after;
      expect(foundRows().map((row) => row.id)).toEqual([idOf(departure)]);
      expect(foundAt(departure)).toMatchObject({
        from_departure: 1,
        from_mistake: 0,
        from_repeat: 0,
        game_id: game,
        ply: leftPly + 1,
      });
    },
  );

  it.each([
    ["a Black game", BLACK_ONE, "black", "reply_added", 9],
    ["an in_book review", LONG_WHITE, "white", "in_book", 8],
    ["a departed review", LONG_WHITE, "white", "departed", 7],
    ["not_reached on the student's own move", LONG_WHITE, "white", "not_reached", 5],
    ["a departure at ply 30", LONG_WHITE, "white", "reply_not_stored", 30],
  ] as const)("records no departure for %s", async (_case, pgn, color, outcome, leftPly) => {
    addReview(importGame(pgn, color, "game"), outcome, leftPly);
    await generateOpeningPuzzles(db, new FakeEngine());
    expect(foundRows()).toEqual([]);
  });

  it("stores the position after the opponent leaves an imported White line at ply 29 or earlier with from_departure set", async () => {
    const parsed = readPgnRepertoire("1. d4 d5 2. Bf4 Nc6 3. e3 *", "white");
    if (!parsed.moves) throw new Error("expected London fixture PGN to parse");
    const synced = syncImportedRepertoireUnit(
      db,
      { side: "white", group: "London System", variation: "Main lines" },
      parsed.moves,
      DAY(1),
      false,
    );
    expect(synced.ok).toBe(true);

    const game = importGame(
      '[Result "1-0"]\n\n1. d4 d5 2. Bf4 c5 3. e3 Nc6 4. c3 Nf6 1-0',
      "white",
      "london-departure",
    );
    const engine = new FakeEngine();
    const explorerClock = new FakeClock();
    const reviewed = await reviewRepertoireGame(
      {
        db,
        engine,
        fetcher: new FakeExplorer(explorerClock),
        cacheDir: join(tmp, "explorer-cache"),
        explorerClock,
        names: NO_OPENING_NAMES,
      },
      game,
    );
    expect(reviewed).toMatchObject({ gameId: game, outcome: "reply_not_stored" });

    await generateOpeningPuzzles(db, engine);
    const departure = moveAt(game, 4).fen_after;
    expect(foundRows().map((row) => row.id)).toEqual([idOf(departure)]);
    expect(foundAt(departure)).toMatchObject({
      from_departure: 1,
      from_mistake: 0,
      from_repeat: 0,
      game_id: game,
      ply: 5,
    });
  });

  it("finds mistakes and repeats in Black games and stores them for Black", async () => {
    const first = importGame(BLACK_ONE, "black", "b1");
    importGame('[Result "0-1"]\n\n1. d4 Nf6 2. c4 e6 0-1', "black", "b2");
    grade(first, 6, "mistake");
    await generateOpeningPuzzles(db, new FakeEngine());
    expect(foundAt(fenAfter("d4"))).toMatchObject({ color: "black", from_repeat: 1, ply: 2 });
    expect(foundAt(fenBeforePly(first, 6))).toMatchObject({ color: "black", from_mistake: 1 });
    expect(ownPuzzles().map((row) => row.motif)).toEqual(["opening-black", "opening-black"]);
  });

  it("makes one row with every flag for a position found as a mistake in one game and as a departure in another", async () => {
    const ruy = importGame(WHITE_ONE, "white", "w1");
    const italian = importGame(WHITE_TWO, "white", "w2");
    grade(ruy, 3, "mistake");
    addReview(italian, "not_reached", 2);
    await generateOpeningPuzzles(db, new FakeEngine());
    const both = fenAfter("e4", "e5");
    expect(foundRows().filter((row) => row.id === idOf(both))).toEqual([
      expect.objectContaining({ from_mistake: 1, from_departure: 1, from_repeat: 1 }),
    ]);
  });

  it("ignores a game that is not graded or not finished", async () => {
    const pending = importGame(WHITE_ONE, "white", "w1");
    setGrading(db, pending, "pending");
    grade(pending, 9, "blunder");
    const unfinished = importGame(WHITE_TWO, "white", "w2");
    db.prepare("UPDATE games SET finished_at = NULL WHERE id = ?").run(unfinished);
    grade(unfinished, 9, "blunder");
    await generateOpeningPuzzles(db, new FakeEngine());
    expect(foundRows()).toEqual([]);
  });
});

describe("generateOpeningPuzzles: the search and the list", () => {
  it("searches a new position once, at depth 16 with five lines and a 10 s cap, and keeps a result the cap cut as it came", async () => {
    const game = importGame(WHITE_ONE, "white", "w1");
    grade(game, 9, "mistake");
    const position = fenBeforePly(game, 9);
    const engine = new FakeEngine();
    engine.reached = { cutByTime: true, depth: 7 };
    engine.belowByKey.set(positionKey(position), [0, 12]);
    const result = await generateOpeningPuzzles(db, engine);
    expect(engine.requests).toEqual([{ fen: position, depth: 16, multipv: 5, capMs: 10_000 }]);
    expect(acceptedAt(position)).toEqual(legalMoves(position).slice(0, 2));
    expect(result).toMatchObject({ candidates: 1, searched: 1, listed: 1 });
  });

  it("accepts the first moves of the lines less than 30 cp below the best, the best first", async () => {
    const game = importGame(WHITE_ONE, "white", "w1");
    grade(game, 9, "mistake");
    const position = fenBeforePly(game, 9);
    const engine = new FakeEngine();
    engine.belowByKey.set(positionKey(position), [0, 10, 29, 30]);
    await generateOpeningPuzzles(db, engine);
    expect(acceptedAt(position)).toEqual(legalMoves(position).slice(0, 3));
  });

  it.each([1, 2, 3, 4])(
    "lists a mistake position with %i accepted moves that include the stored best move, as a puzzle answered by the first",
    async (count) => {
      const game = importGame(WHITE_ONE, "white", "w1");
      const position = fenBeforePly(game, 9);
      const legal = legalMoves(position);
      // The stored best move is the last one accepted, so it only has to be among them.
      grade(game, 9, "mistake", legal[count - 1] ?? null);
      const engine = new FakeEngine();
      engine.belowByKey.set(positionKey(position), [...[0, 5, 10, 15].slice(0, count), 80]);
      await generateOpeningPuzzles(db, engine);
      expect(foundAt(position)).toMatchObject({ listed: 1, from_mistake: 1 });
      expect(acceptedAt(position)).toHaveLength(count);
      const first = legal[0] as string;
      expect(puzzleAt(position)).toMatchObject({
        source: "own-games",
        motif: "opening-white",
        difficulty: "beginner",
        difficulty_rating: null,
        fen: position,
        solution_uci: JSON.stringify([first]),
        solution_san: JSON.stringify([applyUci(new Chess(position), first).san]),
      });
    },
  );

  it.each<[string, number[], number, boolean]>([
    ["five accepted moves", [0, 1, 2, 3, 4], 0, false],
    ["accepted moves without the stored best move", [0, 80], 5, false],
    ["the student's own move among the accepted ones", [0, 10], 0, true],
  ])(
    "leaves a mistake position with %s off the list, with no puzzle",
    async (_case, below, bestIndex, ownMoveAccepted) => {
      const game = importGame(WHITE_ONE, "white", "w1");
      const position = fenBeforePly(game, 9);
      const legal = legalMoves(position);
      grade(game, 9, "mistake", legal[bestIndex] ?? null);
      const engine = new FakeEngine();
      engine.belowByKey.set(positionKey(position), below);
      if (ownMoveAccepted) {
        engine.movesByKey.set(positionKey(position), [legal[0] as string, moveAt(game, 9).uci]);
      }
      await generateOpeningPuzzles(db, engine);
      expect(foundAt(position)).toMatchObject({ listed: 0, from_mistake: 1 });
      expect(puzzleAt(position)).toBeUndefined();
    },
  );

  it("leaves a departure off the list when the stored best move of the student's answer is not accepted", async () => {
    const game = importGame(LONG_WHITE, "white", "long");
    addReview(game, "reply_added", 8);
    const position = moveAt(game, 8).fen_after;
    grade(game, 9, "good", legalMoves(position)[3] ?? null);
    await generateOpeningPuzzles(db, new FakeEngine());
    expect(foundAt(position)).toMatchObject({ from_departure: 1, listed: 0 });
  });

  it.each([1, 2, 3, 4, 5])(
    "lists a repeat with %i accepted moves, as a puzzle answered by the first",
    async (count) => {
      importGame(WHITE_ONE, "white", "w1");
      importGame(WHITE_TWO, "white", "w2");
      const position = fenAfter("e4", "e5");
      const engine = new FakeEngine();
      engine.belowByKey.set(positionKey(position), [0, 1, 2, 3, 4].slice(0, count));
      await generateOpeningPuzzles(db, engine);
      expect(acceptedAt(position)).toHaveLength(count);
      expect(foundAt(position)).toMatchObject({ from_repeat: 1, listed: 1 });
      expect(puzzleAt(position)?.solution_uci).toBe(JSON.stringify([legalMoves(position)[0]]));
    },
  );

  it("lists nothing where the search finds no move", async () => {
    // Black is mated, and two games ended there with Black to move.
    const mate = '[Result "1-0"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';
    importGame(mate, "black", "m1");
    importGame(mate, "black", "m2");
    await generateOpeningPuzzles(db, new FakeEngine());
    const mated = fenAfter("e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#");
    expect(foundAt(mated)).toMatchObject({ from_repeat: 1, listed: 0, accepted_uci: "[]" });
    expect(puzzleAt(mated)).toBeUndefined();
  });

  it("writes the best move and the other accepted ones into the puzzle's explanation", async () => {
    const game = importGame(WHITE_ONE, "white", "w1");
    grade(game, 9, "mistake");
    const position = fenBeforePly(game, 9);
    const engine = new FakeEngine();
    engine.movesByKey.set(positionKey(position), ["a4b3", "f3e5", "d2d4"]);
    engine.belowByKey.set(positionKey(position), [0, 10, 40]);
    await generateOpeningPuzzles(db, engine);
    expect(puzzleAt(position)?.explanation).toBe("From your games. Best: Bb3. Also good: Nxe5.");
  });
});

describe("generateOpeningPuzzles: later runs", () => {
  it("makes no search on a second run over the same games and keeps the row count", async () => {
    const ruy = importGame(WHITE_ONE, "white", "w1");
    importGame(WHITE_TWO, "white", "w2");
    grade(ruy, 9, "mistake");
    grade(importGame(BLACK_ONE, "black", "b1"), 12, "blunder");
    const first = await generateOpeningPuzzles(db, new FakeEngine());
    const rows = foundRows();
    const engine = new FakeEngine();
    const second = await generateOpeningPuzzles(db, engine);
    expect(engine.requests).toEqual([]);
    expect(foundRows()).toEqual(rows);
    expect(second).toEqual({ ...first, searched: 0, created: 0 });
  });

  it("refreshes a stored position's counts and game when one more game reaches it, with no search for it", async () => {
    const ruy = importGame(WHITE_ONE, "white", "w1", DAY(1));
    addReview(ruy, "not_reached", 6);
    grade(ruy, 7, "good");
    await generateOpeningPuzzles(db, new FakeEngine());
    const position = fenBeforePly(ruy, 7);
    expect(foundAt(position)).toMatchObject({
      reached_games: 1,
      best_games: 0,
      last_reached_at: DAY(1),
      game_id: ruy,
      ply: 7,
    });

    const shuffled = importGame(SHUFFLED_WHITE, "white", "shuffled", DAY(5));
    grade(shuffled, 11, "best");
    const engine = new FakeEngine();
    await generateOpeningPuzzles(db, engine);
    expect(engine.searched).not.toContain(positionKey(position));
    expect(foundAt(position)).toMatchObject({
      reached_games: 2,
      best_games: 1,
      last_reached_at: DAY(5),
      game_id: shuffled,
      ply: 11,
      from_departure: 1,
      from_repeat: 1,
    });
  });

  it("lists a stored mistake position left off the list once a later game reaches it, with its puzzle and no search", async () => {
    const ruy = importGame(WHITE_ONE, "white", "w1", DAY(1));
    const position = fenBeforePly(ruy, 7);
    const legal = legalMoves(position);
    grade(ruy, 7, "mistake", legal[0] ?? null);
    const first = new FakeEngine();
    first.belowByKey.set(positionKey(position), [0, 1, 2, 3, 4]);
    await generateOpeningPuzzles(db, first);
    expect(foundAt(position)).toMatchObject({ listed: 0, from_repeat: 0 });
    expect(puzzleAt(position)).toBeUndefined();

    importGame(SHUFFLED_WHITE, "white", "shuffled", DAY(5));
    const second = new FakeEngine();
    await generateOpeningPuzzles(db, second);
    expect(second.searched).not.toContain(positionKey(position));
    expect(foundAt(position)).toMatchObject({ from_mistake: 1, from_repeat: 1, listed: 1 });
    expect(acceptedAt(position)).toEqual(legal.slice(0, 5));
    expect(puzzleAt(position)?.solution_uci).toBe(JSON.stringify([legal[0]]));
  });

  it("keeps the moves of the run that stored a position first when two runs overlap", async () => {
    grade(importGame(WHITE_ONE, "white", "w1"), 9, "mistake");
    const position = fenAfter("e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6");
    // The slow run's five moves would leave the position off the list; the stored one move lists it.
    const slow = new HeldEngine();
    slow.below = [0, 1, 2, 3, 4];
    const overtaken = generateOpeningPuzzles(db, slow);
    await generateOpeningPuzzles(db, new FakeEngine());
    slow.release();
    await expect(overtaken).resolves.toMatchObject({ candidates: 1, searched: 1, listed: 1 });
    expect(foundRows()).toHaveLength(1);
    expect(acceptedAt(position)).toEqual(legalMoves(position).slice(0, 1));
    expect(foundAt(position).listed).toBe(1);
  });

  it("keeps a stored position no rule finds any more, with its flags cleared, off the list", async () => {
    const ruy = importGame(WHITE_ONE, "white", "w1");
    const italian = importGame(WHITE_TWO, "white", "w2");
    await generateOpeningPuzzles(db, new FakeEngine());
    const repeated = fenAfter("e4", "e5");
    expect(foundAt(repeated)).toMatchObject({ from_repeat: 1, listed: 1 });

    db.prepare("DELETE FROM games WHERE id = ?").run(italian);
    const engine = new FakeEngine();
    await generateOpeningPuzzles(db, engine);
    expect(engine.requests).toEqual([]);
    expect(foundAt(repeated)).toMatchObject({
      from_mistake: 0,
      from_repeat: 0,
      from_departure: 0,
      listed: 0,
      reached_games: 1,
      game_id: ruy,
    });
    expect(puzzleAt(repeated)).toBeDefined();
  });
});

describe("generateOpeningPuzzles: what a row holds", () => {
  it("stores the phase from the ply and the pieces left, and the puzzle's motif from the phase and the colour", async () => {
    const opening14 = fenAfter(
      "d4",
      "d5",
      "c4",
      "e6",
      "Nc3",
      "Nf6",
      "Bg5",
      "Be7",
      "e3",
      "O-O",
      "Nf3",
    );
    const middlegame10 = "r1bq1rk1/pp3ppp/5n2/3p4/3P4/5N2/PP3PPP/R1BQ1RK1 w - - 0 21";
    const endgame6 = "r4rk1/pp3ppp/5n2/3p4/3P4/5N2/PP3PPP/R4RK1 w - - 0 11";
    const lateEndgame6 = "2r2rk1/pp3ppp/5n2/3p4/3P4/5N2/PP3PPP/2R2RK1 w - - 0 31";
    storeStudentMoves("black", [{ ply: 12, fen: opening14 }]);
    storeStudentMoves("white", [
      { ply: 41, fen: middlegame10 },
      { ply: 21, fen: endgame6 },
      { ply: 61, fen: lateEndgame6 },
    ]);
    await generateOpeningPuzzles(db, new FakeEngine());
    const phaseAndMotif = (fen: string) => [foundAt(fen).phase, puzzleAt(fen)?.motif];
    expect(phaseAndMotif(opening14)).toEqual(["opening", "opening-black"]);
    expect(phaseAndMotif(middlegame10)).toEqual(["middlegame", "middlegame-white"]);
    expect(phaseAndMotif(endgame6)).toEqual(["endgame", "endgame-white"]);
    expect(phaseAndMotif(lateEndgame6)).toEqual(["endgame", "endgame-white"]);
  });

  it("takes the phase of a position reached at several plies from the lowest", async () => {
    const position = "r1bq1rk1/pp3ppp/5n2/3p4/3P4/5N2/PP3PPP/R1BQ1RK1 w - - 0 21";
    storeStudentMoves("white", [{ ply: 41, fen: position }], DAY(1));
    storeStudentMoves("white", [{ ply: 29, fen: position }], DAY(2));
    await generateOpeningPuzzles(db, new FakeEngine());
    expect(foundAt(position).phase).toBe("opening");
  });

  it("shows the most recent game with a mistake at the position, else the most recent game that reached it", async () => {
    // The newest game is stored first, so a game told apart by its id rather than its date shows.
    const newest = importGame(WHITE_ONE, "white", "newest", DAY(10));
    const oldest = importGame(WHITE_TWO, "white", "oldest", DAY(3));
    const middle = importGame(LONG_WHITE, "white", "middle", DAY(7));
    grade(oldest, 3, "mistake");
    grade(middle, 3, "blunder");
    grade(newest, 3, "best");
    await generateOpeningPuzzles(db, new FakeEngine());
    expect(foundAt(fenAfter("e4", "e5"))).toMatchObject({
      game_id: middle,
      ply: 3,
      reached_games: 3,
      best_games: 1,
      last_reached_at: DAY(10),
    });
    expect(foundAt(fenAfter("e4", "e5", "Nf3", "Nc6"))).toMatchObject({
      game_id: newest,
      ply: 5,
      best_games: 0,
    });
  });

  it("dates a game by when it was played, else by when it finished", async () => {
    const played = importGame(WHITE_ONE, "white", "played", DAY(2));
    const finished = importGame(WHITE_TWO, "white", "finished", DAY(1));
    db.prepare("UPDATE games SET played_at = NULL, finished_at = ? WHERE id = ?").run(
      DAY(4),
      finished,
    );
    await generateOpeningPuzzles(db, new FakeEngine());
    expect(foundAt(fenAfter("e4", "e5"))).toMatchObject({
      last_reached_at: DAY(4),
      game_id: finished,
    });
    db.prepare(
      "UPDATE games SET played_at = NULL, finished_at = ?, started_at = ? WHERE id = ?",
    ).run(DAY(1), DAY(1), finished);
    db.prepare("UPDATE games SET played_at = NULL, started_at = ? WHERE id = ?").run(
      DAY(9),
      played,
    );
    await generateOpeningPuzzles(db, new FakeEngine());
    expect(foundAt(fenAfter("e4", "e5"))).toMatchObject({
      last_reached_at: DAY(2),
      game_id: played,
    });
  });
});

describe("generateOpeningPuzzles: puzzles", () => {
  it("creates no own: puzzle for a move outside the three rules and leaves the stored own: puzzles and their attempts as they were", async () => {
    const ruy = importGame(WHITE_ONE, "white", "w1");
    const italian = importGame(WHITE_TWO, "white", "w2");
    gradeEveryStudentMove(ruy, "good");
    gradeEveryStudentMove(italian, "great");
    // Stored by the rule before this one: a position no rule finds now, and a repeat with another answer.
    const outside = fenBeforePly(ruy, 9);
    const repeated = fenAfter("e4", "e5", "Nf3", "Nc6");
    for (const [fen, uci, san] of [
      [outside, "e1g1", "O-O"],
      [repeated, "f1c4", "Bc4"],
    ] as const) {
      insertGeneratedPuzzle(db, {
        id: idOf(fen),
        source: "own-games",
        motif: "opening-white",
        difficulty: "beginner",
        fen,
        solutionUci: [uci],
        solutionSan: [san],
        explanation: "From 1 of your games. Best: it.",
      });
      recordPuzzleAttempt(db, {
        puzzleId: idOf(fen),
        attemptedAt: DAY(1),
        solved: false,
        answered: ["a2a3"],
        failedPly: 0,
        firstTry: false,
        tries: 1,
        gaveUp: true,
      });
    }
    const stored = ownPuzzles();
    const attempts = () => db.prepare("SELECT * FROM puzzle_attempts ORDER BY id").all();
    const attemptsBefore = attempts();

    const result = await generateOpeningPuzzles(db, new FakeEngine());
    // The one puzzle written is the other shared position's, and a stored id is never written over.
    expect(result.created).toBe(1);
    expect(ownPuzzles().map((row) => row.id)).toEqual(
      [...stored.map((row) => row.id), idOf(fenAfter("e4", "e5"))].sort(),
    );
    for (const row of stored) expect(ownPuzzles()).toContainEqual(row);
    expect(attempts()).toEqual(attemptsBefore);
  });

  it("stores the deepest named position before each puzzle, even after the line leaves it", async () => {
    gradeEveryStudentMove(importGame(WHITE_TWO, "white", "italian"), "inaccuracy");
    await generateOpeningPuzzles(db, new FakeEngine(), italianNames);
    expect(puzzleAt(new Chess().fen())).toBeUndefined();
    expect(puzzleAt(fenAfter("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"))?.opening_name).toBe(
      "Italian Game",
    );
    expect(
      puzzleAt(fenAfter("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6"))?.opening_name,
    ).toBe("Italian Game");
    expect(puzzleAt(fenAfter("e4", "e5"))?.opening_name).toBe("King's Pawn Game");
  });

  it("starts each game's line with no name, so a puzzle never carries the one the game before it ended on", async () => {
    // The Black game is stored first and ends in the Queen's Gambit Declined; no name covers the
    // White game's line.
    gradeEveryStudentMove(importGame(BLACK_ONE, "black", "queens-gambit"), "inaccuracy");
    const flank = '[Result "1-0"]\n\n1. Nf3 Nf6 2. g3 g6 3. Bg2 Bg7 4. O-O O-O 1-0';
    gradeEveryStudentMove(importGame(flank, "white", "flank"), "inaccuracy");
    await generateOpeningPuzzles(db, new FakeEngine(), queensGambitNames);
    const namesOf = (motif: string): Set<string | null> =>
      new Set(
        ownPuzzles()
          .filter((row) => row.motif === motif)
          .map((row) => row.opening_name),
      );
    expect(namesOf("opening-black")).toEqual(
      new Set([null, "Queen's Gambit", "Queen's Gambit Declined"]),
    );
    expect(namesOf("opening-white")).toEqual(new Set([null]));
  });

  it("serves the stored name on the practice item", async () => {
    gradeEveryStudentMove(importGame(WHITE_TWO, "white", "italian"), "inaccuracy");
    await generateOpeningPuzzles(db, new FakeEngine(), italianNames);
    const target = puzzleAt(fenAfter("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"));
    if (!target) throw new Error("Italian drill was not generated");
    const run = TrainingRun.beginWith(
      { db, desk: new ReviewDesk({ db }) },
      { kind: "puzzle", id: target.id },
    );
    const item = TrainingActivitySchema.parse(run.state(1)).item;
    expect(item).toMatchObject({ kind: "puzzle", opening_name: "Italian Game" });
  });

  it("migrates puzzles with a nullable opening name", () => {
    const columns = db.pragma("table_info(puzzles)") as Array<{ name: string; notnull: number }>;
    const column = columns.find((row) => row.name === "opening_name");
    expect(column?.notnull).toBe(0);
  });

  it("leaves generated rows alone when the content is seeded again", async () => {
    gradeEveryStudentMove(importGame(WHITE_ONE, "white", "w1"), "mistake");
    await generateOpeningPuzzles(db, new FakeEngine());
    const stored = ownPuzzles();
    expect(stored.length).toBeGreaterThan(0);
    seedPuzzles(db, contentDir());
    seedPuzzles(db, contentDir());
    expect(ownPuzzles()).toEqual(stored);
  });
});

describe("generateOpeningPuzzles in the composed server", () => {
  // Grades the listed moves of a position as mistakes and every other move as accurate.
  const evaluateMistakes =
    (mistakes: ReadonlySet<string>): EvaluateMove =>
    async (fenBefore, moveUci) => {
      const cpLoss = mistakes.has(`${positionKey(fenBefore)} ${moveUci}`) ? 200 : 5;
      return {
        evalBeforeCp: 20,
        evalAfterCp: 20 - cpLoss,
        cpLoss,
        classification: classifyCpLoss(cpLoss),
        bestMoveUci: null,
        bestMoveSan: null,
      };
    };

  function compose(engine: Searcher, evaluate: EvaluateMove, log = new RecordingLog()) {
    const explorerClock = new FakeClock();
    return composeServer({
      db,
      openingNames: NO_OPENING_NAMES,
      repertoireBranches: NO_REPERTOIRE_BRANCH_BOOK,
      cacheDir: join(tmp, "explorer-cache"),
      engine,
      fetcherFor: () => new FakeExplorer(explorerClock),
      explorerClock,
      evaluate,
      log,
    });
  }

  it("records a game's positions as soon as the grader finishes it, game after game", async () => {
    const ruyPosition = fenAfter("e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6");
    const queensPosition = fenAfter(
      "d4",
      "d5",
      "c4",
      "e6",
      "Nc3",
      "Nf6",
      "Bg5",
      "Be7",
      "e3",
      "O-O",
      "Nf3",
    );
    const mistakes = new Set([
      `${positionKey(ruyPosition)} e1g1`,
      `${positionKey(queensPosition)} h7h6`,
    ]);
    const { app, grader } = compose(new FakeEngine(), evaluateMistakes(mistakes));
    importFinishedGame(db, { pgn: WHITE_ONE, playerColor: "white", source: "pgn", sourceId: "w1" });
    grader.kick();
    await grader.idle();
    expect(foundRows().map((row) => row.id)).toEqual([idOf(ruyPosition)]);

    importFinishedGame(db, { pgn: BLACK_ONE, playerColor: "black", source: "pgn", sourceId: "b1" });
    grader.kick();
    await grader.idle();
    await app.close();
    expect(foundRows().map((row) => row.id)).toEqual(
      [idOf(ruyPosition), idOf(queensPosition)].sort(),
    );
  });

  it("reruns over every graded game on POST /api/openings/generate and logs the run's counts", async () => {
    const log = new RecordingLog();
    const engine = new FakeEngine();
    const { app } = compose(engine, evaluateMistakes(new Set()), log);
    const ruy = importGame(WHITE_ONE, "white", "w1");
    const italian = importGame(WHITE_TWO, "white", "w2");
    for (const ply of [9, 11, 13]) grade(ruy, ply, "mistake");
    addReview(italian, "not_reached", 6);
    const departure = moveAt(italian, 6).fen_after;
    engine.belowByKey.set(positionKey(departure), [0, 1, 2, 3, 4]);

    const response = await app.inject({
      method: "POST",
      url: "/api/openings/generate",
      payload: { sources: ["own"] },
    });
    await app.close();
    // Two shared positions, three mistakes and one departure that the five moves leave off the list.
    const counts = {
      candidates: 6,
      listed: 5,
      fromMistake: 3,
      fromRepeat: 2,
      fromDeparture: 1,
      searched: 6,
      created: 5,
    };
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ own: counts });
    expect(log.named("openings.generate")[0]?.fields).toMatchObject({
      sources: ["own"],
      result: { own: counts },
    });
    expect(foundAt(fenBeforePly(ruy, 13)).game_id).toBe(ruy);
    expect(foundAt(departure).game_id).toBe(italian);
  });
});

describe("seedPuzzles with opening names", () => {
  it("names only exact opening_db positions and updates previously seeded rows", () => {
    const root = join(tmp, "seed-content");
    mkdirSync(join(root, "puzzles"), { recursive: true });
    const namedFen = fenAfter("e4", "e5", "Nf3", "Nc6", "Bc4");
    const laterFen = fenAfter("e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5");
    const entry = (fen: string, move: string, source: string) => ({
      fen,
      solution_moves: [move],
      solution_san: [],
      motif: "opening",
      difficulty: "beginner",
      explanation: "Find the move.",
      source,
    });
    writeFileSync(
      join(root, "puzzles", "seed.json"),
      JSON.stringify([
        entry(namedFen, "f8c5", "opening_db"),
        entry(laterFen, "c2c3", "opening_db"),
        entry(namedFen, "f8c5", "test"),
      ]),
    );

    expect(seedPuzzles(db, root)).toEqual({ inserted: 3, updated: 0, unchanged: 0 });
    const secondSeed = seedPuzzles(db, root, italianNames);
    const seeded = db
      .prepare("SELECT id, opening_name FROM puzzles WHERE id LIKE 'seed:%' ORDER BY id")
      .all();
    expect(seeded).toEqual([
      { id: "seed:0", opening_name: "Italian Game" },
      { id: "seed:1", opening_name: null },
      { id: "seed:2", opening_name: null },
    ]);
    expect(secondSeed).toEqual({ inserted: 0, updated: 1, unchanged: 2 });
  });
});
