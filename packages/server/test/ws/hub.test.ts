import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerEventSchema } from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityService } from "../../src/activity/service.js";
import { buildApp } from "../../src/app.js";
import { appendChatMessage, createCoachSession } from "../../src/db/chat.js";
import { openDatabase } from "../../src/db/open.js";
import { GameService } from "../../src/game/service.js";
import { BOOTSTRAP_TAIL } from "../../src/ws/hub.js";
import { FakeCoach } from "../fakes/fake-coach.js";
import { ScriptedEngine } from "../fakes/scripted-engine.js";

const VITE_ORIGIN = "http://localhost:5173";
const VITE_HOST = "localhost:5173";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(options: { pingIntervalMs?: number; origins?: string[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-"));
  const db = openDatabase(dataDir);
  const coach = new FakeCoach();
  const game = new GameService({ db, engine: new ScriptedEngine(["e7e5", "g8f6"]) });
  const activity = new ActivityService({ db, game });
  app = buildApp({
    hub: {
      coach,
      activity,
      db,
      allowedOrigins: options.origins ?? [VITE_ORIGIN, "http://127.0.0.1:5173"],
      ...(options.pingIntervalMs === undefined ? {} : { pingIntervalMs: options.pingIntervalMs }),
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, db, coach, activity, port: (app.server.address() as AddressInfo).port };
}

// The reply to a raw upgrade request: the status line is all that matters for the Origin check.
function upgrade(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      port,
      host: "127.0.0.1",
      agent: false,
      path: "/api/ws",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

async function connect(
  server: FastifyInstance,
  headers = { origin: VITE_ORIGIN, host: VITE_HOST },
) {
  const inbox: unknown[] = [];
  const waiters: ((value: unknown) => void)[] = [];
  const socket = await server.injectWS(
    "/api/ws",
    { headers },
    {
      onInit: (ws) => {
        ws.on("message", (data) => {
          const value: unknown = JSON.parse(data.toString());
          const waiter = waiters.shift();
          if (waiter) waiter(value);
          else inbox.push(value);
        });
      },
    },
  );
  const next = (): Promise<unknown> =>
    inbox.length > 0
      ? Promise.resolve(inbox.shift())
      : new Promise((resolve) => waiters.push(resolve));
  return { socket, next };
}

describe("upgrade origin check", () => {
  it("accepts the Vite origin", async () => {
    const { port } = await start();
    expect(await upgrade(port, { origin: VITE_ORIGIN, host: VITE_HOST })).toBe(101);
  });

  it("refuses a foreign origin with 403", async () => {
    const { port } = await start();
    expect(await upgrade(port, { origin: "http://evil.example", host: VITE_HOST })).toBe(403);
  });

  it("refuses a missing origin with 403", async () => {
    const { port } = await start();
    expect(await upgrade(port, { host: VITE_HOST })).toBe(403);
  });

  it("refuses an allowed origin arriving under a foreign Host", async () => {
    const { port } = await start();
    expect(await upgrade(port, { origin: VITE_ORIGIN, host: "evil.example:5173" })).toBe(403);
  });

  it("follows the configured origins", async () => {
    const { port } = await start({ origins: ["http://localhost:4000"] });
    expect(await upgrade(port, { origin: VITE_ORIGIN, host: VITE_HOST })).toBe(403);
    expect(await upgrade(port, { origin: "http://localhost:4000", host: "localhost:4000" })).toBe(
      101,
    );
  });
});

describe("hub", () => {
  it("bootstraps with the last 200 rows of the open session", async () => {
    const { app, db, coach } = await start();
    const session = createCoachSession(db, { promptVersion: "v" });
    coach.sessionRow = session;
    for (let i = 1; i <= BOOTSTRAP_TAIL + 50; i++) {
      appendChatMessage(db, session.id, {
        role: "user",
        kind: "text",
        contentJson: JSON.stringify({ text: `m${i}` }),
      });
    }
    const { next } = await connect(app);
    const event = ServerEventSchema.parse(await next());
    if (event.type !== "bootstrap") throw new Error("expected bootstrap");
    expect(event.transcript).toHaveLength(BOOTSTRAP_TAIL);
    expect(event.transcript[0]?.content).toEqual({ text: "m51" });
    expect(event.transcript.at(-1)?.content).toEqual({ text: "m250" });
  });

  it("bootstraps empty before a session exists", async () => {
    const { app } = await start();
    const { next } = await connect(app);
    expect(await next()).toEqual({
      type: "bootstrap",
      transcript: [],
      activity: null,
      current_elo: 600,
      paused_training: null,
    });
  });

  it("answers a malformed frame with a typed error carrying the command_id", async () => {
    const { app } = await start();
    const { socket, next } = await connect(app);
    await next();
    socket.send(JSON.stringify({ type: "say", command_id: "c1", text: "" }));
    expect(await next()).toMatchObject({
      type: "error",
      code: "invalid_command",
      command_id: "c1",
    });
    socket.send(JSON.stringify({ type: "say", command_id: "c2", text: "x".repeat(4001) }));
    expect(await next()).toMatchObject({
      type: "error",
      code: "invalid_command",
      command_id: "c2",
    });
    socket.send(JSON.stringify({ type: "nope" }));
    const noId = (await next()) as { code: string; command_id?: string };
    expect(noId.code).toBe("invalid_command");
    expect(noId.command_id).toBeUndefined();
  });

  it("answers a frame that is not JSON with invalid_json", async () => {
    const { app } = await start();
    const { socket, next } = await connect(app);
    await next();
    socket.send("{not json");
    expect(await next()).toMatchObject({ type: "error", code: "invalid_json" });
  });

  it("routes say to the coach and approve_tool to resolvePermission", async () => {
    const { app, coach } = await start();
    const { socket, next } = await connect(app);
    await next();
    coach.knownRequests.add("r1");
    socket.send(JSON.stringify({ type: "say", command_id: "c1", text: "hello" }));
    socket.send(
      JSON.stringify({ type: "approve_tool", command_id: "c2", request_id: "r1", allow: true }),
    );
    socket.send(
      JSON.stringify({ type: "approve_tool", command_id: "c3", request_id: "zz", allow: true }),
    );
    expect(await next()).toMatchObject({ code: "unknown_request", command_id: "c3" });
    expect(coach.sent).toEqual(["hello"]);
    expect(coach.resolved).toEqual([{ requestId: "r1", allow: true }]);
  });

  it("reports a failing send as coach_error with the command_id", async () => {
    const { app, coach } = await start();
    const { socket, next } = await connect(app);
    await next();
    coach.failSendWith = new Error("coach session not started");
    socket.send(JSON.stringify({ type: "say", command_id: "c9", text: "hi" }));
    expect(await next()).toMatchObject({
      code: "coach_error",
      command_id: "c9",
      message: "coach session not started",
    });
  });

  it("broadcasts chat events to every socket, merging deltas under one message_id", async () => {
    const { app, coach } = await start();
    const a = await connect(app);
    const b = await connect(app);
    await a.next();
    await b.next();
    coach.emit({ kind: "text_delta", text: "He" });
    coach.emit({ kind: "text_delta", text: "llo" });
    coach.emit({ kind: "tool_use", toolUseId: "t1", name: "x", input: { a: 1 } });
    coach.emit({ kind: "text_delta", text: "again" });
    const seen = [];
    for (let i = 0; i < 4; i++) seen.push(ServerEventSchema.parse(await a.next()));
    const ids = seen.map((e) => (e.type === "chat" ? [e.message_id, e.seq] : null));
    expect(ids).toEqual([
      [1, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(await b.next()).toMatchObject({ type: "chat", seq: 1, event: { text: "He" } });
  });

  it("forwards permission requests to every socket", async () => {
    const { app, coach } = await start();
    const { next } = await connect(app);
    await next();
    coach.requestPermission({ requestId: "r1", toolName: "Bash", input: { cmd: "ls" } });
    expect(await next()).toEqual({
      type: "permission_request",
      request_id: "r1",
      tool_name: "Bash",
      input: { cmd: "ls" },
    });
  });

  it("pings an idle socket", async () => {
    const { app } = await start({ pingIntervalMs: 20 });
    const { socket, next } = await connect(app);
    await next();
    await new Promise<void>((resolve) => socket.once("ping", () => resolve()));
  });

  it("includes the current activity in bootstrap", async () => {
    const { app, activity } = await start();
    await activity.startDemo("8/8/8/8/8/8/8/K6k w - - 0 1");
    const { next } = await connect(app);
    const event = ServerEventSchema.parse(await next());
    if (event.type !== "bootstrap") throw new Error("expected bootstrap");
    expect(event.activity).toMatchObject({ kind: "demo", activity_id: 1 });
  });

  it("drives a game from commands and broadcasts every activity change", async () => {
    const { app } = await start();
    const a = await connect(app);
    const b = await connect(app);
    await a.next();
    await b.next();
    a.socket.send(JSON.stringify({ type: "new_game", command_id: "n", color: "white", elo: 1200 }));
    const opened = (await b.next()) as {
      type: string;
      state: { kind: string; activity_id: number };
    };
    expect(opened).toMatchObject({
      type: "activity",
      state: { kind: "live_game", activity_id: 1 },
    });
    a.socket.send(
      JSON.stringify({ type: "move", command_id: "m", from: "e2", to: "e4", activity_id: 1 }),
    );
    const states: string[] = [];
    for (let i = 0; i < 2; i++) {
      const event = (await b.next()) as { state: { pending: string } };
      states.push(event.state.pending);
    }
    expect(states).toEqual(["evaluating", "none"]);
  });

  it("answers a refused command with its typed code and command_id", async () => {
    const { app, activity } = await start();
    const { socket, next } = await connect(app);
    await next();
    socket.send(JSON.stringify({ type: "leave_demo", command_id: "l1" }));
    expect(await next()).toMatchObject({ code: "not_in_demo", command_id: "l1" });
    socket.send(JSON.stringify({ type: "new_game", command_id: "n", color: "white", elo: 1200 }));
    await next();
    // A demo can only cover a finished game, so the game ends before the coach's demo.
    await activity.resign();
    await next();
    await activity.startDemo("8/8/8/8/8/8/8/K6k w - - 0 1");
    await next();
    socket.send(JSON.stringify({ type: "move", command_id: "m1", from: "e2", to: "e4" }));
    expect(await next()).toMatchObject({ code: "demo_active", command_id: "m1" });
    socket.send(JSON.stringify({ type: "resign", command_id: "r1", activity_id: 1 }));
    expect(await next()).toMatchObject({ code: "stale_activity", command_id: "r1" });
    socket.send(JSON.stringify({ type: "open_game", command_id: "o1", game_id: 77 }));
    expect(await next()).toMatchObject({ code: "game_not_found", command_id: "o1" });
  });

  it("passes the game's own error code through", async () => {
    const { app } = await start();
    const { socket, next } = await connect(app);
    await next();
    socket.send(JSON.stringify({ type: "new_game", command_id: "n", color: "white", elo: 50 }));
    expect(await next()).toMatchObject({ code: "invalid_elo", command_id: "n" });
  });

  it("rejects a move with a malformed square before it reaches the game", async () => {
    const { app } = await start();
    const { socket, next } = await connect(app);
    await next();
    socket.send(JSON.stringify({ type: "move", command_id: "m", from: "z9", to: "e4" }));
    expect(await next()).toMatchObject({ code: "invalid_command", command_id: "m" });
  });
});
