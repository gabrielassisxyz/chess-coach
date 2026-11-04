import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityState, TrainingActivity } from "@chess-coach/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptedEngine } from "../../test/fakes/scripted-engine.js";
import { START_FEN } from "../../test/fixture-game.js";
import type { Clock } from "../clock.js";
import { createCoachSession, listChatTail } from "../db/chat.js";
import { type Database, openDatabase } from "../db/open.js";
import { getCard, insertCard } from "../db/srs.js";
import { GameService } from "../game/service.js";
import { ReviewDesk } from "../srs/review.js";
import { ActivityService } from "./service.js";

const T0 = new Date("2026-03-01T00:00:00.000Z");
const BACK_RANK = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";
const FORK = "r2qk2r/pQp1ppbp/6p1/1N3P2/2p2B2/8/PPn2P1P/R4K1R w kq - 2 14";

let tmp: string;
let db: Database;
const clock: Clock = { now: () => T0 };

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

function setup() {
  const game = new GameService({ db, engine: new ScriptedEngine(["e7e5"]) });
  const session = createCoachSession(db, { promptVersion: "v" });
  const notifications = { sessionId: () => session.id };
  const desk = new ReviewDesk({ db, clock, notifications });
  const flushed = vi.fn();
  const activity = new ActivityService({
    db,
    game,
    training: { desk, notifications, clock, onNotification: flushed },
  });
  const rows = () =>
    listChatTail(db, session.id, 100).map((row) => JSON.parse(row.contentJson) as { type: string });
  return { activity, game, flushed, rows };
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

  it("refuses a queue with nothing in it", async () => {
    const { activity } = setup();
    expect(await code(activity.startTraining({ mode: "puzzles", motif: "nope" }))).toBe(
      "empty_queue",
    );
    expect(await code(activity.startTraining({ mode: "srs" }))).toBe("empty_queue");
    expect(activity.current()).toBeNull();
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
  it("locks the board on a wrong answer, shows the expected move and tells the coach", async () => {
    addCard("d2d4");
    const { activity, flushed, rows } = setup();
    await activity.startTraining({ mode: "srs" });
    const state = training(await activity.trainingMove("e2e4"));
    expect(state).toMatchObject({
      status: "failed",
      input_enabled: false,
      legal_moves: [],
      last_move: { from: "d2", to: "d4" },
      expected: { uci: "d2d4", san: "d4" },
    });
    expect(rows().map((r) => r.type)).toEqual(["srs_answer"]);
    expect(flushed).toHaveBeenCalled();
  });

  it("rates the card and moves its schedule", async () => {
    const id = addCard("d2d4");
    const before = getCard(db, id)?.nextReviewAt;
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    await activity.trainingMove("d2d4");
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
    expect(await code(activity.trainingMove("e2e5"))).toBe("illegal_move");
  });
});

describe("a puzzle item", () => {
  it("plays the opponent reply after a right answer and re-enables input", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const mid = training(await activity.trainingMove("b5c7"));
    expect(mid).toMatchObject({
      status: "in_progress",
      input_enabled: true,
      last_move: { from: "e8", to: "f8" },
      item: { kind: "puzzle", cursor: 2, reply_uci: "e8f8" },
    });
    expect(mid.legal_moves.length).toBeGreaterThan(0);
    expect(rows()).toEqual([]);
    const done = training(await activity.trainingMove("a1c1"));
    expect(done).toMatchObject({ status: "solved", input_enabled: false, expected: null });
    expect(rows().map((r) => r.type)).toEqual(["puzzle_result"]);
    const attempts = db.prepare("SELECT solved FROM puzzle_attempts").all();
    expect(attempts).toEqual([{ solved: 1 }]);
  });

  it("fails on a wrong move, shows the expected one and records the attempt", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const state = training(await activity.trainingMove("f4e5"));
    expect(state).toMatchObject({
      status: "failed",
      input_enabled: false,
      last_move: { from: "b5", to: "c7" },
      expected: { uci: "b5c7", san: "Nxc7+" },
    });
    expect(rows()).toMatchObject([{ type: "puzzle_result", solved: false }]);
    expect(db.prepare("SELECT solved, failed_ply FROM puzzle_attempts").all()).toEqual([
      { solved: 0, failed_ply: 0 },
    ]);
  });
});

describe("command routing and refusals", () => {
  it("refuses rating a puzzle, and rating a card that is not on the board", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingMove("a1a8");
    expect(await code(activity.rateCard("anything", 3))).toBe("exposure_unknown");
    await activity.endTraining();

    addCard();
    const first = training(await activity.startTraining({ mode: "srs" }));
    await activity.trainingMove("d2d4");
    expect(await code(activity.rateCard("not-the-serving", 3))).toBe("exposure_unknown");
    const exposure = (first.item as { exposure_id: string }).exposure_id;
    expect(await code(activity.rateCard(exposure, 9))).toBe("invalid_quality");
    await activity.rateCard(exposure, 3);
    expect(await code(activity.rateCard(exposure, 3))).toBe("exposure_used");
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
    await activity.trainingMove("b5c7");
    expect(await code(activity.nextTrainingItem())).toBe("item_unfinished");
  });

  it("lets a card advance once answered, rated or not", async () => {
    addCard();
    addCard();
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingMove("d2d4");
    const next = training(await activity.nextTrainingItem());
    expect(next).toMatchObject({ status: "prompt", item: { position_in_queue: 2 } });
  });

  it("refuses a second answer, a stale id and any command outside training", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    expect(await code(activity.nextTrainingItem())).toBe("not_in_training");
    const state = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(await code(activity.trainingMove("a1a8", state.activity_id + 1))).toBe("stale_activity");
    await activity.trainingMove("a1a8");
    expect(await code(activity.trainingMove("a1a8"))).toBe("item_finished");
  });
});

describe("the end of a queue", () => {
  it("writes one summary row with the counts, and only at the end", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    addPuzzle("f2", "fork", BACK_RANK, ["a1a8"]);
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingMove("a1a8");
    await activity.nextTrainingItem();
    await activity.trainingMove("g1h1");
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
