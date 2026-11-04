import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildCoachTools, COACH_TOOL_BASE_NAMES } from "../../src/coach/tools.js";
import { openDatabase } from "../../src/db/open.js";
import { AnalyzeSuperseded } from "../../src/engine/pool.js";
import { contentDir } from "../../src/paths.js";
import { makeWorld } from "../fakes/fake-world.js";

const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

function setup(replies: string[] = []) {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "game-tools-")));
  const fake = makeWorld(db, replies);
  const tools = buildCoachTools({ db, contentDir: contentDir(), world: fake.world });
  const find = (name: string) => {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`tool ${name} is not registered`);
    return found;
  };
  // Goes through the tool's own zod schema first, as the MCP server does before the handler.
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const def = find(name);
    const parsed = z.object(def.inputSchema).parse(input);
    const result = await def.handler(parsed as never, {});
    const text = (result.content[0] as { text: string }).text;
    return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
  };
  const accepts = (name: string, input: Record<string, unknown>) =>
    z.object(find(name).inputSchema).safeParse(input).success;
  return { ...fake, tools, call, accepts };
}

describe("registry", () => {
  it("registers exactly the names the allow-list advertises", () => {
    const { tools } = setup();
    expect(tools.map((entry) => entry.name).sort()).toEqual([...COACH_TOOL_BASE_NAMES].sort());
  });
});

describe("new_game", () => {
  it("starts a game and puts it on the board", async () => {
    const { call, activity } = setup();
    const out = await call("new_game", { color: "white", elo: 600 });
    expect(out.isError).toBe(false);
    expect(out.body).toMatchObject({ student_color: "white", elo: 600, turn: "white" });
    expect(activity.current()?.kind).toBe("live_game");
  });

  it("answers game_in_progress while one is unfinished", async () => {
    const { call } = setup();
    await call("new_game", { color: "white", elo: 600 });
    const again = await call("new_game", { color: "black", elo: 600 });
    expect(again).toMatchObject({ isError: true, body: { error: "game_in_progress" } });
  });

  it("rejects a bad color or an Elo outside 100..3190 at the schema", () => {
    const { accepts } = setup();
    expect(accepts("new_game", { color: "white", elo: 100 })).toBe(true);
    expect(accepts("new_game", { color: "white", elo: 3190 })).toBe(true);
    expect(accepts("new_game", { color: "white", elo: 99 })).toBe(false);
    expect(accepts("new_game", { color: "white", elo: 3191 })).toBe(false);
    expect(accepts("new_game", { color: "white", elo: 600.5 })).toBe(false);
    expect(accepts("new_game", { color: "green", elo: 600 })).toBe(false);
  });
});

describe("show_position and make_move", () => {
  it("shows a demo, plays a move on it, and refuses an illegal one", async () => {
    const { call } = setup();
    const shown = await call("show_position", { fen: AFTER_E4 });
    expect(shown.body).toEqual({ kind: "demo", fen: AFTER_E4, turn: "black", returns_to: null });
    const moved = await call("make_move", { san: "e5" });
    expect(moved.body).toMatchObject({ kind: "demo", turn: "white" });
    const illegal = await call("make_move", { san: "Ke5" });
    expect(illegal).toMatchObject({ isError: true, body: { error: "illegal_move" } });
  });

  it("answers not_in_demo outside a demo", async () => {
    const { call } = setup();
    const out = await call("make_move", { san: "e4" });
    expect(out).toMatchObject({ isError: true, body: { error: "not_in_demo" } });
  });

  it("answers not_in_demo over a live game too", async () => {
    const { call } = setup();
    await call("new_game", { color: "white", elo: 600 });
    expect(await call("make_move", { san: "e4" })).toMatchObject({
      body: { error: "not_in_demo" },
    });
  });

  it("returns to the live game kind underneath", async () => {
    const { call } = setup();
    await call("new_game", { color: "white", elo: 600 });
    const shown = await call("show_position", { fen: AFTER_E4 });
    expect(shown.body).toMatchObject({ returns_to: "live_game" });
  });

  it("rejects a FEN chess.js cannot load, and a SAN that is not short text", () => {
    const { accepts } = setup();
    expect(accepts("show_position", { fen: "not a fen" })).toBe(false);
    expect(accepts("show_position", { fen: AFTER_E4 })).toBe(true);
    expect(accepts("make_move", { san: "" })).toBe(false);
    expect(accepts("make_move", { san: "e4; rm -rf /" })).toBe(false);
  });
});

describe("get_game", () => {
  it("errors when there is neither a live nor a reviewed game", async () => {
    const { call } = setup();
    expect(await call("get_game")).toMatchObject({ isError: true, body: { error: "no_game" } });
  });

  it("returns the live game compactly, student moves graded and engine moves not", async () => {
    const { call, game } = setup(["e7e5"]);
    await call("new_game", { color: "white", elo: 600 });
    await game.playerMove({ from: "e2", to: "e4" });
    const out = await call("get_game");
    expect(out.body).toMatchObject({ source: "live", turn: "white", student_color: "white" });
    expect(out.body.moves).toEqual([
      { ply: 1, san: "e4", by: "student", cp_loss: 30, classification: "great", best: "d4" },
      { ply: 2, san: "e5", by: "engine" },
    ]);
  });

  it("returns the reviewed game when the activity is a review", async () => {
    const { call, game, activity } = setup(["e7e5"]);
    const { gameId } = await game.newGame({ color: "white", elo: 600 });
    await game.playerMove({ from: "e2", to: "e4" });
    await game.resign();
    await activity.openGame(gameId);
    const out = await call("get_game");
    expect(out.body).toMatchObject({ source: "review", game_id: gameId, result: "0-1" });
  });
});

describe("analyze", () => {
  it("analyzes the given FEN and reports three lines in SAN from the side to move", async () => {
    const { call, analyzed } = setup();
    const out = await call("analyze", { fen: AFTER_E4 });
    expect(analyzed).toEqual([AFTER_E4]);
    expect(out.body).toMatchObject({ fen: AFTER_E4, side_to_move: "black" });
    expect((out.body.lines as unknown[]).length).toBe(3);
  });

  it("falls back to the position on the board", async () => {
    const { call, analyzed } = setup();
    await call("show_position", { fen: AFTER_E4 });
    await call("analyze");
    expect(analyzed).toEqual([AFTER_E4]);
  });

  it("errors when no FEN is given and nothing is on the board", async () => {
    const { call, analyzed } = setup();
    expect(await call("analyze")).toMatchObject({ isError: true, body: { error: "no_position" } });
    expect(analyzed).toEqual([]);
  });

  it("reports a request replaced by a newer one", async () => {
    const { call, answer } = setup();
    answer.next = () => Promise.reject(new AnalyzeSuperseded());
    expect(await call("analyze", { fen: AFTER_E4 })).toMatchObject({
      isError: true,
      body: { error: "superseded" },
    });
  });
});

describe("resign_game", () => {
  it("resigns the live game", async () => {
    const { call, game } = setup();
    await call("new_game", { color: "white", elo: 600 });
    const out = await call("resign_game");
    expect(out.body).toEqual({ result: "0-1", termination: "resign" });
    expect(game.current()?.finishedAt).not.toBeNull();
  });

  it("answers no_game when there is none", async () => {
    const { call } = setup();
    expect(await call("resign_game")).toMatchObject({ isError: true, body: { error: "no_game" } });
  });
});
