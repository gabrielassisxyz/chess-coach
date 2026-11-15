import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeServer } from "../src/compose.js";
import { type Database, openDatabase } from "../src/db/open.js";
import {
  createRepertoireVariation,
  insertRepertoireOwnMove,
  REPERTOIRE_REBUILD_GROUP_SUFFIX,
  upsertRepertoireReply,
} from "../src/db/repertoires.js";
import { classifyCpLoss } from "../src/engine/evaluate.js";
import type { Searcher, SearchRequest, SearchResult } from "../src/engine/uci.js";
import type { EvaluateMove } from "../src/import/grader.js";
import { importFinishedGame } from "../src/import/pgn.js";
import { RecordingLog } from "../src/log.js";
import { positionKey } from "../src/openings/from-games.js";
import {
  loadRepertoireBranchBook,
  REPERTOIRE_GROUP_ITALIAN,
} from "../src/openings/from-repertoire.js";
import { loadOpeningNames } from "../src/openings/names.js";
import { contentDir } from "../src/paths.js";
import { FakeClock, FakeExplorer } from "./fakes/fake-explorer.js";

const ITALIAN_LINE = ["e4", "e5", "Nf3", "Nc6", "Bc4"];

// Answers nothing anywhere, so the openings generation after grading stores no puzzle
// and the review, which needs no search on a game that follows the book, stays silent.
class CompositionSearcher implements Searcher {
  async search(request: SearchRequest): Promise<SearchResult> {
    return { fen: request.fen, bestmove: null, lines: [] };
  }
}

// Holds every search until the test fails it, so a rebuild stays in flight while the test reads.
class HeldSearcher implements Searcher {
  readonly reached: Promise<void>;
  private arrive: () => void = () => undefined;
  private failWith: (error: Error) => void = () => undefined;
  private readonly failure: Promise<never>;

  constructor() {
    this.reached = new Promise((resolve) => {
      this.arrive = resolve;
    });
    this.failure = new Promise((_resolve, reject) => {
      this.failWith = reject;
    });
  }

  async search(): Promise<SearchResult> {
    this.arrive();
    return this.failure;
  }

  fail(error: Error): void {
    this.failWith(error);
  }
}

const evaluate: EvaluateMove = () =>
  Promise.resolve({
    evalBeforeCp: 20,
    evalAfterCp: 15,
    cpLoss: 5,
    classification: classifyCpLoss(5),
    bestMoveUci: "e2e4",
    bestMoveSan: "e4",
  });

let tmp: string;
let db: Database;
let logs: RecordingLog;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-composition-"));
  db = openDatabase(tmp);
  logs = new RecordingLog();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function composed(engine: Searcher = new CompositionSearcher()) {
  const explorerClock = new FakeClock();
  return composeServer({
    db,
    openingNames: loadOpeningNames(contentDir()),
    repertoireBranches: loadRepertoireBranchBook(contentDir()),
    cacheDir: join(tmp, "explorer-cache"),
    engine,
    fetcherFor: () => new FakeExplorer(explorerClock),
    explorerClock,
    evaluate,
    log: logs,
  });
}

// A finished game whose moves carry the real position after each ply, which is what names it.
function insertNamedGame(sans: string[]): number {
  const game = db
    .prepare(
      `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase, result, termination)
       VALUES ('t', 't2', 'white', 800, ?, 'finished', '1-0', 'checkmate') RETURNING id`,
    )
    .get(new Chess().fen()) as { id: number };
  const insert = db.prepare(
    `INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after, is_player)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const chess = new Chess();
  sans.forEach((san, index) => {
    const fenBefore = chess.fen();
    const move = chess.move(san);
    insert.run(
      game.id,
      index + 1,
      move.san,
      `${move.from}${move.to}${move.promotion ?? ""}`,
      fenBefore,
      chess.fen(),
      index % 2 === 0 ? 1 : 0,
    );
  });
  return game.id;
}

// The stored rows of the book line a reviewed game is compared with: the setup first,
// then the reply and White's answer, at the reach the generator would have stored.
function seedItalianUnit(
  line: string[],
  groupName = REPERTOIRE_GROUP_ITALIAN,
  variationName = "Classical Variation (4.c3)",
): number {
  const { id } = createRepertoireVariation(db, {
    side: "white",
    groupName,
    variationName,
  });
  const chess = new Chess();
  const played: string[] = [];
  line.forEach((san, index) => {
    const ply = index + 1;
    const keyBefore = positionKey(chess.fen());
    const move = chess.move(san);
    const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
    const inRoot = ply <= 5;
    if (ply % 2 === 0) {
      upsertRepertoireReply(db, {
        repertoireId: id,
        positionKey: keyBefore,
        ply,
        line: [...played],
        reach: inRoot ? 1 : 0.226,
        openingName: null,
        uci,
        san: move.san,
        share: 0.5,
        source: inRoot ? "setup" : "explorer",
      });
    } else {
      insertRepertoireOwnMove(db, {
        repertoireId: id,
        positionKey: keyBefore,
        ply,
        line: [...played],
        reach: inRoot ? 1 : 0.226,
        openingName: null,
        uci,
        san: move.san,
        share: null,
        source: inRoot ? "setup" : "explorer",
        cpLoss: 0,
        evalCp: 30,
        results: null,
      });
    }
    played.push(move.san);
  });
  return id;
}

const rowsOfUnit = (repertoireId: number): unknown[] =>
  db
    .prepare("SELECT * FROM repertoire_positions WHERE repertoire_id = ? ORDER BY id")
    .all(repertoireId);

function pgnOf(line: string[]): string {
  const text = line
    .map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}. ${san}` : san))
    .join(" ");
  return `[Result "1-0"]\n\n${text} 1-0`;
}

describe("the composed server", () => {
  it("names a game from the openings table on GET /api/games", async () => {
    const { app, openingNames } = composed();
    const id = insertNamedGame(ITALIAN_LINE);
    const response = await app.inject({ method: "GET", url: "/api/games" });
    await app.close();
    expect(response.statusCode).toBe(200);
    const { games } = response.json() as { games: { id: number; opening: unknown }[] };
    expect(games.find((game) => game.id === id)?.opening).toEqual({
      eco: "C50",
      name: "Italian Game",
    });
    expect(logs.named("openings.names_loaded")[0]?.fields).toMatchObject({
      positions: openingNames.size,
    });
  });

  it("writes one review row when a graded import runs the repertoire review", async () => {
    const line = [...ITALIAN_LINE, "Bc5", "c3"];
    seedItalianUnit(line);
    const { app, grader } = composed();
    const id = importFinishedGame(db, {
      pgn: pgnOf(line),
      playerColor: "white",
      source: "pgn",
      sourceId: "composition-1",
    });
    if (id === null) throw new Error("the fixture game was not imported");
    grader.kick();
    await grader.idle();
    await app.close();
    const reviews = db.prepare("SELECT * FROM repertoire_game_reviews").all() as {
      game_id: number;
      outcome: string;
    }[];
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ game_id: id, outcome: "in_book" });
    expect(logs.named("repertoire.review")[0]?.fields).toMatchObject({ reviewed: 1 });
  });

  it("ends a run left open as left when the server is composed, before it listens", async () => {
    db.prepare(
      `INSERT INTO training_runs (mode, size, items_json, position, solved, failed, current_json,
         started_at, updated_at)
       VALUES ('srs', 1, '[]', 0, 0, 0, '{}', 't', 't')`,
    ).run();
    const { app } = composed();
    await app.close();
    const runs = db.prepare(
      "SELECT ended_reason, ended_at IS NOT NULL AS ended FROM training_runs",
    );
    expect(runs.all()).toEqual([{ ended_reason: "left", ended: 1 }]);
    expect(logs.named("training.runs_left")[0]?.fields).toMatchObject({ count: 1 });
  });

  it("removes a rebuild's copy left in the database when the server is composed, before it listens", async () => {
    const unit = seedItalianUnit([...ITALIAN_LINE, "Bc5", "c3"]);
    const copyGroup = `${REPERTOIRE_GROUP_ITALIAN}${REPERTOIRE_REBUILD_GROUP_SUFFIX}`;
    seedItalianUnit([...ITALIAN_LINE, "Bc5", "d3"], copyGroup, "Giuoco Pianissimo (4.d3)");
    const unitRows = rowsOfUnit(unit);
    // The process that ran the rebuild is gone: the next one opens the file as it was left.
    db.close();
    db = openDatabase(tmp);

    const { app } = composed();
    await app.close();

    expect(db.prepare("SELECT id, group_name FROM repertoires").all()).toEqual([
      { id: unit, group_name: REPERTOIRE_GROUP_ITALIAN },
    ]);
    expect(rowsOfUnit(unit)).toEqual(unitRows);
    expect(db.prepare("SELECT COUNT(*) AS n FROM repertoire_positions").get()).toEqual({
      n: unitRows.length,
    });
    expect(logs.named("openings.rebuild_copy_removed").map((entry) => entry.fields)).toEqual([
      { group: copyGroup, rows: 7 },
    ]);

    // A server started over a database with no copy logs nothing.
    const { app: next } = composed();
    await next.close();
    expect(logs.named("openings.rebuild_copy_removed")).toHaveLength(1);
  });

  it("names the unit a rebuild posted to the composed server walks, until the run ends", async () => {
    const unit = seedItalianUnit([...ITALIAN_LINE, "Bc5", "c3"]);
    const engine = new HeldSearcher();
    const { app } = composed(engine);
    const rebuildingId = async () =>
      (await app.inject({ method: "GET", url: "/api/repertoires" })).json().rebuilding_id;

    const running = app.inject({
      method: "POST",
      url: "/api/openings/generate",
      payload: { sources: ["repertoire"], rebuild: true },
    });
    await engine.reached;
    expect(await rebuildingId()).toBe(unit);

    engine.fail(new Error("the engine stopped answering"));
    expect((await running).statusCode).toBe(502);
    expect(await rebuildingId()).toBeNull();
    await app.close();
  });
});
