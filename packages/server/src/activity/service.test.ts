import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityState } from "@chess-coach/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptedEngine } from "../../test/fakes/scripted-engine.js";
import { type Database, openDatabase } from "../db/open.js";
import { GameService } from "../game/service.js";
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
    await activity.startDemo(DEMO_FEN);
    await activity.demoMove("e4");
    await activity.leaveDemo();
    await activity.resign();
    await activity.newGame({ color: "white", elo: 1200 });
    const second = game.current()?.id as number;
    await activity.openGame(first);
    await activity.openGame(second);

    expect(brief()).toEqual([
      ["live_game", 1],
      ["live_game", 1],
      ["live_game", 1],
      ["demo", 2],
      ["demo", 2],
      ["live_game", 3],
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

  it("refuses a move at the live game once the board moved to a demo", async () => {
    const { game, activity } = setup(["e7e5"]);
    await activity.newGame({ color: "white", elo: 1200 });
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
    await expect(activity.startDemo("not a fen")).rejects.toMatchObject({
      code: "invalid_position",
    });
    await activity.startDemo(DEMO_FEN);
    await expect(activity.demoMove("Qh5")).rejects.toMatchObject({ code: "illegal_move" });
  });
});

describe("a turn in flight", () => {
  it("lets a demo start while the turn is evaluating and returns to the finished turn", async () => {
    const { engine, activity } = setup(["e7e5"]);
    await activity.newGame({ color: "white", elo: 1200 });
    const release = engine.hold();
    const turn = activity.playerMove({ from: "e2", to: "e4" });
    await vi.waitFor(() => expect(activity.current()).toMatchObject({ pending: "evaluating" }));
    expect(activity.current()).toMatchObject({ input_enabled: false, legal_moves: [] });

    const demo = await activity.startDemo(DEMO_FEN);
    expect(demo.kind).toBe("demo");
    release();
    await turn;
    expect(activity.current()?.kind).toBe("demo");

    const back = await activity.leaveDemo();
    if (back?.kind !== "live_game") throw new Error("expected live_game");
    expect(back).toMatchObject({ pending: "none", input_enabled: true, phase: "player_turn" });
    expect(back.moves.map((m) => m.san)).toEqual(["e4", "e5"]);
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
