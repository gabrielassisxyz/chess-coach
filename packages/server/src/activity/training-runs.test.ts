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
import { endRunsLeftOpenAtStart } from "../db/training.js";
import { GameService } from "../game/service.js";
import { ReviewDesk } from "../srs/review.js";
import { ActivityService } from "./service.js";
import { TrainingRun } from "./training.js";

const T0 = new Date("2026-03-01T00:00:00.000Z");
const BACK_RANK = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";
const HOUR_MS = 3_600_000;
let now = T0;
const clock: Clock = { now: () => now };

let tmp: string;
let db: Database;

beforeEach(() => {
  now = T0;
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

// Everything a server boot builds that holds memory: a new call is a restart over the same file,
// and a restart ends the runs the last process left open before it serves anything.
function trainingDeps() {
  const session = createCoachSession(db, { promptVersion: "v" });
  const notifications = { sessionId: () => session.id };
  return { db, desk: new ReviewDesk({ db, clock, notifications }), notifications, clock };
}

function boot(): ActivityService {
  endRunsLeftOpenAtStart(db, clock.now().toISOString());
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

const OPEN: RunRow = { ended_at: null, ended_reason: null };
const endedAs = (reason: string, at: Date = T0): RunRow => ({
  ended_at: at.toISOString(),
  ended_reason: reason,
});

const startRun = async (activity: ActivityService): Promise<TrainingActivity> =>
  training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));

// A game that is over and stored, so a review of it can be opened.
async function storedGameId(activity: ActivityService): Promise<number> {
  await activity.newGame({ color: "white", elo: 1200 });
  const gameId = (activity.current() as { game_id: number }).game_id;
  await activity.resign();
  return gameId;
}

describe("a persisted practice session", () => {
  it("keeps the run row current at start, answer, next and finish", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    addPuzzle("p2", BACK_RANK, ["a1a8"]);
    const activity = boot();
    const progress = () =>
      db
        .prepare("SELECT mode, motif, color, position, size, solved, failed FROM training_runs")
        .get();
    const started = await startRun(activity);
    expect(progress()).toEqual({
      mode: "puzzles",
      motif: "fork",
      color: null,
      position: 0,
      size: 2,
      solved: 0,
      failed: 0,
    });

    await activity.trainingTry("a1a8", started.activity_id);
    expect(progress()).toMatchObject({ position: 0, solved: 1, failed: 0 });

    await activity.nextTrainingItem(started.activity_id);
    expect(progress()).toMatchObject({ position: 1, solved: 1 });

    await activity.trainingTry("h2h3", started.activity_id);
    expect(progress()).toMatchObject({ position: 1, solved: 1, failed: 0 });

    await activity.trainingShowSolution(started.activity_id);
    expect(progress()).toMatchObject({ position: 1, solved: 1, failed: 1 });
    expect(runRows()).toEqual([OPEN]);

    await activity.nextTrainingItem(started.activity_id);
    expect(runRows()).toEqual([endedAs("finished")]);
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

  it("ends the run as left when a game is started, with what was answered kept", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    addPuzzle("p2", BACK_RANK, ["a1a8"]);
    const activity = boot();
    const started = await startRun(activity);
    await activity.trainingTry("a1a8", started.activity_id);
    await activity.nextTrainingItem(started.activity_id);
    expect(runRows()).toEqual([OPEN]);

    await activity.newGame({ color: "white", elo: 1200 });
    expect(activity.current()?.kind).toBe("live_game");
    expect(runRows()).toEqual([endedAs("left")]);
    expect(db.prepare("SELECT position, solved, failed FROM training_runs").get()).toEqual({
      position: 1,
      solved: 1,
      failed: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM puzzle_attempts").get()).toEqual({ n: 1 });
  });

  it("ends the run as left when a stored game is opened", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    const activity = boot();
    const gameId = await storedGameId(activity);
    await startRun(activity);
    expect(runRows()).toEqual([OPEN]);

    await activity.openGame(gameId);
    expect(activity.current()?.kind).toBe("review");
    expect(runRows()).toEqual([endedAs("left")]);
  });

  it("ends the run as left when the live game is opened", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    const activity = boot();
    await activity.newGame({ color: "white", elo: 1200 });
    const liveId = (activity.current() as { game_id: number }).game_id;
    await startRun(activity);
    expect(runRows()).toEqual([OPEN]);

    await activity.openGame(liveId);
    expect(activity.current()?.kind).toBe("live_game");
    expect(runRows()).toEqual([endedAs("left")]);
  });

  it("keeps the run through a coach demo and shows the item again when the demo ends", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    addPuzzle("p2", BACK_RANK, ["a1a8"]);
    const activity = boot();
    const started = await startRun(activity);
    const answered = training(await activity.trainingTry("a1a8", started.activity_id));

    const demo = await activity.startDemo(BACK_RANK);
    expect(demo).toMatchObject({ kind: "demo", returns_to: "training" });
    expect(runRows()).toEqual([OPEN]);

    const back = training(await activity.leaveDemo(demo.activity_id));
    expect(back).toMatchObject({ item: answered.item, status: "solved", fen: answered.fen });
    expect(runRows()).toEqual([OPEN]);
  });

  it("ends the run under a demo as left when the coach serves an item of its own", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    addPuzzle("p2", BACK_RANK, ["a1a8"]);
    const activity = boot();
    const started = await startRun(activity);
    await activity.trainingTry("a1a8", started.activity_id);
    await activity.startDemo(BACK_RANK);

    await activity.startTrainingItem({ kind: "puzzle", id: "p2" });
    expect(activity.current()?.kind).toBe("training");
    expect(runRows()).toEqual([endedAs("left")]);
    expect(db.prepare("SELECT run_id FROM training_items ORDER BY id").all()).toEqual([
      { run_id: 1 },
      { run_id: null },
    ]);
  });

  it("ends the run on the board as replaced when a new session starts, and keeps that reason", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    addCard();
    const activity = boot();
    await startRun(activity);
    now = new Date(T0.getTime() + HOUR_MS);
    await activity.startTraining({ mode: "srs" });
    expect(runRows()).toEqual([endedAs("replaced", now), OPEN]);

    now = new Date(T0.getTime() + 2 * HOUR_MS);
    await activity.newGame({ color: "white", elo: 1200 });
    expect(runRows()).toEqual([
      endedAs("replaced", new Date(T0.getTime() + HOUR_MS)),
      endedAs("left", now),
    ]);
  });

  it("keeps the reason of a run that already ended when the board moves on", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    const activity = boot();
    const started = await startRun(activity);
    await activity.trainingTry("a1a8", started.activity_id);
    const done = training(await activity.nextTrainingItem(started.activity_id));
    expect(done.summary).toEqual({ solved: 1, failed: 0 });

    now = new Date(T0.getTime() + HOUR_MS);
    await activity.newGame({ color: "white", elo: 1200 });
    expect(runRows()).toEqual([endedAs("finished")]);
  });

  it("refuses a step for a run that left the board, and leaves its row as it was left", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    const activity = boot();
    const started = await startRun(activity);
    await activity.newGame({ color: "white", elo: 1200 });
    const leftRow = db.prepare("SELECT * FROM training_runs").get();

    now = new Date(T0.getTime() + HOUR_MS);
    expect(await code(activity.trainingTry("a1a8", started.activity_id))).toBe("stale_activity");
    expect(await code(activity.trainingTry("a1a8"))).toBe("not_in_training");
    expect(db.prepare("SELECT * FROM training_runs").get()).toEqual(leftRow);
  });

  it("writes nothing to the row of a puzzle run that left when its step completes late", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    const run = TrainingRun.begin(trainingDeps(), { mode: "puzzles", motif: "fork" });
    run.leave();
    now = new Date(T0.getTime() + HOUR_MS);
    const leftRow = db.prepare("SELECT * FROM training_runs").get();
    expect(leftRow).toMatchObject({ ended_reason: "left", solved: 0 });

    run.tryMove("a1a8");
    expect(db.prepare("SELECT * FROM training_runs").get()).toEqual(leftRow);
  });

  it("writes nothing to the row of a card run that left when its step completes late", async () => {
    addCard();
    const run = TrainingRun.begin(trainingDeps(), { mode: "srs" });
    run.leave();
    now = new Date(T0.getTime() + HOUR_MS);
    const leftRow = db.prepare("SELECT * FROM training_runs").get();
    expect(leftRow).toMatchObject({ ended_reason: "left", solved: 0 });

    run.tryMove("d2d4");
    expect(db.prepare("SELECT * FROM training_runs").get()).toEqual(leftRow);
  });

  it("stores the last answer's outcome and the final counts before the finish closes the row", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    addPuzzle("p2", BACK_RANK, ["a1a8"]);
    const activity = boot();
    const started = await startRun(activity);
    await activity.trainingTry("a1a8", started.activity_id);
    await activity.nextTrainingItem(started.activity_id);
    await activity.trainingTry("h2h3", started.activity_id);
    await activity.trainingShowSolution(started.activity_id);
    const stored = () =>
      db
        .prepare("SELECT position, solved, failed, outcomes_json, current_json FROM training_runs")
        .get();
    const beforeFinish = stored();
    expect(beforeFinish).toMatchObject({
      position: 1,
      solved: 1,
      failed: 1,
      outcomes_json: '["solved","failed"]',
    });

    await activity.nextTrainingItem(started.activity_id);
    expect(stored()).toEqual(beforeFinish);
    expect(runRows()).toEqual([endedAs("finished")]);
  });

  it("ends every open run as left when the server starts", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    const first = boot();
    const finished = await startRun(first);
    await first.trainingTry("a1a8", finished.activity_id);
    await first.nextTrainingItem(finished.activity_id);
    const open = await startRun(first);
    await first.trainingTry("a1a8", open.activity_id);
    // Nothing in the app leaves two rows open, but a database copied mid-run could.
    db.prepare(
      `INSERT INTO training_runs (mode, size, items_json, position, solved, failed, current_json,
         started_at, updated_at)
       VALUES ('srs', 1, '[]', 0, 0, 0, '{}', ?, ?)`,
    ).run(T0.toISOString(), T0.toISOString());
    expect(runRows()).toEqual([endedAs("finished"), OPEN, OPEN]);

    now = new Date(T0.getTime() + HOUR_MS);
    const second = boot();
    expect(second.current()).toBeNull();
    expect(runRows()).toEqual([endedAs("finished"), endedAs("left", now), endedAs("left", now)]);
    expect(db.prepare("SELECT solved FROM training_runs WHERE id = 2").get()).toEqual({
      solved: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM puzzle_attempts").get()).toEqual({ n: 2 });

    const fresh = await startRun(second);
    expect(fresh).toMatchObject({ status: "prompt", input_enabled: true });
    expect(runRows().at(-1)).toEqual(OPEN);
  });

  it("closes the run when the student ends it", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    const activity = boot();
    const started = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    await activity.endTraining(started.activity_id);
    expect(runRows()).toEqual([endedAs("ended")]);
  });

  it("never persists an item the coach served", async () => {
    addPuzzle("p1", BACK_RANK, ["a1a8"]);
    const activity = boot();
    await activity.startTrainingItem({ kind: "puzzle", id: "p1" });
    expect(runRows()).toEqual([]);
    await activity.newGame({ color: "white", elo: 1200 });
    expect(runRows()).toEqual([]);
  });
});
