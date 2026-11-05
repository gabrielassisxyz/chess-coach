import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGame, listMoves, setGrading } from "../db/games.js";
import { type Database, openDatabase } from "../db/open.js";
import { classifyCpLoss, type PlayerMoveEvaluation } from "../engine/evaluate.js";
import { RecordingLog, silentLog } from "../log.js";
import { type EvaluateMove, ImportGrader } from "./grader.js";
import { importFinishedGame } from "./pgn.js";

const FIXTURE = readFileSync(
  new URL("../../test/fixtures/chesscom_2026-10-28.pgn", import.meta.url),
  "utf8",
);

let tmp: string;
let db: Database;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-grader-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function evaluation(cpLoss: number): PlayerMoveEvaluation {
  return {
    evalBeforeCp: 10,
    evalAfterCp: 10 - cpLoss,
    cpLoss,
    classification: classifyCpLoss(cpLoss),
    bestMoveUci: "d2d4",
    bestMoveSan: "d4",
  };
}

class FakeEvaluator {
  readonly asked: string[] = [];
  failOn: string | null = null;
  readonly evaluate: EvaluateMove = async (_fen, uci, color) => {
    this.asked.push(`${color}:${uci}`);
    if (uci === this.failOn) throw new Error("engine fault");
    return evaluation(this.asked.length * 10);
  };
}

const importOne = (pgn = FIXTURE, id?: string) =>
  importFinishedGame(db, {
    pgn,
    playerColor: "white",
    source: "pgn",
    ...(id && { sourceId: id }),
  }) as number;

describe("ImportGrader", () => {
  it("grades every student ply and nothing else, then marks the game done", async () => {
    const id = importOne();
    const fake = new FakeEvaluator();
    const grader = new ImportGrader({ db, evaluate: fake.evaluate, log: silentLog });
    grader.kick();
    await grader.idle();
    const moves = listMoves(db, id);
    for (const move of moves) {
      expect(move.cpLoss !== null).toBe(move.isPlayer);
      expect(move.classification !== null).toBe(move.isPlayer);
    }
    expect(fake.asked).toHaveLength(30);
    expect(fake.asked.every((entry) => entry.startsWith("w:"))).toBe(true);
    expect(getGame(db, id)?.grading).toBe("done");
  });

  it("runs the after-grading hook once per graded game and never for a failed one", async () => {
    importOne('[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1', "bad");
    importOne(FIXTURE, "good");
    const fake = new FakeEvaluator();
    fake.failOn = "f2f3";
    let hooks = 0;
    const grader = new ImportGrader({
      db,
      evaluate: fake.evaluate,
      log: silentLog,
      onGraded: async () => {
        hooks += 1;
      },
    });
    grader.kick();
    await grader.idle();
    expect(hooks).toBe(1);
  });

  it("logs a failing hook and still marks the game done", async () => {
    const id = importOne();
    const logs = new RecordingLog();
    const grader = new ImportGrader({
      db,
      evaluate: new FakeEvaluator().evaluate,
      log: logs,
      onGraded: async () => {
        throw new Error("engine gone");
      },
    });
    grader.kick();
    await grader.idle();
    expect(getGame(db, id)?.grading).toBe("done");
    expect(logs.named("import.after_grade")).toEqual([]);
    expect(logs.named("import.after_grade_failed")[0]?.fields).toMatchObject({
      game_id: id,
      error_message: "engine gone",
    });
  });

  it("resumes a running game without searching graded plies again", async () => {
    const id = importOne();
    const first = new FakeEvaluator();
    first.failOn = listMoves(db, id).filter((move) => move.isPlayer)[10]?.uci ?? null;
    const grader = new ImportGrader({ db, evaluate: first.evaluate, log: silentLog });
    grader.kick();
    await grader.idle();
    expect(getGame(db, id)?.grading).toBe("failed");
    // A crash mid-game leaves the row `running` with the first ten plies graded.
    setGrading(db, id, "running");
    const second = new FakeEvaluator();
    const resumed = new ImportGrader({ db, evaluate: second.evaluate, log: silentLog });
    resumed.kick();
    await resumed.idle();
    expect(second.asked).toHaveLength(20);
    expect(getGame(db, id)?.grading).toBe("done");
    expect(listMoves(db, id).filter((move) => move.isPlayer && move.cpLoss === null)).toHaveLength(
      0,
    );
  });

  it("marks a game failed, logs it and carries on with the next one", async () => {
    const bad = importOne('[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1', "a");
    const good = importOne(FIXTURE, "b");
    const fake = new FakeEvaluator();
    fake.failOn = "f2f3";
    const logs = new RecordingLog();
    const grader = new ImportGrader({
      db,
      evaluate: fake.evaluate,
      log: logs,
    });
    grader.kick();
    await grader.idle();
    expect(getGame(db, bad)?.grading).toBe("failed");
    expect(getGame(db, good)?.grading).toBe("done");
    const failures = logs.named("import.grade_failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.fields).toMatchObject({ game_id: bad });
    expect(String(failures[0]?.fields.error_message)).toMatch(/engine fault/);
    expect(logs.named("import.graded")[0]?.fields).toMatchObject({ game_id: good });
    expect(grader.progress()).toEqual({ pending: 0, failed: 1, running: null });
  });

  it("logs the opening drills built after a graded game, with their counts", async () => {
    const id = importOne();
    const logs = new RecordingLog();
    const grader = new ImportGrader({
      db,
      evaluate: new FakeEvaluator().evaluate,
      log: logs,
      onGraded: async () => ({ positions: 4, created: 3, updated: 1 }),
    });
    grader.kick();
    await grader.idle();
    expect(logs.named("import.after_grade")[0]?.fields).toMatchObject({
      game_id: id,
      result: { positions: 4, created: 3, updated: 1 },
    });
  });

  it("reports progress while a game is being graded", async () => {
    const id = importOne();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const grader = new ImportGrader({
      db,
      log: silentLog,
      evaluate: async () => {
        calls += 1;
        if (calls === 4) await gate;
        return evaluation(5);
      },
    });
    grader.kick();
    while (calls < 4) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(grader.progress()).toEqual({
      pending: 0,
      failed: 0,
      running: { gameId: id, gradedPlies: 3, totalPlies: 30 },
    });
    release();
    await grader.idle();
    expect(grader.progress().running).toBeNull();
  });
});
