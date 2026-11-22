import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANALYSIS_BUDGET_MS,
  ClientCommandSchema,
  MIX_PRACTICE_MOTIF,
  ServerEventSchema,
} from "@chess-coach/shared";
import { Chess } from "chess.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityService } from "../../src/activity/service.js";
import { buildApp } from "../../src/app.js";
import { createCoachSession } from "../../src/db/chat.js";
import { insertFoundPosition } from "../../src/db/found-positions.js";
import { type Database, openDatabase } from "../../src/db/open.js";
import {
  createRepertoireVariation,
  insertRepertoireOwnMove,
  upsertRepertoireReply,
} from "../../src/db/repertoires.js";
import { endRunsLeftOpenAtStart } from "../../src/db/training.js";
import { EngineFault } from "../../src/engine/errors.js";
import type { EvalCache } from "../../src/engine/eval-cache.js";
import { AnalyzeSuperseded, EnginePool } from "../../src/engine/pool.js";
import type { SearchRequest, SearchResult } from "../../src/engine/uci.js";
import { GameService } from "../../src/game/service.js";
import type { Log } from "../../src/log.js";
import { RecordingLog } from "../../src/log.js";
import { positionKey } from "../../src/openings/from-games.js";
import { ReviewDesk } from "../../src/srs/review.js";
import { FakeCoach } from "../fakes/fake-coach.js";
import { ScriptedEngine } from "../fakes/scripted-engine.js";
import { openFixtureCache, storedSet } from "../support/eval-cache-fixture.js";
import { FakeEngineProcess, type GoRequest } from "../support/fake-engine-process.js";

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

// A second call over the same database is a server restart: every in-memory object is new, and the
// runs the last process left open are ended before anything is served, as the server's start does.
async function start(db: Database = seededDatabase(), log?: Log) {
  endRunsLeftOpenAtStart(db, new Date().toISOString());
  const session = createCoachSession(db, { promptVersion: "v" });
  const notifications = { sessionId: () => session.id };
  const activity = new ActivityService({
    db,
    game: new GameService({ db, engine: new ScriptedEngine([]) }),
    training: { desk: new ReviewDesk({ db, notifications }), notifications },
  });
  app = buildApp({
    hub: {
      coach: new FakeCoach(db),
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
    throw new Error(`no ${type} event; inbox: ${JSON.stringify(inbox).slice(0, 600)}`);
  };
  return { socket, next, inbox };
}

describe("training over the socket", () => {
  it("validates the training commands", () => {
    const ok = [
      { type: "start_training", mode: "puzzles", motif: "fork" },
      { type: "start_training", mode: "srs" },
      { type: "start_training", mode: "puzzles" },
      { type: "start_training", mode: "openings", color: "white", opening: "Italian Game" },
      { type: "rate_card", exposure_id: "x", grade: 1 },
      { type: "rate_card", exposure_id: "x", grade: 2 },
      { type: "rate_card", exposure_id: "x", grade: 3 },
      { type: "rate_card", exposure_id: "x", grade: 4 },
      { type: "next_training_item" },
      { type: "retry_item" },
      { type: "retry_item", activity_id: 3 },
      { type: "skip_first_showings" },
      { type: "skip_first_showings", activity_id: 3 },
      { type: "end_training", activity_id: 3 },
      { type: "explore", kind: "move", uci: "e2e4", activity_id: 3 },
      { type: "explore", kind: "undo" },
      { type: "try_move", uci: "e7e8q" },
      { type: "try_move", uci: "a1a8", activity_id: 3 },
      { type: "show_solution" },
      { type: "show_solution", activity_id: 3 },
      { type: "ask_coach_about_item", activity_id: 3 },
      { type: "drawings", shapes: [], activity_id: 3 },
      {
        type: "drawings",
        shapes: [
          { orig: "e4", dest: "e5", color: "red" },
          { orig: "d5", color: "green" },
        ],
        activity_id: 3,
      },
      { type: "analyse", fen: BACK_RANK, lines: 3, depth: 12 },
      { type: "analyse", fen: BACK_RANK, activity_id: 3 },
    ];
    for (const command of ok) {
      expect(ClientCommandSchema.safeParse({ ...command, command_id: "c" }).success).toBe(true);
    }
    const bad = [
      { type: "start_training", mode: "nope" },
      { type: "start_training", mode: "puzzles", size: 5 },
      { type: "start_training", mode: "puzzles", motif: "fork", size: 10 },
      { type: "start_training", mode: "openings", color: "white", size: 20 },
      { type: "start_training", mode: "puzzles", size: 7 },
      { type: "start_training", mode: "puzzles", size: "5" },
      { type: "start_training", mode: "puzzles", sizes: 10 },
      { type: "start_training", mode: "openings", color: "white", opening: "" },
      { type: "start_training", mode: "openings", color: "white", opening: "x".repeat(101) },
      { type: "start_training", mode: "openings", color: "white", opening: 7 },
      { type: "rate_card", exposure_id: "x", grade: 0 },
      { type: "rate_card", exposure_id: "x", grade: 5 },
      { type: "rate_card", exposure_id: "x", grade: 2.5 },
      { type: "rate_card", exposure_id: "x", grade: "3" },
      { type: "rate_card", exposure_id: "x", quality: 3 },
      { type: "rate_card", exposure_id: "x", quality: 3, grade: 3 },
      { type: "rate_card", grade: 3 },
      { type: "explore", kind: "jump" },
      { type: "explore", kind: "move", uci: "e2" },
      { type: "answer", uci: "a1a8" },
      { type: "try_move" },
      { type: "try_move", uci: "z9z9" },
      { type: "drawings", shapes: [{ orig: "e9", color: "green" }] },
      { type: "drawings", shapes: [{ orig: "e4", dest: "e9", color: "green" }] },
      { type: "drawings", shapes: [{ orig: "e4", color: "purple" }] },
      {
        type: "drawings",
        shapes: Array.from({ length: 33 }, () => ({ orig: "e4", color: "green" })),
      },
      { type: "resume_training" },
      { type: "discard_training" },
      { type: "retry_item", activity_id: 0 },
      { type: "retry_item", activity_id: "3" },
      { type: "retry" },
      { type: "skip_first_showings", activity_id: 0 },
      { type: "skip_first_showings", activity_id: "3" },
      { type: "skip_first_showings", extra: true },
      { type: "analyse", fen: "short" },
      { type: "analyse", fen: BACK_RANK, lines: 6 },
      { type: "analyse", fen: BACK_RANK, depth: 4 },
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
    expect(ServerEventSchema.parse(await next("chat_row"))).toMatchObject({
      tab: "practice",
      entry: { role: "system", kind: "text", content: { label: "Puzzles" } },
    });
    socket.send(JSON.stringify({ type: "try_move", command_id: "c2", uci: "a1a8" }));
    const solved = await next("training");
    expect(solved).toMatchObject({ status: "solved" });
    socket.send(
      JSON.stringify({ type: "rate_card", command_id: "c3", exposure_id: "x", grade: 3 }),
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

  it("routes retry_item to the ended puzzle and refuses it by code on an open item and an ended queue", async () => {
    const log = new RecordingLog();
    const server = await start(seededDatabase(), log);
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({ type: "start_training", command_id: "c1", mode: "puzzles", motif: "fork" }),
    );
    const served = (await next("activity")) as { state: { activity_id: number; item: unknown } };
    await next("training");
    const id = served.state.activity_id;
    const failedOf = (commandId: string) =>
      log.named("ws.command_failed").find((entry) => entry.fields.command_id === commandId);
    const retry = (commandId: string, activityId: number = id) =>
      socket.send(
        JSON.stringify({ type: "retry_item", command_id: commandId, activity_id: activityId }),
      );

    retry("c2");
    expect(await next("error")).toMatchObject({ code: "invalid_state", command_id: "c2" });
    expect(failedOf("c2")).toMatchObject({ level: "warn", fields: { code: "invalid_state" } });

    socket.send(JSON.stringify({ type: "try_move", command_id: "c3", uci: "a1a8" }));
    expect(await next("training")).toMatchObject({ status: "solved" });
    await next("activity");
    retry("c4", id + 1);
    expect(await next("error")).toMatchObject({ code: "stale_activity", command_id: "c4" });

    retry("c5");
    expect(ServerEventSchema.parse(await next("activity"))).toMatchObject({
      type: "activity",
      state: {
        kind: "training",
        activity_id: id,
        status: "prompt",
        retry: true,
        tries: 0,
        moves: [],
        item: served.state.item,
      },
    });
    expect(ServerEventSchema.parse(await next("training"))).toMatchObject({
      type: "training",
      status: "prompt",
      item: served.state.item,
    });
    expect(log.named("ws.command_done").map((entry) => entry.fields.type)).toContain("retry_item");

    socket.send(JSON.stringify({ type: "show_solution", command_id: "c6" }));
    expect(await next("training")).toMatchObject({ status: "failed" });
    await next("activity");
    socket.send(JSON.stringify({ type: "next_training_item", command_id: "c7" }));
    expect(await next("training")).toMatchObject({ summary: { solved: 1, failed: 0 } });
    await next("activity");
    retry("c8");
    expect(await next("error")).toMatchObject({ code: "item_finished", command_id: "c8" });
    expect(failedOf("c8")).toMatchObject({ level: "warn", fields: { code: "item_finished" } });
    socket.close();
  });

  it("refuses a rating that carries a quality, or a grade outside 1 to 4, with invalid_command", async () => {
    const server = await start();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    const refused = [
      ["q1", { quality: 3 }],
      ["q2", { quality: 3, grade: 3 }],
      ["g0", { grade: 0 }],
      ["g5", { grade: 5 }],
      ["gf", { grade: 2.5 }],
      ["gn", {}],
    ] as const;
    for (const [commandId, fields] of refused) {
      socket.send(
        JSON.stringify({ type: "rate_card", command_id: commandId, exposure_id: "x", ...fields }),
      );
      expect(await next("error")).toMatchObject({ code: "invalid_command", command_id: commandId });
    }
    // A grade from 1 to 4 passes the schema, and is then refused for the exposure it names.
    for (const grade of [1, 2, 3, 4]) {
      socket.send(
        JSON.stringify({
          type: "rate_card",
          command_id: `ok${grade}`,
          exposure_id: "x",
          grade,
        }),
      );
      expect(await next("error")).toMatchObject({ command_id: `ok${grade}` });
    }
    socket.close();
  });

  it("refuses a start that carries a size with invalid_command and serves one that does not", async () => {
    const server = await start();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    for (const [commandId, size] of [
      ["c1", 5],
      ["c2", 10],
      ["c3", 7],
    ] as const) {
      socket.send(
        JSON.stringify({
          type: "start_training",
          command_id: commandId,
          mode: "puzzles",
          motif: "drill",
          size,
        }),
      );
      expect(await next("error")).toMatchObject({ code: "invalid_command", command_id: commandId });
    }
    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "c4",
        mode: "puzzles",
        motif: "drill",
      }),
    );
    expect(ServerEventSchema.parse(await next("training"))).toMatchObject({
      status: "prompt",
      item: { queue_length: 10 },
    });
    socket.close();
  });

  it("serves a puzzle queue with no length and adds puzzles past the tenth", async () => {
    const db = seededDatabase();
    for (let i = 0; i < 12; i++) {
      db.prepare(
        `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation, difficulty_rating)
         VALUES (?, 'test', 'tactics', 'easy', ?, '["a1a8"]', '["Ra8#"]', 'why', 1200)`,
      ).run(`rated${String(i).padStart(2, "0")}`, BACK_RANK);
    }
    const server = await start(db);
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(JSON.stringify({ type: "start_training", command_id: "c1", mode: "puzzles" }));
    let state = ServerEventSchema.parse(await next("training"));
    if (state.type !== "training") throw new Error("no training state");
    expect(state.item).toMatchObject({ position_in_queue: 1 });
    expect(state.item).not.toHaveProperty("queue_length");
    for (let position = 1; position <= 10; position++) {
      socket.send(
        JSON.stringify({
          type: "try_move",
          command_id: `t${position}`,
          uci: "a1a8",
          activity_id: state.activity_id,
        }),
      );
      await next("training");
      socket.send(
        JSON.stringify({
          type: "next_training_item",
          command_id: `n${position}`,
          activity_id: state.activity_id,
        }),
      );
      const advanced = ServerEventSchema.parse(await next("training"));
      if (advanced.type !== "training") throw new Error("no training state");
      state = advanced;
    }
    expect(state).toMatchObject({
      status: "prompt",
      summary: null,
      item: { position_in_queue: 11 },
    });
    expect(state.item).not.toHaveProperty("queue_length");
    socket.close();
  });

  it("starts a puzzle queue with any Lichess theme stored in puzzle_themes", async () => {
    const db = seededDatabase();
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation, difficulty_rating)
       VALUES ('lichess-db:m2', 'lichess-db', 'tactics', 'intermediate', ?, '["a1a8"]', '["Ra8#"]', 'why', 1200)`,
    ).run(BACK_RANK);
    db.prepare("INSERT INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, ?, ?)").run(
      "mateIn2",
      1200,
      "lichess-db:m2",
    );
    const server = await start(db);
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "c1",
        mode: "puzzles",
        motif: "mateIn2",
      }),
    );
    const started = ServerEventSchema.parse(await next("training"));
    expect(started).toMatchObject({
      type: "training",
      mode: "puzzles",
      status: "prompt",
      item: { kind: "puzzle", puzzle_id: "lichess-db:m2", motif: "tactics" },
    });
    expect(started).not.toHaveProperty("item.queue_length");
    expect(ServerEventSchema.parse(await next("activity"))).toMatchObject({
      type: "activity",
      state: {
        kind: "training",
        mode: "puzzles",
        run_motif: "mateIn2",
        item: { kind: "puzzle", puzzle_id: "lichess-db:m2" },
      },
    });
    socket.send(
      JSON.stringify({ type: "start_training", command_id: "c2", mode: "puzzles", motif: "nope" }),
    );
    expect(await next("error")).toMatchObject({ code: "empty_queue", command_id: "c2" });
    socket.close();
  });

  it("routes the opening family to the drill and refuses an unknown one with unknown_opening", async () => {
    const db = seededDatabase();
    for (const [id, name] of [
      ["o1", "Italian Game"],
      ["o2", "Italian Game: Giuoco Piano"],
      ["o3", "Sicilian Defense"],
    ] as const) {
      db.prepare(
        `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation, opening_name)
         VALUES (?, 'own-games', 'opening-white', 'beginner', ?, '["a1a8"]', '["Ra8#"]', 'why', ?)`,
      ).run(id, BACK_RANK, name);
    }
    const server = await start(db);
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "c1",
        mode: "openings",
        color: "white",
        opening: "Italian Game",
      }),
    );
    expect(ServerEventSchema.parse(await next("training"))).toMatchObject({
      mode: "openings",
      status: "prompt",
      item: { queue_length: 2 },
    });
    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "c2",
        mode: "openings",
        color: "white",
        opening: "Vienna Game",
      }),
    );
    expect(await next("error")).toMatchObject({ code: "unknown_opening", command_id: "c2" });
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

  it("stores drawings for the current item, and refuses them off training or on a stale id", async () => {
    const db = seededDatabase();
    const server = await start(db);
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({
        type: "drawings",
        command_id: "c0",
        shapes: [{ orig: "e4", color: "red" }],
      }),
    );
    expect(await next("error")).toMatchObject({ code: "not_in_training", command_id: "c0" });
    socket.send(
      JSON.stringify({ type: "start_training", command_id: "c1", mode: "puzzles", motif: "fork" }),
    );
    const served = ServerEventSchema.parse(await next("activity")) as {
      state: { activity_id: number };
    };
    await next("training");
    const id = served.state.activity_id;
    socket.send(
      JSON.stringify({
        type: "drawings",
        command_id: "c2",
        activity_id: id + 1,
        shapes: [{ orig: "e4", dest: "e5", color: "red" }],
      }),
    );
    expect(await next("error")).toMatchObject({ code: "stale_activity", command_id: "c2" });
    socket.send(
      JSON.stringify({
        type: "drawings",
        command_id: "c3",
        activity_id: id,
        shapes: [{ orig: "e4", dest: "e5", color: "red" }],
      }),
    );
    await next("activity");
    socket.send(
      JSON.stringify({
        type: "drawings",
        command_id: "c4",
        activity_id: id,
        shapes: [{ orig: "e4", dest: "e5", color: "red" }],
      }),
    );
    await next("activity");
    socket.send(JSON.stringify({ type: "hint", command_id: "c5", activity_id: id }));
    await next("activity");
    socket.send(
      JSON.stringify({ type: "drawings", command_id: "c6", activity_id: id, shapes: [] }),
    );
    await next("activity");
    socket.send(
      JSON.stringify({ type: "try_move", command_id: "c7", activity_id: id, uci: "a1a8" }),
    );
    await next("activity");
    const rows = db
      .prepare("SELECT content_json FROM chat_messages WHERE kind = 'notification'")
      .all() as { content_json: string }[];
    expect(rows).toHaveLength(1);
    const note = JSON.parse(rows[0]?.content_json as string) as {
      reasoning: { hint_at_ms: number; drawings: { at_ms: number; shapes: unknown[] }[] };
    };
    expect(note.reasoning.hint_at_ms).toBeGreaterThanOrEqual(0);
    expect(note.reasoning.drawings).toHaveLength(2);
    expect(note.reasoning.drawings[0]).toMatchObject({
      shapes: [{ orig: "e4", dest: "e5", color: "red" }],
    });
    expect(note.reasoning.drawings[1]?.shapes).toEqual([]);
    for (const snapshot of note.reasoning.drawings) {
      expect(snapshot.at_ms).toBeGreaterThanOrEqual(0);
    }
    socket.close();
  });

  it("starts a drill of the positions from games with its filters, and refuses one with no scope", async () => {
    const db = seededDatabase();
    for (const [id, phase] of [
      ["own:endgame", "endgame"],
      ["own:opening", "opening"],
    ] as const) {
      insertFoundPosition(db, {
        id,
        fen: BACK_RANK,
        color: "white",
        phase,
        fromMistake: true,
        fromRepeat: false,
        fromDeparture: false,
        listed: true,
        acceptedUci: ["a1a8"],
        reachedGames: 1,
        bestGames: 0,
        lastReachedAt: "2026-11-01T00:00:00.000Z",
        gameId: 1,
        ply: 40,
        firstFoundAt: "2026-11-01T00:00:00.000Z",
      });
      db.prepare(
        `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
         VALUES (?, 'own-games', ?, 'beginner', ?, '["a1a8"]', '["Ra8#"]', 'why')`,
      ).run(id, `${phase}-white`, BACK_RANK);
    }
    const server = await start(db);
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "c1",
        mode: "found",
        scope: "recommended",
        phase: "endgame",
      }),
    );
    expect(ServerEventSchema.parse(await next("training"))).toMatchObject({
      mode: "found",
      status: "prompt",
      item: { kind: "puzzle", puzzle_id: "own:endgame", queue_length: 1 },
    });
    await next("activity");
    expect(ServerEventSchema.parse(await next("chat_row"))).toMatchObject({
      tab: "practice",
      entry: { role: "system", kind: "text", content: { label: "From my games" } },
    });
    socket.send(JSON.stringify({ type: "try_move", command_id: "c2", uci: "a1a8" }));
    expect(await next("training")).toMatchObject({ status: "solved" });
    expect(db.prepare("SELECT position_id, reviews FROM found_cards").all()).toEqual([
      { position_id: "own:endgame", reviews: 1 },
    ]);

    socket.send(JSON.stringify({ type: "start_training", command_id: "c3", mode: "found" }));
    expect(await next("error")).toMatchObject({ code: "invalid_command", command_id: "c3" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM training_runs").get()).toEqual({ n: 1 });

    // The most missed scope is the line drill's: a drill of positions from games has none.
    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "c3b",
        mode: "found",
        scope: "missed",
      }),
    );
    expect(await next("error")).toMatchObject({ code: "invalid_command", command_id: "c3b" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM training_runs").get()).toEqual({ n: 1 });

    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "c4",
        mode: "found",
        scope: "all",
        position: "own:opening",
      }),
    );
    expect(ServerEventSchema.parse(await next("training"))).toMatchObject({
      mode: "found",
      item: { puzzle_id: "own:opening", queue_length: 1 },
    });
    socket.close();
  });
});

describe("a practice run that leaves the board, over the socket", () => {
  const send = (socket: { send(text: string): void }, command: Record<string, unknown>) =>
    socket.send(JSON.stringify(command));
  const runs = (db: Database): unknown[] =>
    db.prepare("SELECT ended_reason, solved FROM training_runs ORDER BY id").all();

  it("shows no training in the bootstrap after a server restart in the middle of a run", async () => {
    const db = seededDatabase();
    const before = await start(db);
    const first = await connect(before);
    await first.next("bootstrap");
    send(first.socket, {
      type: "start_training",
      command_id: "c1",
      mode: "puzzles",
      motif: "drill",
    });
    const served = ServerEventSchema.parse(await first.next("activity"));
    if (served.type !== "activity" || served.state?.kind !== "training") throw new Error("no item");
    const activityId = served.state.activity_id;
    send(first.socket, {
      type: "try_move",
      command_id: "c2",
      uci: "a1a8",
      activity_id: activityId,
    });
    await first.next("activity");
    send(first.socket, { type: "next_training_item", command_id: "c3", activity_id: activityId });
    await first.next("activity");
    expect(runs(db)).toEqual([{ ended_reason: null, solved: 1 }]);
    first.socket.terminate();
    await before.close();
    app = undefined;

    const after = await start(db);
    const { socket, next } = await connect(after);
    const boot = await next("bootstrap");
    expect(boot.activity).toBeNull();
    expect(boot).not.toHaveProperty("paused_training");
    expect(runs(db)).toEqual([{ ended_reason: "left", solved: 1 }]);

    send(socket, { type: "start_training", command_id: "r1", mode: "puzzles", motif: "drill" });
    const fresh = ServerEventSchema.parse(await next("activity"));
    if (fresh.type !== "activity" || fresh.state?.kind !== "training") {
      throw new Error("expected training");
    }
    expect(fresh.state).toMatchObject({ status: "prompt", input_enabled: true });
    expect(runs(db)).toEqual([
      { ended_reason: "left", solved: 1 },
      { ended_reason: null, solved: 0 },
    ]);
  });

  it("ends the run when a game is started, and sends no paused run with the activity", async () => {
    const db = seededDatabase();
    const server = await start(db);
    const { socket, next } = await connect(server);
    await next("bootstrap");
    send(socket, { type: "start_training", command_id: "c1", mode: "puzzles", motif: "fork" });
    expect(await next("activity")).not.toHaveProperty("paused_training");

    send(socket, { type: "new_game", command_id: "c2", color: "white", elo: 1200 });
    const left = await next("activity");
    expect(left).toMatchObject({ state: { kind: "live_game" } });
    expect(left).not.toHaveProperty("paused_training");
    expect(runs(db)).toEqual([{ ended_reason: "left", solved: 0 }]);
  });

  it("refuses resume_training and discard_training as commands that do not exist", async () => {
    const server = await start();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    send(socket, { type: "resume_training", command_id: "r0" });
    expect(await next("error")).toMatchObject({ code: "invalid_command", command_id: "r0" });
    send(socket, { type: "discard_training", command_id: "d0" });
    expect(await next("error")).toMatchObject({ code: "invalid_command", command_id: "d0" });
  });
});

// Starts a fork drill and gives the first puzzle up, so the engine may be asked.
async function endedItem(
  socket: { send(data: string): void },
  next: (type: string) => Promise<Record<string, unknown>>,
): Promise<number> {
  socket.send(
    JSON.stringify({ type: "start_training", command_id: "s1", mode: "puzzles", motif: "fork" }),
  );
  const served = (await next("activity")) as { state: { activity_id: number } };
  await next("training");
  const id = served.state.activity_id;
  socket.send(JSON.stringify({ type: "show_solution", command_id: "s2", activity_id: id }));
  await next("activity");
  await next("training");
  return id;
}

// A stop is answered with what the search had, as Stockfish does; the base fake ignores it.
class StoppableStockfish extends FakeEngineProcess {
  constructor(
    onGo: (request: GoRequest) => void,
    private readonly onStop: (emit: (line: string) => void) => void,
  ) {
    super(onGo);
  }

  override send(line: string): void {
    super.send(line);
    if (line === "stop") queueMicrotask(() => this.onStop((out) => this.emit(out)));
  }
}

// The one limit a strip search may carry; any other (a movetime) leaves the scripted engine silent.
function depthLimitOf(command: string): number | null {
  const asked = /^go depth (\d+)$/.exec(command);
  return asked ? Number(asked[1]) : null;
}

const stockfishLine = (depth: number, cp: number): string =>
  `info depth ${depth} seldepth ${depth + 2} multipv 1 score cp ${cp} pv a1a8`;
const goCommandsOf = (stockfish: FakeEngineProcess): string[] =>
  stockfish.sent.filter((line) => line.startsWith("go "));
const stopsSentTo = (stockfish: FakeEngineProcess): number =>
  stockfish.sent.filter((line) => line === "stop").length;

// Taken before any test installs a fake clock, so the wait for the socket still runs on real time.
const realSetTimeout = globalThis.setTimeout;
async function untilGoSentTo(stockfish: FakeEngineProcess): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (goCommandsOf(stockfish).length > 0) return;
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  throw new Error(`the engine was never sent a go; it got ${JSON.stringify(stockfish.sent)}`);
}

describe("analysis over the socket", () => {
  async function startWithEngine(lane?: (request: SearchRequest) => Promise<SearchResult>) {
    const db = seededDatabase();
    const session = createCoachSession(db, { promptVersion: "v" });
    const notifications = { sessionId: () => session.id };
    const activity = new ActivityService({
      db,
      game: new GameService({ db, engine: new ScriptedEngine([]) }),
      training: { desk: new ReviewDesk({ db, notifications }), notifications },
    });
    const asked: { fen: string; depth?: number; multipv?: number }[] = [];
    app = buildApp({
      hub: {
        coach: new FakeCoach(db),
        activity,
        db,
        allowedOrigins: ["http://localhost:5173"],
        analyse:
          lane ??
          (async (request) => {
            asked.push(request);
            return {
              fen: request.fen,
              bestmove: "a1a8",
              lines: [{ moves: ["a1a8"], score: 9990 }],
            };
          }),
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    return { app, asked };
  }

  // The analysis lane as main.ts wires it: the real pool and engine wrapper over a scripted process.
  async function startWithStockfish(evaluation: FakeEngineProcess, evalCache?: EvalCache) {
    const pool = new EnginePool(
      (role) => (role === "evaluation" ? evaluation : new FakeEngineProcess(() => {})),
      {},
      evalCache,
    );
    await pool.start();
    return (await startWithEngine((request) => pool.analyzeWith(request))).app;
  }

  it("refuses the engine while an item is open and answers once it ended", async () => {
    const { app: server, asked } = await startWithEngine();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({ type: "start_training", command_id: "c1", mode: "puzzles", motif: "fork" }),
    );
    const served = (await next("activity")) as { state: { activity_id: number } };
    await next("training");
    const id = served.state.activity_id;
    socket.send(
      JSON.stringify({ type: "analyse", command_id: "c2", activity_id: id, fen: BACK_RANK }),
    );
    const refused = await next("error");
    expect(refused).toMatchObject({ code: "training_item_open", command_id: "c2" });
    expect(asked).toEqual([]);

    socket.send(JSON.stringify({ type: "show_solution", command_id: "c3", activity_id: id }));
    await next("activity");
    await next("training");
    socket.send(
      JSON.stringify({
        type: "analyse",
        command_id: "c4",
        activity_id: id,
        fen: BACK_RANK,
        lines: 2,
        depth: 12,
      }),
    );
    const analysis = await next("analysis");
    expect(analysis).toEqual({
      type: "analysis",
      command_id: "c4",
      fen: BACK_RANK,
      depth: 12,
      source: "engine",
      requested_lines: 2,
      lines: [{ moves: ["a1a8"], san: ["Ra8#"], score_cp: 9990 }],
    });
    expect(asked).toEqual([{ fen: BACK_RANK, depth: 12, multipv: 2, capMs: 4000 }]);
  });

  it("refuses the engine off a practice item and for an item no longer on the board", async () => {
    const { app: server, asked } = await startWithEngine();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(JSON.stringify({ type: "analyse", command_id: "c0", fen: BACK_RANK }));
    expect(await next("error")).toMatchObject({ code: "not_in_training", command_id: "c0" });
    socket.send(
      JSON.stringify({ type: "start_training", command_id: "c1", mode: "puzzles", motif: "fork" }),
    );
    const served = (await next("activity")) as { state: { activity_id: number } };
    await next("training");
    const id = served.state.activity_id;
    socket.send(JSON.stringify({ type: "show_solution", command_id: "c2", activity_id: id }));
    await next("activity");
    await next("training");
    socket.send(
      JSON.stringify({ type: "analyse", command_id: "c3", activity_id: id + 1, fen: BACK_RANK }),
    );
    expect(await next("error")).toMatchObject({ code: "stale_activity", command_id: "c3" });
    expect(asked).toEqual([]);
  });

  it("refuses a coach comment on a stale item, none ended and a second ask", async () => {
    const { app: server } = await startWithEngine();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({ type: "start_training", command_id: "c1", mode: "puzzles", motif: "fork" }),
    );
    const served = (await next("activity")) as { state: { activity_id: number } };
    await next("training");
    const id = served.state.activity_id;
    const ask = (commandId: string, activityId: number) =>
      socket.send(
        JSON.stringify({
          type: "ask_coach_about_item",
          command_id: commandId,
          activity_id: activityId,
        }),
      );
    ask("c2", id);
    expect(await next("error")).toMatchObject({ code: "not_in_training", command_id: "c2" });
    socket.send(
      JSON.stringify({ type: "try_move", command_id: "c3", uci: "a1a8", activity_id: id }),
    );
    await next("activity");
    ask("c4", id + 1);
    expect(await next("error")).toMatchObject({ code: "stale_activity", command_id: "c4" });
    ask("c5", id);
    expect(await next("activity")).toMatchObject({ state: { coach_comment: "requested" } });
    ask("c6", id);
    expect(await next("error")).toMatchObject({ code: "already_requested", command_id: "c6" });
  });

  it("reports the score from White's side and refuses a position that is not one", async () => {
    const { app: server } = await startWithEngine();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    await endedItem(socket, next);
    const blackToMove = "6k1/5ppp/8/8/8/8/5PPP/R5K1 b - - 0 1";
    socket.send(JSON.stringify({ type: "analyse", command_id: "c1", fen: blackToMove }));
    const analysis = (await next("analysis")) as { lines: { score_cp: number }[]; depth: number };
    expect(analysis.lines[0]?.score_cp).toBe(-9990);
    expect(analysis.depth).toBe(18);
    socket.send(
      JSON.stringify({ type: "analyse", command_id: "c2", fen: "not a position at all" }),
    );
    expect(await next("error")).toMatchObject({ code: "invalid_position", command_id: "c2" });
  });

  it("says no engine is available when the hub was built without one", async () => {
    const server = await start();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    await endedItem(socket, next);
    socket.send(JSON.stringify({ type: "analyse", command_id: "c1", fen: BACK_RANK }));
    expect(await next("error")).toMatchObject({ code: "engine_unavailable" });
  });

  it("names a dead engine, and answers nothing for a search a newer one replaced", async () => {
    const db = seededDatabase();
    const session = createCoachSession(db, { promptVersion: "v" });
    const notifications = { sessionId: () => session.id };
    const activity = new ActivityService({
      db,
      game: new GameService({ db, engine: new ScriptedEngine([]) }),
      training: { desk: new ReviewDesk({ db, notifications }), notifications },
    });
    let outcome: "fault" | "superseded" = "fault";
    app = buildApp({
      hub: {
        coach: new FakeCoach(db),
        activity,
        db,
        allowedOrigins: ["http://localhost:5173"],
        analyse: async () => {
          if (outcome === "fault") throw new EngineFault("exited", "engine exited");
          throw new AnalyzeSuperseded();
        },
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { socket, next, inbox } = await connect(app);
    await next("bootstrap");
    await endedItem(socket, next);
    socket.send(JSON.stringify({ type: "analyse", command_id: "c1", fen: BACK_RANK }));
    expect(await next("error")).toMatchObject({ code: "engine_unavailable", command_id: "c1" });
    outcome = "superseded";
    socket.send(JSON.stringify({ type: "analyse", command_id: "c2", fen: BACK_RANK }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(inbox.filter((event) => event.type === "error" || event.type === "analysis")).toEqual(
      [],
    );
  });

  it("asks the engine for the depth under a cap and answers once it is reached", async () => {
    const stockfish = new FakeEngineProcess(({ command, emit }) => {
      const depth = depthLimitOf(command);
      if (depth === null) return;
      emit(stockfishLine(depth, 30));
      emit("bestmove a1a8");
    });
    const server = await startWithStockfish(stockfish);
    const { socket, next } = await connect(server);
    await next("bootstrap");
    const id = await endedItem(socket, next);
    socket.send(
      JSON.stringify({
        type: "analyse",
        command_id: "c1",
        activity_id: id,
        fen: BACK_RANK,
        depth: 12,
      }),
    );
    await untilGoSentTo(stockfish);
    expect(goCommandsOf(stockfish)).toEqual(["go depth 12"]);
    expect(await next("analysis")).toEqual({
      type: "analysis",
      command_id: "c1",
      fen: BACK_RANK,
      depth: 12,
      source: "engine",
      requested_lines: 1,
      lines: [{ moves: ["a1a8"], san: ["Ra8#"], score_cp: 30 }],
    });
    expect(stopsSentTo(stockfish)).toBe(0);
  });

  it("stops a search that never reaches the depth at the cap and keeps its deepest layer", async () => {
    const stockfish = new StoppableStockfish(
      ({ command, emit }) => {
        if (depthLimitOf(command) === null) return;
        // Layer 14 is the last one completed; the best move waits for the stop.
        for (const [depth, cp] of [
          [12, 20],
          [13, 30],
          [14, 40],
        ] as const) {
          emit(stockfishLine(depth, cp));
        }
      },
      (emit) => emit("bestmove a1a8"),
    );
    const server = await startWithStockfish(stockfish);
    const { socket, next } = await connect(server);
    await next("bootstrap");
    const id = await endedItem(socket, next);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      socket.send(
        JSON.stringify({ type: "analyse", command_id: "c1", activity_id: id, fen: BACK_RANK }),
      );
      await untilGoSentTo(stockfish);
      expect(goCommandsOf(stockfish)).toEqual(["go depth 18"]);
      await vi.advanceTimersByTimeAsync(ANALYSIS_BUDGET_MS - 1);
      expect(stopsSentTo(stockfish)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(stopsSentTo(stockfish)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    const analysis = await next("analysis");
    expect(analysis).toEqual({
      type: "analysis",
      command_id: "c1",
      fen: BACK_RANK,
      depth: 14,
      source: "engine",
      requested_lines: 1,
      cutByTime: true,
      lines: [{ moves: ["a1a8"], san: ["Ra8#"], score_cp: 40 }],
    });
    // The page parses every frame with this schema, which drops a field it does not name.
    expect(ServerEventSchema.parse(analysis)).toEqual(analysis);
  });

  // The rows a cache holds for the analysis tests below: the back rank position with three lines at
  // depth 30, and the two castling cases.
  const BACK_RANK_EPD = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - -";
  const BOTH_ROOKS_HOME = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
  const ROOK_ON_E1 = "3k4/8/8/8/8/8/8/K3R3 w - - 0 1";
  const epdOf = (fen: string): string => fen.split(" ").slice(0, 4).join(" ");
  const cacheWithBackRank = (): EvalCache =>
    openFixtureCache([
      {
        epd: BACK_RANK_EPD,
        sets: [
          storedSet(30, [
            [310, "a1a8"],
            [120, "g1f1"],
            [90, "g2g3"],
          ]),
        ],
      },
    ]).cache;

  // A Stockfish that answers a depth search at once, so a search that was not needed shows as a go.
  const answeringStockfish = (): FakeEngineProcess =>
    new FakeEngineProcess(({ command, emit }) => {
      const depth = depthLimitOf(command);
      if (depth === null) return;
      emit(stockfishLine(depth, 30));
      emit("bestmove a1a8");
    });

  // Each ask is one analyse command, numbered c1, c2 and so on; the caller waits for its answer
  // before the next, since a connection's older command is dropped once a newer one is sent.
  async function askOverStockfish(stockfish: FakeEngineProcess, cache: EvalCache) {
    const server = await startWithStockfish(stockfish, cache);
    const { socket, next } = await connect(server);
    await next("bootstrap");
    const id = await endedItem(socket, next);
    let asked = 0;
    const ask = (fields: Record<string, unknown>): void => {
      asked += 1;
      socket.send(
        JSON.stringify({ type: "analyse", command_id: `c${asked}`, activity_id: id, ...fields }),
      );
    };
    return { ask, next };
  }

  it("answers 2 lines at depth 20 from 3 lines at depth 30, at the depth stored, with no search", async () => {
    const stockfish = answeringStockfish();
    const { ask, next } = await askOverStockfish(stockfish, cacheWithBackRank());
    ask({ fen: BACK_RANK, lines: 2, depth: 20 });
    const analysis = await next("analysis");
    expect(analysis).toEqual({
      type: "analysis",
      command_id: "c1",
      fen: BACK_RANK,
      depth: 30,
      source: "cache",
      requested_lines: 2,
      lines: [
        { moves: ["a1a8"], san: ["Ra8#"], score_cp: 310 },
        { moves: ["g1f1"], san: ["Kf1"], score_cp: 120 },
      ],
    });
    expect(ServerEventSchema.parse(analysis)).toEqual(analysis);
    expect(goCommandsOf(stockfish)).toEqual([]);
  });

  it("sends the same position to the engine when 5 lines are asked for", async () => {
    const stockfish = answeringStockfish();
    const { ask, next } = await askOverStockfish(stockfish, cacheWithBackRank());
    ask({ fen: BACK_RANK, lines: 5, depth: 20 });
    expect(await next("analysis")).toMatchObject({
      depth: 20,
      source: "engine",
      requested_lines: 5,
    });
    expect(goCommandsOf(stockfish)).toEqual(["go depth 20"]);
  });

  it("writes the file's e1h1 as castling when a king stands on e1 and keeps a rook's move a rook's", async () => {
    const cache = openFixtureCache([
      { epd: epdOf(BOTH_ROOKS_HOME), sets: [storedSet(30, [[12, "e1h1 e8a8"]])] },
      { epd: epdOf(ROOK_ON_E1), sets: [storedSet(30, [[300, "e1h1"]])] },
    ]).cache;
    const { ask, next } = await askOverStockfish(answeringStockfish(), cache);
    ask({ fen: BOTH_ROOKS_HOME });
    expect(await next("analysis")).toMatchObject({
      command_id: "c1",
      source: "cache",
      lines: [{ moves: ["e1g1", "e8c8"], san: ["O-O", "O-O-O"], score_cp: 12 }],
    });
    ask({ fen: ROOK_ON_E1 });
    expect(await next("analysis")).toMatchObject({
      command_id: "c2",
      source: "cache",
      lines: [{ moves: ["e1h1"], san: ["Rh1"], score_cp: 300 }],
    });
  });

  it("drops the answer to an older command once a newer one was answered", async () => {
    const cache = cacheWithBackRank();
    const slowFen = "4k3/8/8/8/8/8/8/4K2R w K - 0 1";
    let finishSlowSearch: () => void = () => {};
    // The pool's own rule: a stored evaluation answers at once, anything else waits for a search.
    const lane = async (request: SearchRequest): Promise<SearchResult> => {
      const hit = cache.lookup(request.fen, {
        lines: request.multipv ?? 1,
        depth: request.depth ?? 0,
      });
      if (hit) {
        return {
          fen: request.fen,
          bestmove: null,
          lines: hit.lines,
          depth: hit.depth,
          source: "cache",
        };
      }
      await new Promise<void>((resolve) => {
        finishSlowSearch = resolve;
      });
      return { fen: request.fen, bestmove: "h1h8", lines: [{ moves: ["h1h8"], score: 500 }] };
    };
    const { app: server } = await startWithEngine(lane);
    const { socket, next, inbox } = await connect(server);
    await next("bootstrap");
    const id = await endedItem(socket, next);
    for (const [commandId, fen] of [
      ["slow", slowFen],
      ["fast", BACK_RANK],
    ] as const) {
      socket.send(JSON.stringify({ type: "analyse", command_id: commandId, activity_id: id, fen }));
    }
    expect(await next("analysis")).toMatchObject({ command_id: "fast", source: "cache" });
    finishSlowSearch();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(inbox.filter((event) => event.type === "analysis")).toEqual([]);
  });
});

describe("mix practice over the socket", () => {
  function mixSeededDatabase(): Database {
    const db = seededDatabase();
    const insertPuzzle = db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation, difficulty_rating)
       VALUES (?, 'test', 'tactics', 'easy', ?, '["a1a8"]', '["Ra8#"]', 'why', 1200)`,
    );
    const insertTheme = db.prepare(
      "INSERT INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, 1200, ?)",
    );
    for (const theme of ["advancedPawn", "attackingF2F7", "capturingDefender"]) {
      for (let i = 0; i < 12; i++) {
        const id = `${theme}-${String(i).padStart(2, "0")}`;
        insertPuzzle.run(id, BACK_RANK);
        insertTheme.run(theme, id);
      }
    }
    return db;
  }

  it("starts a mix queue with no length and the reserved motif as its run motif", async () => {
    const db = mixSeededDatabase();
    const server = await start(db);
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "c1",
        mode: "puzzles",
        motif: MIX_PRACTICE_MOTIF,
      }),
    );
    const started = ServerEventSchema.parse(await next("training"));
    expect(started).toMatchObject({
      type: "training",
      mode: "puzzles",
      status: "prompt",
      item: { kind: "puzzle", position_in_queue: 1 },
    });
    expect(started).not.toHaveProperty("item.queue_length");
    expect(ServerEventSchema.parse(await next("activity"))).toMatchObject({
      type: "activity",
      state: { kind: "training", run_motif: "mix-practice" },
    });
    expect(db.prepare("SELECT motif FROM training_runs").all()).toEqual([
      { motif: "mix-practice" },
    ]);
    socket.close();
  });

  it("refuses a mix start with empty_queue when no theme has a puzzle", async () => {
    const server = await start();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "c1",
        mode: "puzzles",
        motif: MIX_PRACTICE_MOTIF,
      }),
    );
    expect(await next("error")).toMatchObject({ code: "empty_queue", command_id: "c1" });
    socket.close();
  });
});

describe("a found drill narrowed to one opening over the socket", () => {
  function seedFoundOpenings(): Database {
    const db = seededDatabase();
    const openings = [
      ["own:two-knights", "Italian Game: Two Knights Defense"],
      ["own:giuoco", "Italian Game: Giuoco Pianissimo"],
      ["own:scandi", "Scandinavian Defense"],
    ] as const;
    for (const [id, openingName] of openings) {
      insertFoundPosition(db, {
        id,
        fen: BACK_RANK,
        color: "white",
        phase: "opening",
        fromMistake: true,
        fromRepeat: false,
        fromDeparture: false,
        listed: true,
        acceptedUci: ["a1a8"],
        reachedGames: 1,
        bestGames: 0,
        lastReachedAt: "2026-11-01T00:00:00.000Z",
        gameId: 1,
        ply: 40,
        firstFoundAt: "2026-11-01T00:00:00.000Z",
      });
      db.prepare(
        `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation, opening_name)
         VALUES (?, 'own-games', 'opening-white', 'beginner', ?, '["a1a8"]', '["Ra8#"]', 'why', ?)`,
      ).run(id, BACK_RANK, openingName);
    }
    return db;
  }

  it("serves the opening's positions and refuses an unknown one and one too long", async () => {
    expect(
      ClientCommandSchema.safeParse({
        type: "start_training",
        command_id: "v1",
        mode: "found",
        scope: "all",
        opening: "Italian Game",
      }).success,
    ).toBe(true);
    expect(
      ClientCommandSchema.safeParse({
        type: "start_training",
        command_id: "v2",
        mode: "found",
        scope: "all",
        opening: "x".repeat(121),
      }).success,
    ).toBe(false);
    const server = await start(seedFoundOpenings());
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "c1",
        mode: "found",
        scope: "all",
        opening: "Italian Game",
      }),
    );
    expect(ServerEventSchema.parse(await next("training"))).toMatchObject({
      mode: "found",
      status: "prompt",
      item: { queue_length: 2 },
    });
    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "c2",
        mode: "found",
        scope: "all",
        opening: "Italian Game: Two Knights Defense",
      }),
    );
    expect(ServerEventSchema.parse(await next("training"))).toMatchObject({
      mode: "found",
      item: { puzzle_id: "own:two-knights", queue_length: 1 },
    });
    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "c3",
        mode: "found",
        scope: "all",
        opening: "French Defense",
      }),
    );
    expect(await next("error")).toMatchObject({ code: "empty_queue", command_id: "c3" });
    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "c4",
        mode: "found",
        scope: "all",
        opening: "x".repeat(121),
      }),
    );
    expect(await next("error")).toMatchObject({ code: "invalid_command", command_id: "c4" });
    socket.close();
  });
});

const START_POSITION = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("a clicked line card opens the demo with its own moves", () => {
  it("opens a show_line with three moves as a demo holding those three moves", async () => {
    const server = await start();
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({
        type: "show_line",
        command_id: "c1",
        fen: START_POSITION,
        moves: ["e4", "e5", "Nf3"],
      }),
    );
    const activity = ServerEventSchema.parse(await next("activity"));
    expect(activity).toMatchObject({
      type: "activity",
      state: { kind: "demo", moves_played: ["e4", "e5", "Nf3"] },
    });
    socket.close();
  });
});

describe("every refused ask over the socket is logged with its code", () => {
  it("logs ws.command_failed for a prompt ask, a stale ask and a second ask", async () => {
    const log = new RecordingLog();
    const server = await start(seededDatabase(), log);
    const { socket, next } = await connect(server);
    await next("bootstrap");
    socket.send(
      JSON.stringify({ type: "start_training", command_id: "c1", mode: "puzzles", motif: "fork" }),
    );
    const served = (await next("activity")) as { state: { activity_id: number } };
    await next("training");
    const id = served.state.activity_id;
    const failedOf = (commandId: string) =>
      log.named("ws.command_failed").find((entry) => entry.fields.command_id === commandId);

    socket.send(
      JSON.stringify({ type: "ask_coach_about_item", command_id: "c2", activity_id: id }),
    );
    expect(await next("error")).toMatchObject({ code: "not_in_training", command_id: "c2" });
    expect(failedOf("c2")).toMatchObject({ fields: { code: "not_in_training" } });

    socket.send(
      JSON.stringify({ type: "try_move", command_id: "c3", uci: "a1a8", activity_id: id }),
    );
    await next("activity");
    socket.send(
      JSON.stringify({ type: "ask_coach_about_item", command_id: "c4", activity_id: id + 1 }),
    );
    expect(await next("error")).toMatchObject({ code: "stale_activity", command_id: "c4" });
    expect(failedOf("c4")).toMatchObject({ fields: { code: "stale_activity" } });

    socket.send(
      JSON.stringify({ type: "ask_coach_about_item", command_id: "c5", activity_id: id }),
    );
    expect(await next("activity")).toMatchObject({ state: { coach_comment: "requested" } });
    socket.send(
      JSON.stringify({ type: "ask_coach_about_item", command_id: "c6", activity_id: id }),
    );
    expect(await next("error")).toMatchObject({ code: "already_requested", command_id: "c6" });
    expect(failedOf("c6")).toMatchObject({ fields: { code: "already_requested" } });
    socket.close();
  });

  it("logs ws.command_failed for an ask after a wrong try and after a give-up", async () => {
    const log = new RecordingLog();
    const server = await start(seededDatabase(), log);
    const { socket, next } = await connect(server);
    await next("bootstrap");
    const failedOf = (commandId: string) =>
      log.named("ws.command_failed").find((entry) => entry.fields.command_id === commandId);

    socket.send(
      JSON.stringify({ type: "start_training", command_id: "c1", mode: "puzzles", motif: "fork" }),
    );
    const served = (await next("activity")) as { state: { activity_id: number } };
    await next("training");
    const id = served.state.activity_id;
    socket.send(
      JSON.stringify({ type: "try_move", command_id: "c2", uci: "a1a2", activity_id: id }),
    );
    await next("activity");
    socket.send(
      JSON.stringify({ type: "try_move", command_id: "c3", uci: "a1a8", activity_id: id }),
    );
    await next("activity");
    socket.send(
      JSON.stringify({ type: "ask_coach_about_item", command_id: "c4", activity_id: id }),
    );
    expect(await next("error")).toMatchObject({ code: "not_in_training", command_id: "c4" });
    expect(failedOf("c4")).toMatchObject({ fields: { code: "not_in_training" } });

    socket.send(JSON.stringify({ type: "end_training", command_id: "c5", activity_id: id }));
    await next("activity");
    socket.send(
      JSON.stringify({ type: "start_training", command_id: "c6", mode: "puzzles", motif: "fork" }),
    );
    const second = (await next("activity")) as { state: { activity_id: number } };
    await next("training");
    const secondId = second.state.activity_id;
    socket.send(JSON.stringify({ type: "show_solution", command_id: "c7", activity_id: secondId }));
    await next("activity");
    await next("training");
    socket.send(
      JSON.stringify({ type: "ask_coach_about_item", command_id: "c8", activity_id: secondId }),
    );
    expect(await next("error")).toMatchObject({ code: "not_in_training", command_id: "c8" });
    expect(failedOf("c8")).toMatchObject({ fields: { code: "not_in_training" } });
    socket.close();
  });

  it("routes skip_first_showings to a line drill and refuses off training, on a puzzle and on a stale id", async () => {
    const db = seededDatabase();
    const { id: repId } = createRepertoireVariation(db, {
      side: "white",
      groupName: "Italian Game",
      variationName: "Classical",
    });
    const lineMoves: [string[], string, boolean][] = [
      [[], "e4", true],
      [["e4"], "e5", false],
      [["e4", "e5"], "Nf3", true],
    ];
    for (const [line, san, own] of lineMoves) {
      const board = new Chess();
      for (const played of line) board.move(played);
      const key = positionKey(board.fen());
      const move = board.move(san);
      const row = {
        repertoireId: repId,
        positionKey: key,
        ply: line.length + 1,
        line,
        reach: 1,
        openingName: "King's Pawn Game",
        uci: `${move.from}${move.to}${move.promotion ?? ""}`,
        san,
        share: null,
        source: "explorer" as const,
      };
      if (own) insertRepertoireOwnMove(db, { ...row, cpLoss: 0, evalCp: 20, results: null });
      else upsertRepertoireReply(db, row);
    }

    const log = new RecordingLog();
    const server = await start(db, log);
    const { socket, next } = await connect(server);
    await next("bootstrap");

    // Refused when not in training.
    socket.send(JSON.stringify({ type: "skip_first_showings", command_id: "s0" }));
    expect(await next("error")).toMatchObject({ code: "not_in_training", command_id: "s0" });

    // Refused with invalid_state on a puzzle run.
    socket.send(
      JSON.stringify({ type: "start_training", command_id: "p1", mode: "puzzles", motif: "fork" }),
    );
    const puzzleState = (await next("activity")) as { state: { activity_id: number } };
    await next("training");
    socket.send(
      JSON.stringify({
        type: "skip_first_showings",
        command_id: "s1",
        activity_id: puzzleState.state.activity_id,
      }),
    );
    expect(await next("error")).toMatchObject({ code: "invalid_state", command_id: "s1" });

    // Start a line drill, test stale_activity, then route skip_first_showings cleanly.
    socket.send(
      JSON.stringify({
        type: "start_training",
        command_id: "r1",
        mode: "repertoire",
        repertoire_id: repId,
        scope: "due",
      }),
    );
    const drillStart = ServerEventSchema.parse(await next("activity")) as {
      state: { activity_id: number; repertoire: { first_pass: boolean; new_moves: number } };
    };
    await next("training");
    const drillId = drillStart.state.activity_id;
    expect(drillStart.state.repertoire).toMatchObject({ first_pass: true, new_moves: 1 });

    socket.send(
      JSON.stringify({
        type: "skip_first_showings",
        command_id: "s2",
        activity_id: drillId + 1,
      }),
    );
    expect(await next("error")).toMatchObject({ code: "stale_activity", command_id: "s2" });

    // Extra field refused by strict schema.
    socket.send(
      JSON.stringify({
        type: "skip_first_showings",
        command_id: "s3",
        activity_id: drillId,
        extra: 1,
      }),
    );
    expect(await next("error")).toMatchObject({ code: "invalid_command", command_id: "s3" });

    socket.send(
      JSON.stringify({
        type: "skip_first_showings",
        command_id: "s4",
        activity_id: drillId,
      }),
    );
    const afterSkip = ServerEventSchema.parse(await next("activity")) as {
      state: {
        repertoire: { first_pass: boolean; answer: { san: string } | null; new_moves: number };
      };
    };
    await next("training");
    expect(afterSkip.state.repertoire).toMatchObject({
      first_pass: true,
      answer: { san: "e4" },
      new_moves: 0,
    });
    expect(log.named("ws.command_done").map((entry) => entry.fields.type)).toContain(
      "skip_first_showings",
    );
    socket.close();
  });
});
