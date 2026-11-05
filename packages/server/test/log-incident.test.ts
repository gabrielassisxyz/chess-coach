import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityService } from "../src/activity/service.js";
import { buildApp } from "../src/app.js";
import type { CoachWorld } from "../src/coach/game-tools.js";
import { CoachSession } from "../src/coach/session.js";
import { buildCoachTools } from "../src/coach/tools.js";
import { openDatabase } from "../src/db/open.js";
import { GameService } from "../src/game/service.js";
import { RecordingLog } from "../src/log.js";
import { contentDir } from "../src/paths.js";
import { FakeSdk } from "./fakes/fake-sdk.js";
import { ScriptedEngine } from "./fakes/scripted-engine.js";

const ORIGIN = "http://localhost:5173";
// The position after 1. e4 f6 2. Nf3 d5, two moves behind the board when the coach answered.
const AFTER_D5 = "rnbqkbnr/ppp1p1pp/5p2/3p4/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

// One coach turn as the SDK reports it: the tool call, the result the server tool gave, the end.
function coachTurn(output: unknown): SDKMessage[] {
  return [
    {
      type: "system",
      subtype: "init",
      session_id: "00000000-0000-4000-8000-000000000016",
      model: "claude-test",
      tools: ["mcp__chess__show_position"],
      apiKeySource: "none",
    },
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_demo",
            name: "mcp__chess__show_position",
            input: { fen: AFTER_D5 },
          },
        ],
      },
    },
    {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_demo", content: output, is_error: true },
        ],
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      usage: { input_tokens: 12, output_tokens: 34 },
    },
  ] as unknown as SDKMessage[];
}

async function socket(server: FastifyInstance) {
  const frames: { type?: string }[] = [];
  const ws = await server.injectWS(
    "/api/ws",
    { headers: { origin: ORIGIN, host: "localhost:5173" } },
    {
      onInit: (client) => client.on("message", (data) => frames.push(JSON.parse(data.toString()))),
    },
  );
  return { ws, frames };
}

describe("the 2026-11-05 incident, read back from the log alone", () => {
  it("shows the moves, the coach's refused rewind and the board staying on the game", async () => {
    const db = openDatabase(mkdtempSync(join(tmpdir(), "incident-")));
    const log = new RecordingLog();
    const game = new GameService({
      db,
      engine: new ScriptedEngine(["f7f6", "d7d5", "b8c6", "e7e5"]),
      log,
    });
    const activity = new ActivityService({ db, game, log });
    const world: CoachWorld = {
      game,
      activity,
      training: activity,
      analyze: async () => ({ fen: AFTER_D5, bestmove: "e4d5", lines: [] }),
      evaluateMove: async () => {
        throw new Error("not used");
      },
    };
    const showPosition = buildCoachTools({ db, contentDir: contentDir(), world }).find(
      (entry) => entry.name === "show_position",
    );
    // The coach's turn is scripted once the game is on the board, so the tool really refuses.
    const turns: SDKMessage[][] = [];
    const sdk = new FakeSdk({ turns });
    const coach = new CoachSession({
      db,
      query: sdk.query,
      contentDir: contentDir(),
      dataDir: mkdtempSync(join(tmpdir(), "incident-coach-")),
      world,
      env: {},
      log,
    });
    app = buildApp({ db, log, hub: { coach, activity, db, allowedOrigins: [ORIGIN] } });
    await app.ready();
    await coach.start();

    const { ws } = await socket(app);
    ws.send(JSON.stringify({ type: "new_game", command_id: "n1", color: "white", elo: 1200 }));
    await vi.waitFor(() => expect(log.named("ws.command_done")).toHaveLength(1));
    for (const [index, [from, to]] of [
      ["e2", "e4"],
      ["g1", "f3"],
      ["e4", "e5"],
    ].entries()) {
      ws.send(JSON.stringify({ type: "move", command_id: `m${index}`, from, to }));
      await vi.waitFor(() => expect(log.named("ws.command_done")).toHaveLength(index + 2));
    }
    const refused = await showPosition?.handler({ fen: AFTER_D5 } as never, {});
    expect(refused?.isError).toBe(true);
    turns.push(coachTurn(refused?.content));
    await coach.send("why was e5 bad?");
    await vi.waitFor(() => expect(log.named("coach.turn_end")).toHaveLength(1));
    ws.terminate();

    const moves = log.named("game.player_move").map((entry) => entry.fields);
    expect(moves.map((move) => move.san)).toEqual(["e4", "Nf3", "e5"]);
    for (const move of moves) expect(move.duration_ms).toBeGreaterThanOrEqual(0);
    expect(log.named("game.engine_move").map((entry) => entry.fields.san)).toEqual([
      "f6",
      "d5",
      "Nc6",
    ]);
    expect(log.named("ws.command").map((entry) => entry.fields.type)).toEqual([
      "new_game",
      "move",
      "move",
      "move",
    ]);

    const call = log.named("coach.tool_call")[0]?.fields;
    expect(call).toMatchObject({
      tool_use_id: "toolu_demo",
      name: "mcp__chess__show_position",
      turn: 1,
    });
    const result = log.named("coach.tool_result")[0]?.fields;
    expect(result).toMatchObject({
      tool_use_id: "toolu_demo",
      is_error: true,
      error_code: "live_game_active",
    });
    expect(result?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(log.named("coach.turn_end")[0]?.fields).toMatchObject({ turn: 1, output_tokens: 34 });

    const kinds = log.named("activity.change").map((entry) => entry.fields.to_kind);
    expect(kinds).not.toContain("demo");
    expect(new Set(kinds)).toEqual(new Set(["live_game"]));
    await coach.stop();
  });

  it("logs a refused command with its code next to the command that caused it", async () => {
    const db = openDatabase(mkdtempSync(join(tmpdir(), "incident-")));
    const log = new RecordingLog();
    const game = new GameService({ db, engine: new ScriptedEngine(["e7e5"]), log });
    const activity = new ActivityService({ db, game, log });
    const coach = {
      sessionRow: undefined,
      send: async () => {},
      resolvePermission: () => false,
      onEvent: () => () => {},
      onPermissionRequest: () => () => {},
      ensureSessionId: () => 1,
      flushNotifications: () => {},
    };
    app = buildApp({ db, log, hub: { coach, activity, db, allowedOrigins: [ORIGIN] } });
    await app.ready();
    const { ws } = await socket(app);
    ws.send(JSON.stringify({ type: "undo", command_id: "u1" }));
    ws.send("not json");
    await vi.waitFor(() => expect(log.named("ws.command_failed")).toHaveLength(1));
    await vi.waitFor(() => expect(log.named("ws.invalid_frame")).toHaveLength(1));
    expect(log.named("ws.command_failed")[0]).toMatchObject({
      level: "warn",
      fields: { command_id: "u1", type: "undo", code: "not_in_live_game" },
    });
    expect(log.named("ws.invalid_frame")[0]?.fields).toMatchObject({ reason: "invalid_json" });
    expect(log.named("ws.connect")[0]?.fields).toMatchObject({ conn: 1, origin: ORIGIN });
    ws.terminate();
    await vi.waitFor(() => expect(log.named("ws.disconnect")).toHaveLength(1));
  });
});
