import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientCommandSchema, ServerEventSchema } from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityService } from "../../src/activity/service.js";
import { buildApp } from "../../src/app.js";
import { createCoachSession } from "../../src/db/chat.js";
import { openDatabase } from "../../src/db/open.js";
import { GameService } from "../../src/game/service.js";
import { ReviewDesk } from "../../src/srs/review.js";
import { FakeCoach } from "../fakes/fake-coach.js";
import { ScriptedEngine } from "../fakes/scripted-engine.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const BACK_RANK = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";

async function start() {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "hub-train-")));
  db.prepare(
    `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
     VALUES ('f1', 'test', 'fork', 'easy', ?, '["a1a8"]', '["Ra8#"]', 'why')`,
  ).run(BACK_RANK);
  for (let i = 0; i < 12; i++) {
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
       VALUES (?, 'test', 'drill', 'easy', ?, '["a1a8"]', '["Ra8#"]', 'why')`,
    ).run(`d${i}`, BACK_RANK);
  }
  const session = createCoachSession(db, { promptVersion: "v" });
  const notifications = { sessionId: () => session.id };
  const activity = new ActivityService({
    db,
    game: new GameService({ db, engine: new ScriptedEngine([]) }),
    training: { desk: new ReviewDesk({ db, notifications }), notifications },
  });
  app = buildApp({
    hub: {
      coach: new FakeCoach(),
      activity,
      db,
      allowedOrigins: ["http://localhost:5173"],
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  return app;
}

async function connect(server: FastifyInstance) {
  const inbox: Record<string, unknown>[] = [];
  const socket = await server.injectWS(
    "/api/ws",
    { headers: { origin: "http://localhost:5173", host: "localhost:5173" } },
    {
      onInit: (ws) =>
        ws.on("message", (data) =>
          inbox.push(JSON.parse(data.toString()) as Record<string, unknown>),
        ),
    },
  );
  const next = async (type: string): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 200; i++) {
      const index = inbox.findIndex((event) => event.type === type);
      if (index >= 0) return inbox.splice(index, 1)[0] as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no ${type} event`);
  };
  return { socket, next, inbox };
}

describe("training over the socket", () => {
  it("validates the training commands", () => {
    const ok = [
      { type: "start_training", mode: "puzzles", motif: "fork" },
      { type: "start_training", mode: "srs" },
      { type: "start_training", mode: "puzzles", size: 5 },
      { type: "start_training", mode: "openings", color: "white", size: 20 },
      { type: "rate_card", exposure_id: "x", quality: 5 },
      { type: "next_training_item" },
      { type: "end_training", activity_id: 3 },
      { type: "explore", kind: "move", uci: "e2e4", activity_id: 3 },
      { type: "explore", kind: "undo" },
      { type: "answer", uci: "e7e8q" },
    ];
    for (const command of ok) {
      expect(ClientCommandSchema.safeParse({ ...command, command_id: "c" }).success).toBe(true);
    }
    const bad = [
      { type: "start_training", mode: "nope" },
      { type: "start_training", mode: "puzzles", size: 7 },
      { type: "start_training", mode: "puzzles", size: "5" },
      { type: "rate_card", exposure_id: "x", quality: 6 },
      { type: "rate_card", quality: 3 },
      { type: "explore", kind: "jump" },
      { type: "explore", kind: "move", uci: "e2" },
      { type: "answer" },
      { type: "answer", uci: "z9z9" },
    ];
    for (const command of bad) {
      expect(ClientCommandSchema.safeParse({ ...command, command_id: "c" }).success).toBe(false);
    }
  });

  it("routes answer to the puzzle and sends the training event beside the activity", async () => {
    const server = await start();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({ type: "start_training", command_id: "c1", mode: "puzzles", motif: "fork" }),
    );
    const first = ServerEventSchema.parse(await next("training"));
    expect(first).toMatchObject({ type: "training", status: "prompt" });
    await next("activity");
    socket.send(JSON.stringify({ type: "answer", command_id: "c2", uci: "a1a8" }));
    const solved = await next("training");
    expect(solved).toMatchObject({ status: "solved" });
    socket.send(
      JSON.stringify({ type: "rate_card", command_id: "c3", exposure_id: "x", quality: 3 }),
    );
    expect(await next("error")).toMatchObject({ code: "exposure_unknown", command_id: "c3" });
    socket.send(JSON.stringify({ type: "next_training_item", command_id: "c4" }));
    const ended = await next("training");
    expect(ended).toMatchObject({ summary: { solved: 1, failed: 0 } });
    socket.close();
  });

  it("routes size to the queue and refuses an unlisted one with invalid_command", async () => {
    const server = await start();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({ type: "start_training", command_id: "c1", mode: "puzzles", size: 7 }),
    );
    expect(await next("error")).toMatchObject({ code: "invalid_command" });
    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "c2",
        mode: "puzzles",
        motif: "drill",
        size: 5,
      }),
    );
    expect(ServerEventSchema.parse(await next("training"))).toMatchObject({
      status: "prompt",
      item: { queue_length: 5 },
    });
    socket.close();
  });

  it("shows a reconnecting client the same trail and served_at in bootstrap", async () => {
    const server = await start();
    const first = await connect(server);
    await first.next("bootstrap");
    first.socket.send(
      JSON.stringify({ type: "start_training", command_id: "c1", mode: "puzzles", motif: "fork" }),
    );
    await first.next("training");
    await first.next("activity");
    first.socket.send(
      JSON.stringify({ type: "explore", command_id: "c2", kind: "move", uci: "g1h1" }),
    );
    const live = ServerEventSchema.parse(await first.next("activity"));
    first.socket.close();
    const second = await connect(server);
    const boot = ServerEventSchema.parse(await second.next("bootstrap"));
    const state = (boot as { activity: unknown }).activity;
    expect(state).toEqual((live as { state: unknown }).state);
    expect(state).toMatchObject({
      served_at: expect.any(String),
      exploring: { trail: [{ seq: 1, kind: "move", line_san: ["Kh1"] }] },
    });
    second.socket.close();
  });

  it("routes explore without grading, and refuses move inside training with use_answer", async () => {
    const server = await start();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({ type: "start_training", command_id: "c1", mode: "puzzles", motif: "fork" }),
    );
    await next("training");
    await next("activity");
    socket.send(JSON.stringify({ type: "explore", command_id: "c2", kind: "move", uci: "g1h1" }));
    const explored = ServerEventSchema.parse(await next("activity"));
    expect(explored).toMatchObject({
      state: { kind: "training", status: "prompt", exploring: { line_san: ["Kh1"] } },
    });
    socket.send(JSON.stringify({ type: "move", command_id: "c3", from: "a1", to: "a8" }));
    expect(await next("error")).toMatchObject({ code: "use_answer", command_id: "c3" });
    socket.send(JSON.stringify({ type: "explore", command_id: "c4", kind: "move", uci: "a1a8" }));
    expect(await next("error")).toMatchObject({ code: "illegal_exploration", command_id: "c4" });
    socket.close();
  });

  it("refuses explore with not_exploring when no training item is on the board", async () => {
    const server = await start();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(JSON.stringify({ type: "explore", command_id: "c1", kind: "undo" }));
    expect(await next("error")).toMatchObject({ code: "not_exploring", command_id: "c1" });
    socket.close();
  });
});
