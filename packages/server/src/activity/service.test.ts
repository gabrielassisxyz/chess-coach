import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityState, TrainingActivity } from "@chess-coach/shared";
import { ErrorCodeSchema } from "@chess-coach/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptedEngine } from "../../test/fakes/scripted-engine.js";
import { START_FEN } from "../../test/fixture-game.js";
import { createCoachSession } from "../db/chat.js";
import { type Database, openDatabase } from "../db/open.js";
import { insertCard } from "../db/srs.js";
import { GameService } from "../game/service.js";
import { RecordingLog } from "../log.js";
import { ReviewDesk } from "../srs/review.js";
import { ActivityService } from "./service.js";

const DEMO_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-activity-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function setup(replies: string[]) {
  const engine = new ScriptedEngine(replies);
  const game = new GameService({ db, engine });
  const activity = new ActivityService({ db, game });
  const seen: (ActivityState | null)[] = [];
  activity.onState((state) => seen.push(state));
  const brief = () => seen.map((s) => (s ? [s.kind, s.activity_id] : null));
  return { engine, game, activity, seen, brief };
}

describe("activity sequence", () => {
  it("walks a live game, a demo, a review and back with fresh ids per switch", async () => {
    const { game, activity, brief } = setup(["e7e5"]);
    await activity.newGame({ color: "white", elo: 1200 });
    const first = game.current()?.id as number;
    await activity.playerMove({ from: "e2", to: "e4" });
    await activity.resign();
    await activity.startDemo(DEMO_FEN);
    await activity.demoMove("e4");
    await activity.leaveDemo();
    await activity.newGame({ color: "white", elo: 1200 });
    const second = game.current()?.id as number;
    await activity.openGame(first);
    await activity.openGame(second);

    expect(brief()).toEqual([
      ["live_game", 1],
      ["live_game", 1],
      ["live_game", 1],
      ["live_game", 1],
      ["demo", 2],
      ["demo", 2],
      ["live_game", 3],
      ["live_game", 4],
      ["review", 5],
      ["live_game", 6],
    ]);
  });

  it("opens a finished game in review at its last position and steps the cursor", async () => {
    const { game, activity } = setup(["e7e5"]);
    await activity.newGame({ color: "white", elo: 1200 });
    const id = game.current()?.id as number;
    await activity.playerMove({ from: "e2", to: "e4" });
    await activity.resign();
    await activity.newGame({ color: "white", elo: 1200 });

    const review = await activity.openGame(id);
    if (review.kind !== "review") throw new Error("expected review");
    expect(review.selected_ply).toBe(2);
    expect(review.input_enabled).toBe(false);
    expect(review.last_move).toEqual({ from: "e7", to: "e5" });
    const stepped = await activity.selectReviewPly(id, 0, review.activity_id);
    if (stepped.kind !== "review") throw new Error("expected review");
    expect(stepped).toMatchObject({
      activity_id: review.activity_id,
      selected_ply: 0,
      last_move: null,
    });
    expect(stepped.fen.startsWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR")).toBe(true);
    await expect(activity.selectReviewPly(id, 3)).rejects.toMatchObject({ code: "invalid_ply" });
    await expect(activity.selectReviewPly(id + 99, 1)).rejects.toMatchObject({
      code: "not_in_review",
    });
    await expect(activity.openGame(999)).rejects.toMatchObject({ code: "game_not_found" });
  });

  it("returns from a demo to the review it started over", async () => {
    const { game, activity } = setup(["e7e5"]);
    await activity.newGame({ color: "white", elo: 1200 });
    const id = game.current()?.id as number;
    await activity.playerMove({ from: "e2", to: "e4" });
    await activity.abort();
    await activity.newGame({ color: "white", elo: 1200 });
    const review = await activity.openGame(id);
    await activity.selectReviewPly(id, 1, review.activity_id);
    const demo = await activity.startDemo(DEMO_FEN);
    expect(demo).toMatchObject({ kind: "demo", returns_to: "review", orientation: "white" });
    const back = await activity.leaveDemo();
    expect(back).toMatchObject({ kind: "review", selected_ply: 1 });
  });
});

describe("stale and wrong-kind commands", () => {
  it("refuses a stale activity_id and changes nothing", async () => {
    const { activity, seen } = setup([]);
    const demo = await activity.startDemo(DEMO_FEN);
    const before = seen.length;
    await expect(activity.demoMove("e4", demo.activity_id + 1)).rejects.toMatchObject({
      code: "stale_activity",
    });
    await expect(activity.leaveDemo(demo.activity_id - 1)).rejects.toMatchObject({
      code: "stale_activity",
    });
    expect(seen).toHaveLength(before);
    expect(activity.current()).toEqual(demo);
  });

  it("refuses a move at the finished game once the board moved to a demo", async () => {
    const { game, activity } = setup(["e7e5"]);
    await activity.newGame({ color: "white", elo: 1200 });
    await activity.resign();
    const live = activity.current() as ActivityState;
    await activity.startDemo(DEMO_FEN);
    await expect(
      activity.playerMove({ from: "e2", to: "e4" }, live.activity_id),
    ).rejects.toMatchObject({ code: "stale_activity" });
    await expect(activity.playerMove({ from: "e2", to: "e4" })).rejects.toMatchObject({
      code: "demo_active",
    });
    await expect(activity.undo()).rejects.toMatchObject({ code: "demo_active" });
    expect(game.snapshot()?.moves).toEqual([]);
  });

  it("refuses a demo over an unfinished live game and leaves the board on it", async () => {
    const { activity, seen } = setup(["e7e5"]);
    await activity.newGame({ color: "white", elo: 1200 });
    const live = activity.current();
    const before = seen.length;
    await expect(activity.startDemo(DEMO_FEN)).rejects.toMatchObject({
      code: "live_game_active",
    });
    expect(seen).toHaveLength(before);
    expect(activity.current()).toEqual(live);
  });

  it("refuses the coach's rewind of 2026-11-05 and keeps the student's next move", async () => {
    // 1. e4 f6 2. Nf3 d5 3. e5 Nc6, then a demo from the position after 2... d5.
    const { game, activity } = setup(["f7f6", "d7d5", "b8c6", "e7e5"]);
    await activity.newGame({ color: "white", elo: 1200 });
    await activity.playerMove({ from: "e2", to: "e4" });
    await activity.playerMove({ from: "g1", to: "f3" });
    await activity.playerMove({ from: "e4", to: "e5" });
    const afterD5 = "rnbqkbnr/ppp1p1pp/5p2/3p4/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3";
    await expect(activity.startDemo(afterD5)).rejects.toMatchObject({
      code: "live_game_active",
    });
    expect(activity.current()?.kind).toBe("live_game");
    await activity.playerMove({ from: "e5", to: "f6" });
    expect(game.snapshot()?.moves.map((m) => m.san)).toEqual([
      "e4",
      "f6",
      "Nf3",
      "d5",
      "e5",
      "Nc6",
      "exf6",
      "e5",
    ]);
  });

  it("refuses a move while a review is on the board and leave_demo outside a demo", async () => {
    const { game, activity } = setup([]);
    await activity.newGame({ color: "white", elo: 1200 });
    const id = game.current()?.id as number;
    await activity.abort();
    await activity.openGame(id);
    await expect(activity.playerMove({ from: "e2", to: "e4" })).rejects.toMatchObject({
      code: "not_in_live_game",
    });
    await expect(activity.leaveDemo()).rejects.toMatchObject({ code: "not_in_demo" });
    await expect(activity.demoMove("e4")).rejects.toMatchObject({ code: "not_in_demo" });
  });

  it("passes the game's own refusal through", async () => {
    const { activity } = setup([]);
    await activity.newGame({ color: "white", elo: 1200 });
    await expect(activity.playerMove({ from: "e2", to: "e5" })).rejects.toMatchObject({
      code: "illegal_move",
    });
    await activity.abort();
    await expect(activity.startDemo("not a fen")).rejects.toMatchObject({
      code: "invalid_position",
    });
    await activity.startDemo(DEMO_FEN);
    await expect(activity.demoMove("Qh5")).rejects.toMatchObject({ code: "illegal_move" });
  });
});

describe("a turn in flight", () => {
  it("refuses a demo while the turn is evaluating and lets the turn finish on the board", async () => {
    const { engine, activity } = setup(["e7e5"]);
    await activity.newGame({ color: "white", elo: 1200 });
    const release = engine.hold();
    const turn = activity.playerMove({ from: "e2", to: "e4" });
    await vi.waitFor(() => expect(activity.current()).toMatchObject({ pending: "evaluating" }));
    expect(activity.current()).toMatchObject({ input_enabled: false, legal_moves: [] });

    await expect(activity.startDemo(DEMO_FEN)).rejects.toMatchObject({
      code: "live_game_active",
    });
    release();
    await turn;
    const back = activity.current();
    if (back?.kind !== "live_game") throw new Error("expected live_game");
    expect(back).toMatchObject({ pending: "none", input_enabled: true, phase: "player_turn" });
    expect(back.moves.map((m) => m.san)).toEqual(["e4", "e5"]);
  });
});

describe("the log", () => {
  it("records each board change with what replaced what and why", async () => {
    const log = new RecordingLog();
    const game = new GameService({ db, engine: new ScriptedEngine(["e7e5"]) });
    const activity = new ActivityService({ db, game, log });
    await activity.newGame({ color: "white", elo: 1200 });
    await activity.resign();
    await activity.startDemo(DEMO_FEN);
    await activity.demoMove("e4");
    await activity.leaveDemo();

    const changes = log.named("activity.change").map((entry) => entry.fields);
    expect(changes.map((change) => change.cause)).toEqual([
      "newGame",
      "followLiveGame",
      "startDemo",
      "demoMove",
      "leaveDemo",
    ]);
    expect(changes[2]).toMatchObject({
      from_kind: "live_game",
      from_activity_id: 1,
      to_kind: "demo",
      to_activity_id: 2,
      fen: DEMO_FEN,
      returns_to: "live_game",
    });
    expect(changes[3]).toMatchObject({ to_kind: "demo", played: ["e4"] });
    expect(changes[4]).toMatchObject({ from_kind: "demo", to_kind: "live_game" });
  });

  it("records a listener that throws, and the board still changes", async () => {
    const log = new RecordingLog();
    const game = new GameService({ db, engine: new ScriptedEngine([]) });
    const activity = new ActivityService({ db, game, log });
    activity.onState(() => {
      throw new Error("listener broke");
    });
    const demo = await activity.startDemo(DEMO_FEN);
    expect(activity.current()).toEqual(demo);
    expect(log.named("activity.listener_failed")[0]?.fields).toMatchObject({
      cause: "startDemo",
      error_message: "listener broke",
    });
  });
});

describe("legal moves", () => {
  it("collapses the promotions of one square into a single entry", async () => {
    const { activity } = setup([]);
    const state = await activity.newGame({
      color: "white",
      elo: 1200,
      fen: "8/P6k/8/8/8/8/8/K7 w - - 0 1",
    });
    expect(state.legal_moves.filter((m) => m.from === "a7")).toEqual([
      { from: "a7", to: "a8", promotions: ["q", "r", "b", "n"] },
    ]);
    expect(state.input_enabled).toBe(true);
  });
});

describe("serialization", () => {
  it("applies overlapping mutations in call order, never seeing a half-built game", async () => {
    const { engine, activity, brief } = setup(["e2e4"]);
    const release = engine.hold();
    const started = activity.newGame({ color: "black", elo: 1200 });
    const entered = activity.enterLiveGame();
    release();
    await Promise.all([started, entered]);
    expect(brief()).toEqual([
      ["live_game", 1],
      ["live_game", 2],
    ]);
    expect(activity.current()).toMatchObject({ pending: "none", input_enabled: true });
  });

  it("keeps a failed mutation from stalling the ones behind it", async () => {
    const { activity } = setup([]);
    const bad = activity.startDemo("not a fen");
    const good = activity.startDemo(DEMO_FEN);
    await expect(bad).rejects.toMatchObject({ code: "invalid_position" });
    await expect(good).resolves.toMatchObject({ kind: "demo" });
  });
});

const FORK_FEN = "r2qk2r/pQp1ppbp/6p1/1N3P2/2p2B2/8/PPn2P1P/R4K1R w kq - 2 14";

function addPuzzleRow(id: string, motif: string, fen: string, solution: string[]): void {
  db.prepare(
    `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
     VALUES (?, 'test', ?, 'easy', ?, ?, '[]', 'why')`,
  ).run(id, motif, fen, JSON.stringify(solution));
}

function addTrainingCard(expectedUci = "d2d4"): number {
  const card = insertCard(db, {
    sourceKind: "teaching",
    sourceGameId: null,
    sourceMoveId: null,
    promptFen: START_FEN,
    studentColor: "white",
    playedUci: "e2e4",
    expectedUci,
    cpLoss: 100,
    classification: "inaccuracy",
    explanation: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z").toISOString(),
  });
  return (card as { id: number }).id;
}

function setupTraining() {
  const engine = new ScriptedEngine(["e7e5"]);
  const game = new GameService({ db, engine });
  const session = createCoachSession(db, { promptVersion: "v" });
  const notifications = { sessionId: () => session.id };
  const desk = new ReviewDesk({ db, notifications });
  const activity = new ActivityService({ db, game, training: { desk, notifications } });
  return { activity, game };
}

const asTraining = (state: ActivityState | null): TrainingActivity => {
  if (state?.kind !== "training") throw new Error(`expected training, got ${state?.kind}`);
  return state;
};

describe("training_item_open error code", () => {
  it("is carried in the shared wire contract", () => {
    expect(ErrorCodeSchema.safeParse("training_item_open").success).toBe(true);
  });
});

describe("demo over training", () => {
  it("refuses a demo while a card item is open and changes nothing", async () => {
    addTrainingCard();
    const { activity } = setupTraining();
    const open = asTraining(await activity.startTraining({ mode: "srs" }));
    expect(open.status).toBe("prompt");
    const before = activity.current();
    await expect(activity.startDemo(DEMO_FEN)).rejects.toMatchObject({
      code: "training_item_open",
    });
    expect(activity.current()).toEqual(before);
  });

  it("refuses a demo while a puzzle is mid-way and changes nothing", async () => {
    addPuzzleRow("f1", "fork", FORK_FEN, ["b5c7", "e8f8", "a1c1"]);
    const { activity } = setupTraining();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const mid = asTraining(await activity.trainingTry("b5c7"));
    expect(mid.status).toBe("in_progress");
    const before = activity.current();
    await expect(activity.startDemo(DEMO_FEN)).rejects.toMatchObject({
      code: "training_item_open",
    });
    expect(activity.current()).toEqual(before);
  });

  it("allows a demo after a card is solved", async () => {
    addTrainingCard();
    const { activity } = setupTraining();
    await activity.startTraining({ mode: "srs" });
    const solved = asTraining(await activity.trainingTry("d2d4"));
    expect(solved.status).toBe("solved");
    await expect(activity.startDemo(DEMO_FEN)).resolves.toMatchObject({
      kind: "demo",
      returns_to: "training",
    });
    await activity.leaveDemo();
  });

  it("allows a demo after a card is failed", async () => {
    addTrainingCard();
    const { activity } = setupTraining();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingTry("e2e4");
    const failed = asTraining(await activity.trainingShowSolution());
    expect(failed.status).toBe("failed");
    await expect(activity.startDemo(DEMO_FEN)).resolves.toMatchObject({
      kind: "demo",
      returns_to: "training",
    });
    await activity.leaveDemo();
  });

  it("allows a demo after a card is rated", async () => {
    addTrainingCard();
    const { activity } = setupTraining();
    const start = asTraining(await activity.startTraining({ mode: "srs" }));
    await activity.trainingTry("d2d4");
    await activity.rateCard((start.item as { exposure_id: string }).exposure_id, 4);
    expect(asTraining(activity.current()).status).toBe("rated");
    await expect(activity.startDemo(DEMO_FEN)).resolves.toMatchObject({
      kind: "demo",
      returns_to: "training",
    });
    await activity.leaveDemo();
  });

  it("allows a demo after a puzzle is solved or failed", async () => {
    addPuzzleRow("f1", "fork", FORK_FEN, ["b5c7", "e8f8", "a1c1"]);
    const { activity } = setupTraining();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const solved = asTraining(await activity.trainingTry("b5c7"));
    expect(solved.status).toBe("in_progress");
    const done = asTraining(await activity.trainingTry("a1c1"));
    expect(done.status).toBe("solved");
    await expect(activity.startDemo(DEMO_FEN)).resolves.toMatchObject({
      kind: "demo",
      returns_to: "training",
    });
    await activity.leaveDemo();

    await activity.endTraining();
    addPuzzleRow("f2", "fork", FORK_FEN, ["b5c7"]);
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("f4e5");
    const failed = asTraining(await activity.trainingShowSolution());
    expect(failed.status).toBe("failed");
    await expect(activity.startDemo(DEMO_FEN)).resolves.toMatchObject({
      kind: "demo",
      returns_to: "training",
    });
    await activity.leaveDemo();
  });

  it("leaves the demo on the same training item with a fresh id, then serves the next item", async () => {
    addTrainingCard();
    addTrainingCard();
    const { activity } = setupTraining();
    await activity.startTraining({ mode: "srs" });
    const finished = asTraining(await activity.trainingTry("d2d4"));
    expect(finished.status).toBe("solved");
    const demo = await activity.startDemo(DEMO_FEN);
    if (demo.kind !== "demo") throw new Error("expected demo");
    const back = asTraining(await activity.leaveDemo(demo.activity_id));
    expect(back).toMatchObject({
      kind: "training",
      status: finished.status,
      summary: finished.summary,
      item: finished.item,
    });
    expect(back.activity_id).not.toBe(finished.activity_id);
    const next = asTraining(await activity.nextTrainingItem(back.activity_id));
    expect(next.item.position_in_queue).toBe(2);
  });

  it("ends training from a demo over training on the unfinished live game", async () => {
    addPuzzleRow("f1", "fork", FORK_FEN, ["b5c7"]);
    const { activity, game } = setupTraining();
    await activity.newGame({ color: "white", elo: 1200 });
    const gameId = game.current()?.id as number;
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("b5c7");
    const demo = await activity.startDemo(DEMO_FEN);
    expect(demo).toMatchObject({ kind: "demo", returns_to: "training" });
    if (demo.kind !== "demo") throw new Error("expected demo");
    const back = await activity.endTraining(demo.activity_id);
    expect(back).toMatchObject({ kind: "live_game", game_id: gameId });
  });
});
