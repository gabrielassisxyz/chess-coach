import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityService } from "../../src/activity/service.js";
import { buildApp } from "../../src/app.js";
import { createCoachSession, listChatTail } from "../../src/db/chat.js";
import { openDatabase } from "../../src/db/open.js";
import type { PlyQuestionNotification } from "../../src/game/notifications.js";
import { GameService } from "../../src/game/service.js";
import { FakeCoach } from "../fakes/fake-coach.js";
import { ScriptedEngine } from "../fakes/scripted-engine.js";
import { insertGradedGame, START_FEN } from "../fixture-game.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start() {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "review-cmd-")));
  const coach = new FakeCoach();
  coach.sessionRow = createCoachSession(db, { promptVersion: "v" });
  const game = new GameService({ db, engine: new ScriptedEngine([]) });
  app = buildApp({
    hub: {
      coach,
      activity: new ActivityService({ db, game }),
      db,
      allowedOrigins: ["http://localhost:5173"],
      clock: { now: () => new Date("2026-02-01T00:00:00Z") },
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const inbox: unknown[] = [];
  const waiters: ((value: unknown) => void)[] = [];
  const socket = await app.injectWS(
    "/api/ws",
    { headers: { origin: "http://localhost:5173", host: "localhost:5173" } },
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
  await next();
  return { db, coach, socket, next };
}

describe("create_cards", () => {
  it("answers with the count, then 0 for the same game", async () => {
    const { db, socket, next } = await start();
    const gameId = insertGradedGame(db);
    socket.send(JSON.stringify({ type: "create_cards", command_id: "a", game_id: gameId }));
    expect(await next()).toEqual({ type: "cards_created", game_id: gameId, count: 3 });
    socket.send(JSON.stringify({ type: "create_cards", command_id: "b", game_id: gameId }));
    expect(await next()).toEqual({ type: "cards_created", game_id: gameId, count: 0 });
  });

  it("refuses an unknown game and a game still being played with typed codes", async () => {
    const { db, socket, next } = await start();
    socket.send(JSON.stringify({ type: "create_cards", command_id: "a", game_id: 99 }));
    expect(await next()).toMatchObject({ code: "game_not_found", command_id: "a" });
    const live = insertGradedGame(db, false);
    socket.send(JSON.stringify({ type: "create_cards", command_id: "b", game_id: live }));
    expect(await next()).toMatchObject({ code: "game_not_finished", command_id: "b" });
  });
});

describe("ask_coach_about_ply", () => {
  it("writes an undelivered notification from stored data and flushes it, with no user text row", async () => {
    const { db, coach, socket } = await start();
    const gameId = insertGradedGame(db);
    socket.send(
      JSON.stringify({
        type: "ask_coach_about_ply",
        command_id: "q",
        game_id: gameId,
        ply: 9,
        text: "forged",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rows = listChatTail(db, coach.sessionRow?.id as number, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "user", kind: "notification", delivered: false });
    expect(rows.filter((row) => row.kind === "text")).toEqual([]);
    const content = JSON.parse(rows[0]?.contentJson as string) as PlyQuestionNotification;
    expect(content).toEqual({
      type: "ply_question",
      game_id: gameId,
      ply: 9,
      san: "e4",
      is_player: true,
      fen_before: START_FEN,
      cp_loss: 150,
      classification: "inaccuracy",
      best_san: "d4",
    });
    expect(coach.flushes).toBe(1);
    expect(coach.sent).toEqual([]);
  });

  it("refuses a ply the game does not have", async () => {
    const { db, coach, socket, next } = await start();
    const gameId = insertGradedGame(db);
    socket.send(
      JSON.stringify({ type: "ask_coach_about_ply", command_id: "q", game_id: gameId, ply: 13 }),
    );
    expect(await next()).toMatchObject({ code: "invalid_ply", command_id: "q" });
    expect(listChatTail(db, coach.sessionRow?.id as number, 50)).toEqual([]);
    expect(coach.flushes).toBe(0);
  });
});
