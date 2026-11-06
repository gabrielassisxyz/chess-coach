import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientCommandSchema, ServerEventSchema } from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityService } from "../../src/activity/service.js";
import { buildApp } from "../../src/app.js";
import { createCoachSession } from "../../src/db/chat.js";
import { type Database, openDatabase } from "../../src/db/open.js";
import { GameService } from "../../src/game/service.js";
import { type Log, RecordingLog } from "../../src/log.js";
import { ReviewDesk } from "../../src/srs/review.js";
import { FakeCoach } from "../fakes/fake-coach.js";
import { ScriptedEngine } from "../fakes/scripted-engine.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const BACK_RANK = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";

function seededDatabase(): Database {
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
  return db;
}

// A second call over the same database is a server restart: every in-memory object is new.
async function start(db: Database = seededDatabase(), log?: Log) {
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
      ...(log ? { log } : {}),
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
      { type: "try_move", uci: "e7e8q" },
      { type: "try_move", uci: "a1a8", activity_id: 3 },
      { type: "show_solution" },
      { type: "show_solution", activity_id: 3 },
      { type: "resume_training" },
      { type: "discard_training" },
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
      { type: "answer", uci: "a1a8" },
      { type: "try_move" },
      { type: "try_move", uci: "z9z9" },
    ];
    for (const command of bad) {
      expect(ClientCommandSchema.safeParse({ ...command, command_id: "c" }).success).toBe(false);
    }
  });

  it("routes try_move to the puzzle and sends the training event beside the activity", async () => {
    const server = await start();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({ type: "start_training", command_id: "c1", mode: "puzzles", motif: "fork" }),
    );
    const first = ServerEventSchema.parse(await next("training"));
    expect(first).toMatchObject({ type: "training", status: "prompt" });
    await next("activity");
    socket.send(JSON.stringify({ type: "try_move", command_id: "c2", uci: "a1a8" }));
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

  it("keeps the item open on a wrong try_move, ends it on show_solution, then refuses a try", async () => {
    const server = await start();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({ type: "start_training", command_id: "c1", mode: "puzzles", motif: "fork" }),
    );
    await next("training");
    const served = ServerEventSchema.parse(await next("activity"));
    socket.send(JSON.stringify({ type: "try_move", command_id: "c2", uci: "a1a2" }));
    const missed = ServerEventSchema.parse(await next("activity"));
    expect(missed).toMatchObject({
      state: {
        kind: "training",
        status: "prompt",
        input_enabled: true,
        fen: BACK_RANK,
        tries: 1,
        last_try: { uci: "a1a2", correct: false },
      },
    });
    expect((missed as { state: { legal_moves: unknown } }).state.legal_moves).toEqual(
      (served as { state: { legal_moves: unknown } }).state.legal_moves,
    );
    socket.send(JSON.stringify({ type: "show_solution", command_id: "c3" }));
    expect(ServerEventSchema.parse(await next("activity"))).toMatchObject({
      state: { status: "failed", gave_up: true, solution_line: ["a1a8"], tries: 1 },
    });
    socket.send(JSON.stringify({ type: "try_move", command_id: "c4", uci: "a1a8" }));
    expect(await next("error")).toMatchObject({ code: "item_finished", command_id: "c4" });
    socket.send(JSON.stringify({ type: "show_solution", command_id: "c5" }));
    expect(await next("error")).toMatchObject({ code: "item_finished", command_id: "c5" });
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

  it("routes explore without grading, and refuses move inside training with use_try_move", async () => {
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
    expect(await next("error")).toMatchObject({ code: "use_try_move", command_id: "c3" });
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

describe("a paused practice session over the socket", () => {
  const send = (socket: { send(text: string): void }, command: Record<string, unknown>) =>
    socket.send(JSON.stringify(command));

  it("offers the run in the bootstrap after a server restart and resumes it at the same item", async () => {
    const db = seededDatabase();
    const before = await start(db);
    const first = await connect(before);
    await first.next("bootstrap");
    send(first.socket, {
      type: "start_training",
      command_id: "c1",
      mode: "puzzles",
      motif: "drill",
      size: 5,
    });
    const served = ServerEventSchema.parse(await first.next("activity"));
    if (served.type !== "activity" || served.state?.kind !== "training") throw new Error("no item");
    expect(served.paused_training).toBeNull();
    const activityId = served.state.activity_id;
    send(first.socket, {
      type: "try_move",
      command_id: "c2",
      uci: "a1a8",
      activity_id: activityId,
    });
    await first.next("activity");
    send(first.socket, { type: "next_training_item", command_id: "c3", activity_id: activityId });
    const second = ServerEventSchema.parse(await first.next("activity"));
    if (second.type !== "activity" || second.state?.kind !== "training") throw new Error("no item");
    first.socket.terminate();
    await before.close();
    app = undefined;

    const after = await start(db);
    const { socket, next } = await connect(after);
    const boot = ServerEventSchema.parse(await next("bootstrap"));
    if (boot.type !== "bootstrap") throw new Error("expected bootstrap");
    expect(boot.activity).toBeNull();
    expect(boot.paused_training).toMatchObject({
      mode: "puzzles",
      motif: "drill",
      position: 1,
      size: 5,
      solved: 1,
      failed: 0,
    });

    send(socket, { type: "resume_training", command_id: "r1" });
    const resumed = ServerEventSchema.parse(await next("activity"));
    if (resumed.type !== "activity" || resumed.state?.kind !== "training") {
      throw new Error("expected training");
    }
    expect(resumed.state.item).toEqual(second.state.item);
    expect(resumed.paused_training).toBeNull();
  });

  it("discards a paused run, logs both commands, and refuses them when none is paused", async () => {
    const log = new RecordingLog();
    const server = await start(seededDatabase(), log);
    const { socket, next } = await connect(server);
    await next("bootstrap");
    send(socket, { type: "resume_training", command_id: "r0" });
    expect(await next("error")).toMatchObject({ code: "no_paused_training", command_id: "r0" });
    send(socket, { type: "discard_training", command_id: "d0" });
    expect(await next("error")).toMatchObject({ code: "no_paused_training", command_id: "d0" });

    send(socket, { type: "start_training", command_id: "c1", mode: "puzzles", motif: "fork" });
    await next("activity");
    send(socket, { type: "new_game", command_id: "c2", color: "white", elo: 1200 });
    const paused = ServerEventSchema.parse(await next("activity"));
    if (paused.type !== "activity") throw new Error("expected activity");
    expect(paused.state?.kind).toBe("live_game");
    expect(paused.paused_training).toMatchObject({ mode: "puzzles", position: 0, size: 1 });

    send(socket, { type: "discard_training", command_id: "d1" });
    const discarded = ServerEventSchema.parse(await next("activity"));
    if (discarded.type !== "activity") throw new Error("expected activity");
    expect(discarded.state?.kind).toBe("live_game");
    expect(discarded.paused_training).toBeNull();

    const commands = log.named("ws.command").map((entry) => entry.fields.type);
    expect(commands).toEqual(
      expect.arrayContaining(["resume_training", "discard_training", "start_training"]),
    );
  });
});
