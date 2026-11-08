import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityState, TrainingActivity } from "@chess-coach/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedEngine } from "../../test/fakes/scripted-engine.js";
import { START_FEN } from "../../test/fixture-game.js";
import type { Clock } from "../clock.js";
import { createCoachSession } from "../db/chat.js";
import { type Database, openDatabase } from "../db/open.js";
import { insertCard } from "../db/srs.js";
import { GameService } from "../game/service.js";
import { ReviewDesk } from "../srs/review.js";
import { ActivityService } from "./service.js";

const T0 = new Date("2026-03-01T00:00:00.000Z");
const BACK_RANK = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";
const FORK = "r2qk2r/pQp1ppbp/6p1/1N3P2/2p2B2/8/PPn2P1P/R4K1R w kq - 2 14";
const clock: Clock = { now: () => T0 };

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-runs-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function addPuzzle(id: string, fen: string, solution: string[]): void {
  db.prepare(
    `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
     VALUES (?, 'test', 'fork', 'easy', ?, ?, '[]', 'why')`,
  ).run(id, fen, JSON.stringify(solution));
}

function addCard(): number {
  const card = insertCard(db, {
    sourceKind: "teaching",
    sourceGameId: null,
    sourceMoveId: null,
    promptFen: START_FEN,
    studentColor: "white",
    playedUci: "e2e4",
    expectedUci: "d2d4",
    cpLoss: 100,
    classification: "inaccuracy",
    explanation: null,
    createdAt: T0.toISOString(),
  });
  return (card as { id: number }).id;
}

// Everything a server boot builds that holds memory: a new call is a restart over the same file.
function boot(): ActivityService {
  const session = createCoachSession(db, { promptVersion: "v" });
  const notifications = { sessionId: () => session.id };
  return new ActivityService({
    db,
    game: new GameService({ db, engine: new ScriptedEngine(["e7e5"]) }),
    training: { desk: new ReviewDesk({ db, clock, notifications }), notifications, clock },
  });
}

const training = (state: ActivityState | null): TrainingActivity => {
  if (state?.kind !== "training") throw new Error(`expected training, got ${state?.kind}`);
  return state;
};

const code = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return "no error";
};

interface RunRow {
  ended_at: string | null;
  ended_reason: string | null;
}
const runRows = (): RunRow[] =>
  db.prepare("SELECT ended_at, ended_reason FROM training_runs ORDER BY id").all() as RunRow[];

describe("a persisted practice session", () => {
  it("brings the per-item outcomes and the rating change back with a resumed run", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    addPuzzle("p2", BACK_RANK, ["a1a8"]);
    const first = boot();
    const started = training(await first.startTraining({ mode: "puzzles", motif: "fork" }));
    await first.trainingTry("a1a8", started.activity_id);
    await first.nextTrainingItem(started.activity_id);
    const given = training(await first.trainingShowSolution(started.activity_id));
    expect(given.queue_outcomes).toEqual(["solved", "failed"]);

    const resumed = training(await boot().resumeTraining());
    expect(resumed.queue_outcomes).toEqual(["solved", "failed"]);
    expect(resumed.rating_change).toBe(given.rating_change);
    expect(resumed.moves).toEqual([]);
    expect(resumed.solution_line).toEqual(["a1a8"]);
  });

  it("keeps the run row current at start, answer, next and finish across restarts", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    addPuzzle("p2", BACK_RANK, ["a1a8"]);
    const first = boot();
    const started = training(await first.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(boot().pausedTraining()).toMatchObject({
      mode: "puzzles",
      motif: "fork",
      color: null,
      position: 0,
      size: 2,
      solved: 0,
      failed: 0,
    });

    await first.trainingTry("a1a8", started.activity_id);
    expect(boot().pausedTraining()).toMatchObject({ position: 0, solved: 1, failed: 0 });

    await first.nextTrainingItem(started.activity_id);
    expect(boot().pausedTraining()).toMatchObject({ position: 1, solved: 1 });

    await first.trainingTry("h2h3", started.activity_id);
    expect(boot().pausedTraining()).toMatchObject({ position: 1, solved: 1, failed: 0 });

    await first.trainingShowSolution(started.activity_id);
    expect(boot().pausedTraining()).toMatchObject({ position: 1, solved: 1, failed: 1 });

    await first.nextTrainingItem(started.activity_id);
    expect(boot().pausedTraining()).toBeNull();
    expect(runRows()).toEqual([{ ended_at: T0.toISOString(), ended_reason: "finished" }]);
  });

  it("writes a step's ledger rows and its run row together, or neither", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    const activity = boot();
    const started = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    db.exec(`CREATE TRIGGER refuse_run_update BEFORE UPDATE ON training_runs
             BEGIN SELECT RAISE(ABORT, 'run row refused'); END`);
    await expect(activity.trainingTry("a1a8", started.activity_id)).rejects.toThrow(
      "run row refused",
    );
    expect(db.prepare("SELECT answered_at FROM training_items").all()).toEqual([
      { answered_at: null },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM puzzle_attempts").get()).toEqual({ n: 0 });
  });

  it("ties every served item in the ledger to its run", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    addPuzzle("p2", BACK_RANK, ["a1a8"]);
    const activity = boot();
    const started = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    await activity.trainingTry("a1a8", started.activity_id);
    await activity.nextTrainingItem(started.activity_id);
    const rows = db.prepare("SELECT run_id FROM training_items ORDER BY id").all();
    expect(rows).toEqual([{ run_id: 1 }, { run_id: 1 }]);
  });

  it("restores a single-move puzzle at the same item after a restart", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    addPuzzle("p2", BACK_RANK, ["a1a8"]);
    const first = boot();
    const started = training(await first.startTraining({ mode: "puzzles", motif: "fork" }));
    await first.trainingTry("a1a8", started.activity_id);
    const before = training(await first.nextTrainingItem(started.activity_id));

    const after = boot();
    expect(after.current()).toBeNull();
    const resumed = training(await after.resumeTraining());
    expect(resumed.item).toEqual(before.item);
    expect(resumed).toMatchObject({ status: "prompt", fen: before.fen, input_enabled: true });
    const solved = training(await after.trainingTry("a1a8", resumed.activity_id));
    expect(solved.status).toBe("solved");
    const done = training(await after.nextTrainingItem(resumed.activity_id));
    expect(done.summary).toEqual({ solved: 2, failed: 0 });
  });

  it("restores a multi-move puzzle at the same step after a restart", async () => {
    addPuzzle("f1", FORK, ["b5c7", "e8f8", "a1c1"]);
    const first = boot();
    const started = training(await first.startTraining({ mode: "puzzles", motif: "fork" }));
    const mid = training(await first.trainingTry("b5c7", started.activity_id));
    expect(mid.status).toBe("in_progress");

    const after = boot();
    const resumed = training(await after.resumeTraining());
    expect(resumed.item).toMatchObject({ puzzle_id: "f1", cursor: 2, reply_uci: "e8f8" });
    expect(resumed).toMatchObject({
      status: "in_progress",
      fen: mid.fen,
      last_move: mid.last_move,
      input_enabled: true,
    });
    const solved = training(await after.trainingTry("a1c1", resumed.activity_id));
    expect(solved.status).toBe("solved");
    const attempts = db.prepare("SELECT solved, answered_uci FROM puzzle_attempts").all();
    expect(attempts).toEqual([{ solved: 1, answered_uci: '["b5c7","a1c1"]' }]);
  });

  it("re-serves a restored card with a fresh exposure", async () => {
    const cardId = addCard();
    const first = boot();
    const started = training(await first.startTraining({ mode: "srs" }));

    const after = boot();
    const resumed = training(await after.resumeTraining());
    expect(resumed.item).toMatchObject({ kind: "card", card_id: cardId });
    expect(resumed.exposure_id).toBeDefined();
    expect(resumed.exposure_id).not.toBe(started.exposure_id);
    await after.trainingTry("d2d4", resumed.activity_id);
    const rated = training(
      await after.rateCard(resumed.exposure_id as string, 4, resumed.activity_id),
    );
    expect(rated.status).toBe("rated");
  });

  it("asks a card answered but not rated again, without counting it twice", async () => {
    addCard();
    const first = boot();
    const started = training(await first.startTraining({ mode: "srs" }));
    await first.trainingTry("e2e4", started.activity_id);
    await first.trainingShowSolution(started.activity_id);
    expect(boot().pausedTraining()).toMatchObject({ failed: 1 });

    const after = boot();
    const resumed = training(await after.resumeTraining());
    expect(resumed.status).toBe("prompt");
    expect(after.pausedTraining()).toBeNull();
    await after.trainingTry("d2d4", resumed.activity_id);
    const done = training(await after.nextTrainingItem(resumed.activity_id));
    expect(done.summary).toEqual({ solved: 1, failed: 0 });
  });

  it("pauses the run when a game is opened or started, and resumes it at the same item", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    addPuzzle("p2", BACK_RANK, ["a1a8"]);
    const activity = boot();
    const started = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(activity.pausedTraining()).toBeNull();
    await activity.trainingTry("a1a8", started.activity_id);
    const before = training(await activity.nextTrainingItem(started.activity_id));

    await activity.newGame({ color: "white", elo: 1200 });
    expect(activity.current()?.kind).toBe("live_game");
    expect(activity.pausedTraining()).toMatchObject({ position: 1, solved: 1 });
    const gameId = (activity.current() as { game_id: number }).game_id;
    await activity.resign();
    await activity.openGame(gameId);
    expect(activity.current()?.kind).toBe("review");
    expect(runRows()).toEqual([{ ended_at: null, ended_reason: null }]);

    const resumed = training(await activity.resumeTraining());
    expect(resumed.item).toEqual(before.item);
    expect(activity.pausedTraining()).toBeNull();
  });

  it("ends a paused run as replaced when a new session starts", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    addCard();
    const activity = boot();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.newGame({ color: "white", elo: 1200 });
    await activity.startTraining({ mode: "srs" });
    expect(runRows()).toEqual([
      { ended_at: T0.toISOString(), ended_reason: "replaced" },
      { ended_at: null, ended_reason: null },
    ]);
    expect(activity.pausedTraining()).toBeNull();
  });

  it("discards a paused run, and refuses resume and discard with none paused", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    const activity = boot();
    expect(await code(activity.resumeTraining())).toBe("no_paused_training");
    expect(await code(activity.discardTraining())).toBe("no_paused_training");

    const started = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(await code(activity.discardTraining())).toBe("no_paused_training");
    expect(await code(activity.resumeTraining())).toBe("no_paused_training");

    await activity.newGame({ color: "white", elo: 1200 });
    const board = activity.current();
    expect(await activity.discardTraining()).toBe(board);
    expect(runRows()).toEqual([{ ended_at: T0.toISOString(), ended_reason: "discarded" }]);
    expect(activity.pausedTraining()).toBeNull();
    expect(await code(activity.resumeTraining())).toBe("no_paused_training");
    expect(started.activity_id).toBeLessThan((board as ActivityState).activity_id);
  });

  it("closes the run when the student ends it", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    const activity = boot();
    const started = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    await activity.endTraining(started.activity_id);
    expect(runRows()).toEqual([{ ended_at: T0.toISOString(), ended_reason: "ended" }]);
    expect(boot().pausedTraining()).toBeNull();
  });

  it("never persists an item the coach served", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    const activity = boot();
    await activity.startTrainingItem({ kind: "puzzle", id: "p1" });
    expect(runRows()).toEqual([]);
    expect(activity.pausedTraining()).toBeNull();
  });
});
