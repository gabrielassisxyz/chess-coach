import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityState, TrainingActivity } from "@chess-coach/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptedEngine } from "../../test/fakes/scripted-engine.js";
import { START_FEN } from "../../test/fixture-game.js";
import type { Clock } from "../clock.js";
import { type CoachNotification, renderNotifications } from "../coach/notify.js";
import { appendChatMessage, createCoachSession, listChatTail } from "../db/chat.js";
import { type Database, openDatabase } from "../db/open.js";
import { getCard, insertCard, updateSchedule } from "../db/srs.js";
import { GameService } from "../game/service.js";
import { type Log, RecordingLog, silentLog } from "../log.js";
import { ReviewDesk } from "../srs/review.js";
import { ActivityService } from "./service.js";

const T0 = new Date("2026-03-01T00:00:00.000Z");
const BACK_RANK = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";
const FORK = "r2qk2r/pQp1ppbp/6p1/1N3P2/2p2B2/8/PPn2P1P/R4K1R w kq - 2 14";

let tmp: string;
let db: Database;
const fixedClock: Clock = { now: () => T0 };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-training-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function addPuzzle(id: string, motif: string, fen: string, solution: string[]): void {
  db.prepare(
    `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
     VALUES (?, 'test', ?, 'easy', ?, ?, '[]', 'why')`,
  ).run(id, motif, fen, JSON.stringify(solution));
}

function addCard(expectedUci = "d2d4"): number {
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
    createdAt: T0.toISOString(),
  });
  return (card as { id: number }).id;
}

function setup(clock: Clock = fixedClock, log: Log = silentLog) {
  const game = new GameService({ db, engine: new ScriptedEngine(["e7e5"]) });
  const session = createCoachSession(db, { promptVersion: "v" });
  const notifications = { sessionId: () => session.id };
  const desk = new ReviewDesk({ db, clock, notifications });
  const flushed = vi.fn();
  const activity = new ActivityService({
    db,
    game,
    training: { desk, notifications, clock, onNotification: flushed },
    log,
  });
  const rows = () =>
    listChatTail(db, session.id, 100).map((row) => JSON.parse(row.contentJson) as { type: string });
  const say = (text: string): number => {
    const row = appendChatMessage(
      db,
      session.id,
      { role: "user", kind: "text", contentJson: JSON.stringify({ text }) },
      clock,
    );
    activity.linkUserMessage(row.id);
    return row.id;
  };
  const notes = () =>
    listChatTail(db, session.id, 100)
      .filter((row) => row.kind === "notification")
      .map((row) => JSON.parse(row.contentJson) as CoachNotification);
  return { activity, game, flushed, rows, say, notes };
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

describe("queue materialization", () => {
  it("serves a queue of ten puzzles when the inventory is larger", async () => {
    for (let i = 0; i < 12; i++)
      addPuzzle(`p${String(i).padStart(2, "0")}`, "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    const state = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(state.item).toMatchObject({ kind: "puzzle", position_in_queue: 1, queue_length: 10 });
  });

  it("serves a short queue, and says how short, when the motif has few puzzles", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    addPuzzle("f2", "fork", BACK_RANK, ["a1a8"]);
    addPuzzle("pin1", "pin", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    const state = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(state.item.queue_length).toBe(2);
  });

  it("carries the motif filter for a single motif and null for Any", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    addPuzzle("p1", "pin", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    const single = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(single.run_motif).toBe("fork");
    await activity.endTraining();
    const any = training(await activity.startTraining({ mode: "puzzles" }));
    expect(any.run_motif).toBeNull();
  });

  it("refuses a queue with nothing in it", async () => {
    const { activity } = setup();
    expect(await code(activity.startTraining({ mode: "puzzles", motif: "nope" }))).toBe(
      "empty_queue",
    );
    expect(await code(activity.startTraining({ mode: "srs" }))).toBe("empty_queue");
    expect(activity.current()).toBeNull();
  });

  it("serves only the chosen colour in openings mode and refuses an empty inventory", async () => {
    addPuzzle("w1", "opening-white", BACK_RANK, ["a1a8"]);
    addPuzzle("b1", "opening-black", FORK, ["b5c7"]);
    addPuzzle("b2", "opening-black", BACK_RANK, ["a1a8"]);
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    const black = training(await activity.startTraining({ mode: "openings", color: "black" }));
    expect(black).toMatchObject({ mode: "openings", item: { motif: "opening-black" } });
    expect(black.item.queue_length).toBe(2);
    db.prepare("DELETE FROM puzzles WHERE motif = 'opening-white'").run();
    expect(await code(activity.startTraining({ mode: "openings", color: "white" }))).toBe(
      "empty_queue",
    );
    expect(await code(activity.startTraining({ mode: "openings" }))).toBe("empty_queue");
  });

  it("materializes the due cards for review mode", async () => {
    addCard();
    addCard();
    const { activity } = setup();
    const state = training(await activity.startTraining({ mode: "srs" }));
    expect(state).toMatchObject({
      mode: "srs",
      status: "prompt",
      orientation: "white",
      input_enabled: true,
      item: { kind: "card", position_in_queue: 1, queue_length: 2 },
    });
    expect(state.legal_moves).toHaveLength(20);
    expect(state.exposure_id).toBe((state.item as { exposure_id: string }).exposure_id);
  });
});

describe("a card item", () => {
  it("keeps the card open on a wrong try, counts it and tells the coach nothing yet", async () => {
    addCard("d2d4");
    const { activity, flushed, rows } = setup();
    const served = training(await activity.startTraining({ mode: "srs" }));
    const state = training(await activity.trainingTry("e2e4"));
    expect(state).toMatchObject({
      status: "prompt",
      input_enabled: true,
      fen: served.fen,
      expected: null,
      tries: 1,
      last_try: { uci: "e2e4", san: "e4", correct: false },
      gave_up: false,
      solution_line: null,
    });
    expect(state.legal_moves).toEqual(served.legal_moves);
    expect(rows()).toEqual([]);
    expect(flushed).not.toHaveBeenCalled();
  });

  it("ends a card given up with the expected move as its solution line and tells the coach", async () => {
    addCard("d2d4");
    const { activity, flushed, rows } = setup();
    await activity.startTraining({ mode: "srs" });
    const state = training(await activity.trainingShowSolution());
    expect(state).toMatchObject({
      status: "failed",
      input_enabled: false,
      legal_moves: [],
      expected: { uci: "d2d4", san: "d4" },
      gave_up: true,
      solution_line: ["d2d4"],
      suggested_quality: 0,
    });
    expect(rows().map((r) => r.type)).toEqual(["srs_answer"]);
    expect(flushed).toHaveBeenCalled();
  });

  it("hides the expected move and highlights the played move on a right answer", async () => {
    addCard("d2d4");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    const state = training(await activity.trainingTry("d2d4"));
    expect(state).toMatchObject({
      status: "solved",
      input_enabled: false,
      legal_moves: [],
      last_move: { from: "d2", to: "d4" },
      expected: null,
    });
  });

  it("logs the item served, the answer and the rating", async () => {
    addCard("d2d4");
    const log = new RecordingLog();
    const { activity } = setup(fixedClock, log);
    const start = training(await activity.startTraining({ mode: "srs" }));
    await activity.trainingTry("d2d4");
    const exposure = (start.item as { exposure_id: string }).exposure_id;
    await activity.rateCard(exposure, 4);
    expect(log.named("training.item_served")[0]?.fields).toMatchObject({ mode: "srs" });
    expect(log.named("training.answer")[0]?.fields).toMatchObject({
      try: true,
      uci: "d2d4",
      correct: true,
      tries: 0,
      expected: null,
    });
    expect(log.named("srs.rated")[0]?.fields).toMatchObject({ exposure_id: exposure, quality: 4 });
  });

  it("rates the card and moves its schedule", async () => {
    const id = addCard("d2d4");
    const before = getCard(db, id)?.nextReviewAt;
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    await activity.trainingTry("d2d4");
    const rated = training(
      await activity.rateCard((start.item as { exposure_id: string }).exposure_id, 4),
    );
    expect(rated.status).toBe("rated");
    expect(getCard(db, id)?.nextReviewAt).not.toBe(before);
  });

  it("refuses a move that is not legal in the position", async () => {
    addCard();
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    expect(await code(activity.trainingTry("e2e5"))).toBe("illegal_move");
  });
});

describe("a puzzle item", () => {
  it("plays the opponent reply after a right answer and re-enables input", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const mid = training(await activity.trainingTry("b5c7"));
    expect(mid).toMatchObject({
      status: "in_progress",
      input_enabled: true,
      last_move: { from: "e8", to: "f8" },
      item: { kind: "puzzle", cursor: 2, reply_uci: "e8f8" },
    });
    expect(mid.legal_moves.length).toBeGreaterThan(0);
    expect(rows()).toEqual([]);
    const done = training(await activity.trainingTry("a1c1"));
    expect(done).toMatchObject({ status: "solved", input_enabled: false, expected: null });
    expect(rows().map((r) => r.type)).toEqual(["puzzle_result"]);
    const attempts = db.prepare("SELECT solved FROM puzzle_attempts").all();
    expect(attempts).toEqual([{ solved: 1 }]);
  });

  it("keeps the puzzle open at the same step on a wrong try and records nothing final", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const state = training(await activity.trainingTry("f4e5"));
    expect(state).toMatchObject({
      status: "prompt",
      input_enabled: true,
      fen: FORK,
      item: { cursor: 0 },
      tries: 1,
      last_try: { uci: "f4e5", correct: false },
    });
    expect(rows()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM puzzle_attempts").get()).toEqual({ n: 0 });
  });

  it("gives up mid-way and shows the rest of the line from the current step", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const mid = training(await activity.trainingTry("b5c7"));
    const state = training(await activity.trainingShowSolution());
    expect(state).toMatchObject({
      status: "failed",
      input_enabled: false,
      fen: mid.fen,
      expected: { uci: "a1c1" },
      gave_up: true,
      solution_line: ["a1c1"],
      suggested_quality: null,
    });
    expect(rows()).toMatchObject([{ type: "puzzle_result", solved: false, gave_up: true }]);
    expect(db.prepare("SELECT solved, failed_ply FROM puzzle_attempts").all()).toEqual([
      { solved: 0, failed_ply: 2 },
    ]);
    expect(await code(activity.trainingTry("a1c1"))).toBe("item_finished");
    expect(await code(activity.trainingShowSolution())).toBe("item_finished");
  });
});

describe("command routing and refusals", () => {
  it("refuses rating a puzzle, and rating a card that is not on the board", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("a1a8");
    expect(await code(activity.rateCard("anything", 3))).toBe("exposure_unknown");
    await activity.endTraining();

    addCard();
    const first = training(await activity.startTraining({ mode: "srs" }));
    await activity.trainingTry("d2d4");
    expect(await code(activity.rateCard("not-the-serving", 3))).toBe("exposure_unknown");
    const exposure = (first.item as { exposure_id: string }).exposure_id;
    expect(await code(activity.rateCard(exposure, 9))).toBe("invalid_quality");
    await activity.rateCard(exposure, 3);
    expect(await code(activity.rateCard(exposure, 3))).toBe("exposure_used");
  });

  it("refuses rating a card that is no longer on the board", async () => {
    addCard();
    addCard();
    const { activity } = setup();
    const first = training(await activity.startTraining({ mode: "srs" }));
    await activity.trainingTry("d2d4");
    await activity.nextTrainingItem();
    const earlier = (first.item as { exposure_id: string }).exposure_id;
    expect(await code(activity.rateCard(earlier, 3))).toBe("exposure_unknown");
  });

  it("refuses rating a card that was never answered", async () => {
    addCard();
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    const exposure = (start.item as { exposure_id: string }).exposure_id;
    expect(await code(activity.rateCard(exposure, 3))).toBe("exposure_unanswered");
  });

  it("refuses next until the item is answered, for a card and for a puzzle", async () => {
    addCard();
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    expect(await code(activity.nextTrainingItem())).toBe("item_unfinished");
    await activity.endTraining();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    expect(await code(activity.nextTrainingItem())).toBe("item_unfinished");
    await activity.trainingTry("b5c7");
    expect(await code(activity.nextTrainingItem())).toBe("item_unfinished");
  });

  it("lets a card advance once answered, rated or not", async () => {
    addCard();
    addCard();
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingTry("d2d4");
    const next = training(await activity.nextTrainingItem());
    expect(next).toMatchObject({ status: "prompt", item: { position_in_queue: 2 } });
  });

  it("refuses a second answer, a stale id and any command outside training", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    expect(await code(activity.nextTrainingItem())).toBe("not_in_training");
    const state = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(await code(activity.trainingTry("a1a8", state.activity_id + 1))).toBe("stale_activity");
    await activity.trainingTry("a1a8");
    expect(await code(activity.trainingTry("a1a8"))).toBe("item_finished");
  });
});

describe("the end of a queue", () => {
  it("writes one summary row with the counts, and only at the end", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    addPuzzle("f2", "fork", BACK_RANK, ["a1a8"]);
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("a1a8");
    await activity.nextTrainingItem();
    await activity.trainingTry("g1h1");
    await activity.trainingShowSolution();
    expect(rows().filter((r) => r.type === "training_summary")).toEqual([]);
    const ended = training(await activity.nextTrainingItem());
    expect(ended.summary).toEqual({ solved: 1, failed: 1 });
    expect(ended.input_enabled).toBe(false);
    expect(rows().filter((r) => r.type === "training_summary")).toEqual([
      { type: "training_summary", mode: "puzzles", solved: 1, failed: 1 },
    ]);
    expect(await code(activity.nextTrainingItem())).toBe("item_finished");
    expect(rows().filter((r) => r.type === "training_summary")).toHaveLength(1);
  });

  it("returns to the unfinished live game, or to nothing", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    await activity.newGame({ color: "white", elo: 1200 });
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const back = await activity.endTraining();
    expect(back?.kind).toBe("live_game");
    await activity.resign();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    expect(await activity.endTraining()).toBeNull();
    expect(activity.current()).toBeNull();
  });
});

// A clock the test moves by hand, so offsets from the moment an item was served are exact.
function steppingClock(): Clock & { advance(seconds: number): void } {
  let now = T0.getTime();
  return {
    now: () => new Date(now),
    advance: (seconds) => {
      now += seconds * 1000;
    },
  };
}

const events = () =>
  db.prepare("SELECT seq, at_ms, kind, uci FROM exploration_events ORDER BY seq").all();

describe("exploration", () => {
  it("records moves with the server clock and shows the explored position", async () => {
    addCard("d2d4");
    const clock = steppingClock();
    const { activity } = setup(clock);
    await activity.startTraining({ mode: "srs" });
    clock.advance(12);
    const state = training(await activity.trainingExplore({ kind: "move", uci: "e2e4" }));
    expect(state.exploring).toEqual({
      fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      line_san: ["e4"],
      trail: [{ seq: 1, at_ms: 12_000, kind: "move", line_san: ["e4"] }],
    });
    expect(state).toMatchObject({ fen: START_FEN, turn: "black", status: "prompt" });
    expect(state.legal_moves).toHaveLength(20);
    expect(state.last_move).toEqual({ from: "e2", to: "e4" });
    clock.advance(3);
    await activity.trainingExplore({ kind: "move", uci: "e7e5" });
    expect(events()).toEqual([
      { seq: 1, at_ms: 12_000, kind: "move", uci: "e2e4" },
      { seq: 2, at_ms: 15_000, kind: "move", uci: "e7e5" },
    ]);
  });

  it("never grades: the card stays unanswered and no notification is written", async () => {
    addCard("d2d4");
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "srs" });
    const state = training(await activity.trainingExplore({ kind: "move", uci: "d2d4" }));
    expect(state.status).toBe("prompt");
    expect(rows()).toEqual([]);
    expect(db.prepare("SELECT answered_at FROM training_items").all()).toEqual([
      { answered_at: null },
    ]);
  });

  it("takes one move back on undo and returns to the served position on reset", async () => {
    addCard();
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingExplore({ kind: "move", uci: "e2e4" });
    await activity.trainingExplore({ kind: "move", uci: "e7e5" });
    const undone = training(await activity.trainingExplore({ kind: "undo" }));
    expect(undone.exploring.line_san).toEqual(["e4"]);
    expect(undone.turn).toBe("black");
    const reset = training(await activity.trainingExplore({ kind: "reset" }));
    expect(reset.exploring).toMatchObject({ fen: START_FEN, line_san: [] });
    expect(reset.last_move).toBeNull();
    expect(events().map((e) => (e as { kind: string }).kind)).toEqual([
      "move",
      "move",
      "undo",
      "reset",
    ]);
  });

  it("refuses an illegal exploration move, or one with nothing to undo, and records nothing", async () => {
    addCard();
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    expect(await code(activity.trainingExplore({ kind: "move", uci: "e2e5" }))).toBe(
      "illegal_exploration",
    );
    expect(await code(activity.trainingExplore({ kind: "move" }))).toBe("illegal_exploration");
    expect(await code(activity.trainingExplore({ kind: "undo" }))).toBe("illegal_exploration");
    expect(await code(activity.trainingExplore({ kind: "reset" }))).toBe("illegal_exploration");
    expect(events()).toEqual([]);
  });

  it("refuses to explore outside a training item and once the item is answered", async () => {
    addCard();
    const { activity } = setup();
    expect(await code(activity.trainingExplore({ kind: "undo" }))).toBe("not_exploring");
    const state = training(await activity.startTraining({ mode: "srs" }));
    expect(await code(activity.trainingExplore({ kind: "undo" }, state.activity_id + 1))).toBe(
      "stale_activity",
    );
    await activity.trainingTry("d2d4");
    expect(await code(activity.trainingExplore({ kind: "move", uci: "e2e4" }))).toBe(
      "not_exploring",
    );
  });

  it("grades the answer against the served position, ignoring what was explored", async () => {
    addCard("d2d4");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingExplore({ kind: "move", uci: "e2e4" });
    await activity.trainingExplore({ kind: "move", uci: "e7e5" });
    const done = training(await activity.trainingTry("d2d4"));
    expect(done).toMatchObject({
      status: "solved",
      exploring: { fen: START_FEN, line_san: [] },
      legal_moves: [],
    });
    expect(db.prepare("SELECT answer_uci, correct, answered_at FROM training_items").all()).toEqual(
      [{ answer_uci: "d2d4", correct: 1, answered_at: T0.toISOString() }],
    );
    expect(await code(activity.trainingTry("d2d4"))).toBe("item_finished");
  });

  it("links chat lines to the open item and not to the gap before the next one", async () => {
    addCard();
    addCard();
    const { activity, say } = setup();
    await activity.startTraining({ mode: "srs" });
    const during = say("I think the centre matters");
    await activity.trainingTry("d2d4");
    say("that was easy");
    await activity.nextTrainingItem();
    const second = say("now this one");
    const links = db
      .prepare("SELECT item_id, message_id FROM item_messages ORDER BY message_id")
      .all();
    expect(links).toEqual([
      { item_id: 1, message_id: during },
      { item_id: 2, message_id: second },
    ]);
  });

  it("keeps a multi-move puzzle open and restarts exploring from the position after the reply", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingExplore({ kind: "move", uci: "f4e5" });
    const mid = training(await activity.trainingTry("b5c7"));
    expect(mid.status).toBe("in_progress");
    expect(mid.exploring).toEqual({ fen: mid.fen, line_san: [], trail: [] });
    expect(db.prepare("SELECT answered_at FROM training_items").all()).toEqual([
      { answered_at: null },
    ]);
    const next = training(await activity.trainingExplore({ kind: "move", uci: "a1c1" }));
    expect(next.exploring.line_san).toEqual(["Rc1"]);
    await activity.trainingTry("a1c1");
    expect(db.prepare("SELECT answer_uci, correct FROM training_items").all()).toEqual([
      { answer_uci: "a1c1", correct: 1 },
    ]);
    expect(rows().map((r) => r.type)).toEqual(["puzzle_result"]);
  });

  it("hands the coach what was written, what was tried and the wrong answer", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const clock = steppingClock();
    const { activity, say, notes } = setup(clock);
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    clock.advance(5);
    await activity.trainingExplore({ kind: "move", uci: "f4e5" });
    clock.advance(4);
    await activity.trainingExplore({ kind: "move", uci: "d8d5" });
    clock.advance(3);
    await activity.trainingExplore({ kind: "move", uci: "e5d4" });
    clock.advance(2);
    await activity.trainingExplore({ kind: "undo" });
    say("looking at the bishop first");
    await activity.trainingTry("f4e5");
    await activity.trainingShowSolution();
    const text = renderNotifications(notes());
    expect(text).toContain("looking at the bishop first");
    expect(text).toContain("+5s  14. Be5");
    expect(text).toContain("+9s  14. Be5 Qd5");
    expect(text).toContain("+12s  14. Be5 Qd5 Bd4");
    expect(text).toContain("+14s  undo");
    expect(text).toContain("Tries:\n+14s  Be5 (wrong)\nSolution shown: yes");
  });

  it("attaches the reasoning to the review card answer the desk wrote", async () => {
    addCard("d2d4");
    const { activity, say, notes } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingExplore({ kind: "move", uci: "e2e4" });
    await activity.trainingExplore({ kind: "reset" });
    say("e4 or d4?");
    await activity.trainingTry("e2e4");
    await activity.trainingTry("d2d4");
    const text = renderNotifications(notes());
    expect(text).toContain("What the student wrote:\n- e4 or d4?");
    expect(text).toContain("+0s  1. e4\n+0s  reset");
    expect(text).toContain("Tries:\n+0s  e4 (wrong)\n+0s  d4 (right)\nSolution shown: no");
  });
});

describe("the training state a client renders", () => {
  it("lists two moves, an undo and a reset as four events with rising offsets", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const clock = steppingClock();
    const { activity } = setup(clock);
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    for (const step of [
      { kind: "move", uci: "g1h1" },
      { kind: "move", uci: "g8h8" },
      { kind: "undo" },
      { kind: "reset" },
    ] as const) {
      clock.advance(2);
      await activity.trainingExplore(step);
    }
    const { trail } = training(activity.current()).exploring;
    expect(trail.map((e) => e.kind)).toEqual(["move", "move", "undo", "reset"]);
    expect(trail.map((e) => e.at_ms)).toEqual([2000, 4000, 6000, 8000]);
    expect(trail.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(trail.map((e) => e.line_san)).toEqual([["Kh1"], ["Kh1", "Kh8"], ["Kh1"], []]);
  });

  it("stamps served_at and starts each served item with an empty trail", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    addPuzzle("f2", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    const first = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(first.served_at).toBe(T0.toISOString());
    await activity.trainingExplore({ kind: "move", uci: "g1h1" });
    await activity.trainingTry("a1a8");
    const second = training(await activity.nextTrainingItem());
    expect(second.exploring.trail).toEqual([]);
  });

  it("restarts the trail when a multi-move puzzle advances", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingExplore({ kind: "move", uci: "f4e5" });
    const mid = training(await activity.trainingTry("b5c7"));
    expect(mid.exploring.trail).toEqual([]);
    const next = training(await activity.trainingExplore({ kind: "move", uci: "a1c1" }));
    expect(next.exploring.trail.map((e) => e.line_san)).toEqual([["Rc1"]]);
  });

  it("previews the interval each quality would set, and rating applies the previewed one", async () => {
    const id = addCard("d2d4");
    updateSchedule(db, id, {
      nextReviewAt: T0.toISOString(),
      intervalHours: 24,
      easeFactor: 2.5,
      repetitions: 1,
    });
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    const item = start.item as Extract<typeof start.item, { kind: "card" }>;
    expect(item.rating_preview).toEqual({ "0": 4, "1": 4, "2": 4, "3": 24, "4": 24, "5": 24 });
    await activity.trainingTry("d2d4");
    await activity.rateCard(item.exposure_id, 3);
    expect(getCard(db, id)?.intervalHours).toBe(item.rating_preview["3"]);
  });

  it("sizes a puzzle or opening drill at 5, 10 or 20 and defaults to 10", async () => {
    for (let i = 0; i < 25; i++)
      addPuzzle(`p${String(i).padStart(2, "0")}`, "fork", BACK_RANK, ["a1a8"]);
    for (const [size, length] of [
      [5, 5],
      [20, 20],
      [undefined, 10],
    ] as const) {
      const { activity } = setup();
      const state = training(
        await activity.startTraining({ mode: "puzzles", motif: "fork", ...(size ? { size } : {}) }),
      );
      expect(state.item).toMatchObject({ queue_length: length });
      await activity.endTraining();
    }
  });

  it("ignores size for review cards", async () => {
    for (let i = 0; i < 7; i++) addCard();
    const { activity } = setup();
    const state = training(await activity.startTraining({ mode: "srs", size: 5 }));
    expect(state.item).toMatchObject({ queue_length: 7 });
  });
});

describe("an item served by the coach", () => {
  const cardCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM srs_cards").get() as { n: number }).n;

  it("serves one card as item 1 of 1 in srs mode, due or not", async () => {
    const id = addCard();
    db.prepare("UPDATE srs_cards SET next_review_at = '2099-01-01T00:00:00.000Z'").run();
    const { activity } = setup();
    const state = training(await activity.startTrainingItem({ kind: "card", id }));
    expect(state.mode).toBe("srs");
    expect(state.item).toMatchObject({ kind: "card", card_id: id, position_in_queue: 1 });
    expect(state.item).toMatchObject({ queue_length: 1 });
    expect(state.input_enabled).toBe(true);
  });

  it("serves one puzzle as item 1 of 1 and refuses unknown ids by name", async () => {
    addPuzzle("fk:0", "fork", FORK, ["f4e5"]);
    const { activity } = setup();
    expect(await code(activity.startTrainingItem({ kind: "puzzle", id: "nope" }))).toBe(
      "puzzle_not_found",
    );
    expect(await code(activity.startTrainingItem({ kind: "card", id: 999 }))).toBe(
      "card_not_found",
    );
    const state = training(await activity.startTrainingItem({ kind: "puzzle", id: "fk:0" }));
    expect(state.item).toMatchObject({ kind: "puzzle", puzzle_id: "fk:0", queue_length: 1 });
  });

  it("refuses a second session while one is open", async () => {
    addPuzzle("fk:0", "fork", FORK, ["f4e5"]);
    const { activity } = setup();
    await activity.startTrainingItem({ kind: "puzzle", id: "fk:0" });
    expect(await code(activity.startTrainingItem({ kind: "puzzle", id: "fk:0" }))).toBe(
      "training_active",
    );
  });

  it("refuses to stack over an unfinished live game and leaves the board on it", async () => {
    addPuzzle("fk:0", "fork", FORK, ["f4e5"]);
    const { activity, game } = setup();
    await game.newGame({ color: "white", elo: 1200 });
    const live = await activity.enterLiveGame();
    expect(await code(activity.startTrainingItem({ kind: "puzzle", id: "fk:0" }))).toBe(
      "live_game_active",
    );
    expect(activity.current()).toEqual(live);
  });

  it("stacks over a finished live game and returns to nothing", async () => {
    addPuzzle("fk:0", "fork", FORK, ["f4e5"]);
    const { activity, game } = setup();
    await game.newGame({ color: "white", elo: 1200 });
    await activity.enterLiveGame();
    await game.resign();
    await activity.startTrainingItem({ kind: "puzzle", id: "fk:0" });
    expect(activity.current()?.kind).toBe("training");
    expect(await activity.endTraining()).toBeNull();
  });

  it("turns a given-up puzzle into one teaching card, once", async () => {
    addPuzzle("fk:0", "fork", FORK, ["f4e5"]);
    const { activity } = setup();
    for (let round = 0; round < 2; round++) {
      await activity.startTrainingItem({ kind: "puzzle", id: "fk:0" });
      await activity.trainingTry("h1g1");
      await activity.trainingShowSolution();
      await activity.endTraining();
    }
    expect(cardCount()).toBe(1);
    expect(db.prepare("SELECT * FROM srs_cards").get()).toMatchObject({
      source_kind: "teaching",
      puzzle_id: "fk:0",
      prompt_fen: FORK,
      student_color: "white",
      played_uci: "h1g1",
      expected_uci: "f4e5",
      cp_loss: null,
      classification: null,
      explanation: "why",
    });
  });

  it("creates no card for a puzzle solved on the first try", async () => {
    addPuzzle("fk:0", "fork", FORK, ["f4e5"]);
    const { activity } = setup();
    await activity.startTrainingItem({ kind: "puzzle", id: "fk:0" });
    await activity.trainingTry("f4e5");
    expect(cardCount()).toBe(0);
  });

  it("turns a puzzle solved after a wrong try into a teaching card", async () => {
    addPuzzle("fk:0", "fork", FORK, ["f4e5"]);
    const { activity } = setup();
    await activity.startTrainingItem({ kind: "puzzle", id: "fk:0" });
    await activity.trainingTry("h1g1");
    expect(cardCount()).toBe(0);
    const solved = training(await activity.trainingTry("f4e5"));
    expect(solved.status).toBe("solved");
    expect(cardCount()).toBe(1);
    expect(db.prepare("SELECT played_uci, expected_uci FROM srs_cards").get()).toEqual({
      played_uci: "h1g1",
      expected_uci: "f4e5",
    });
  });
});

describe("graded tries", () => {
  const triesRows = () =>
    db
      .prepare("SELECT item_id, seq, at_ms, ply, uci, correct FROM training_tries ORDER BY id")
      .all();
  const attemptRows = () =>
    db.prepare("SELECT solved, first_try, tries, gave_up FROM puzzle_attempts ORDER BY id").all();
  const exposureOf = (state: TrainingActivity): string =>
    (state.item as { exposure_id: string }).exposure_id;

  it("records every try in order, with its step, offset and correctness", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const clock = steppingClock();
    const { activity } = setup(clock);
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    clock.advance(3);
    await activity.trainingTry("f4e5");
    clock.advance(2);
    await activity.trainingTry("b5c7");
    clock.advance(4);
    await activity.trainingTry("a1b1");
    clock.advance(1);
    await activity.trainingTry("a1c1");
    const itemId = (db.prepare("SELECT id FROM training_items").get() as { id: number }).id;
    expect(triesRows()).toEqual([
      { item_id: itemId, seq: 1, at_ms: 3000, ply: 0, uci: "f4e5", correct: 0 },
      { item_id: itemId, seq: 2, at_ms: 5000, ply: 0, uci: "b5c7", correct: 1 },
      { item_id: itemId, seq: 3, at_ms: 9000, ply: 2, uci: "a1b1", correct: 0 },
      { item_id: itemId, seq: 4, at_ms: 10000, ply: 2, uci: "a1c1", correct: 1 },
    ]);
  });

  it("writes first_try, tries and gave_up for each way a puzzle can end", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    addPuzzle("f2", "fork", BACK_RANK, ["a1a8"]);
    addPuzzle("f3", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("a1a8");
    await activity.nextTrainingItem();
    await activity.trainingTry("a1a2");
    await activity.trainingTry("a1a3");
    const solved = training(await activity.trainingTry("a1a8"));
    expect(solved).toMatchObject({ status: "solved", tries: 2, gave_up: false });
    await activity.nextTrainingItem();
    await activity.trainingTry("a1a2");
    await activity.trainingShowSolution();
    expect(attemptRows()).toEqual([
      { solved: 1, first_try: 1, tries: 0, gave_up: 0 },
      { solved: 1, first_try: 0, tries: 2, gave_up: 0 },
      { solved: 0, first_try: 0, tries: 1, gave_up: 1 },
    ]);
  });

  it("suggests 4 for a card right first try, and its review counts as correct", async () => {
    addCard("d2d4");
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    const done = training(await activity.trainingTry("d2d4"));
    expect(done.suggested_quality).toBe(4);
    await activity.rateCard(exposureOf(start), 4);
    expect(db.prepare("SELECT answered_uci, correct FROM srs_reviews").get()).toEqual({
      answered_uci: "d2d4",
      correct: 1,
    });
  });

  it("suggests 2 for a card solved after a wrong try, and its review counts the first try", async () => {
    addCard("d2d4");
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    await activity.trainingTry("e2e4");
    const done = training(await activity.trainingTry("d2d4"));
    expect(done).toMatchObject({ status: "solved", suggested_quality: 2, tries: 1 });
    await activity.rateCard(exposureOf(start), 2);
    expect(db.prepare("SELECT answered_uci, correct FROM srs_reviews").get()).toEqual({
      answered_uci: "e2e4",
      correct: 0,
    });
  });

  it("suggests 0 for a card whose solution was shown, even before any try", async () => {
    addCard("d2d4");
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    const done = training(await activity.trainingShowSolution());
    expect(done).toMatchObject({ status: "failed", suggested_quality: 0, gave_up: true });
    await activity.rateCard(exposureOf(start), 0);
    expect(db.prepare("SELECT correct FROM srs_reviews").get()).toEqual({ correct: 0 });
  });

  it("writes one notification per item, after the last try, carrying every try", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    addCard("d2d4");
    const { activity, notes, flushed } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("f4e5");
    await activity.trainingTry("b5c7");
    await activity.trainingTry("a1b1");
    expect(notes()).toEqual([]);
    expect(flushed).not.toHaveBeenCalled();
    await activity.trainingTry("a1c1");
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({
      type: "puzzle_result",
      solved: true,
      first_try: false,
      tries: 2,
      gave_up: false,
      reasoning: {
        gave_up: false,
        tries: [
          { uci: "f4e5", correct: false },
          { uci: "b5c7", correct: true },
          { uci: "a1b1", correct: false },
          { uci: "a1c1", correct: true },
        ],
      },
    });
    await activity.endTraining();

    await activity.startTraining({ mode: "srs" });
    await activity.trainingTry("e2e4");
    await activity.trainingTry("g1f3");
    await activity.trainingShowSolution();
    const cardNotes = notes().filter((note) => note.type === "srs_answer");
    expect(cardNotes).toHaveLength(1);
    expect(cardNotes[0]).toMatchObject({
      answered_uci: "e2e4",
      correct: false,
      reasoning: { gave_up: true, tries: [{ uci: "e2e4" }, { uci: "g1f3" }] },
    });
  });
});

describe("hint", () => {
  it("marks the origin square and the ledger row, and clears on the next try", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const hinted = training(await activity.trainingHint());
    expect(hinted.hint_square).toBe("b5");
    expect(db.prepare("SELECT hinted FROM training_items").get()).toEqual({ hinted: 1 });
    const afterTry = training(await activity.trainingTry("f4e5"));
    expect(afterTry.hint_square).toBeNull();
  });

  it("marks a card with its expected origin and clears on the next try", async () => {
    addCard("d2d4");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    const hinted = training(await activity.trainingHint());
    expect(hinted.hint_square).toBe("d2");
    expect(db.prepare("SELECT hinted FROM training_items").get()).toEqual({ hinted: 1 });
    const afterTry = training(await activity.trainingTry("e2e4"));
    expect(afterTry.hint_square).toBeNull();
  });

  it("counts a hinted puzzle solve as not first try and keeps the hint flag", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingHint();
    const done = training(await activity.trainingTry("a1a8"));
    expect(done).toMatchObject({ status: "solved", hint_square: null });
    expect(
      db.prepare("SELECT solved, first_try, tries, gave_up, hinted FROM puzzle_attempts").all(),
    ).toEqual([{ solved: 1, first_try: 0, tries: 0, gave_up: 0, hinted: 1 }]);
    expect(db.prepare("SELECT hinted, correct FROM training_items").get()).toEqual({
      hinted: 1,
      correct: 0,
    });
  });

  it("suggests quality 2 for a card solved after a hint", async () => {
    addCard("d2d4");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingHint();
    const done = training(await activity.trainingTry("d2d4"));
    expect(done).toMatchObject({ status: "solved", suggested_quality: 2, hint_square: null });
    expect(db.prepare("SELECT hinted FROM training_items").get()).toEqual({ hinted: 1 });
  });

  it("refuses a hint once the item is finished", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("a1a8");
    expect(await code(activity.trainingHint())).toBe("item_finished");
    await activity.endTraining();
    addCard("d2d4");
    await activity.startTraining({ mode: "srs" });
    await activity.trainingShowSolution();
    expect(await code(activity.trainingHint())).toBe("item_finished");
  });
});
