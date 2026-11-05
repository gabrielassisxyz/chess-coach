import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { CoachSession, type QueryFn } from "../../src/coach/session.js";
import { openDatabase } from "../../src/db/open.js";
import { writeNotification } from "../../src/game/notifications.js";
import { RecordingLog } from "../../src/log.js";
import { contentDir } from "../../src/paths.js";
import { makeWorld } from "../fakes/fake-world.js";

// A result the way the SDK ends a turn, naming the messages it answered when given any.
function result(answered: string[] | null): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    usage: { input_tokens: 1, output_tokens: 2 },
    ...(answered ? { user_message_uuids: answered, user_message_uuid: answered.at(-1) } : {}),
  } as unknown as SDKMessage;
}

type Script = (
  sent: SDKUserMessage[],
  wait: (n: number) => Promise<void>,
) => AsyncIterable<SDKMessage>;

// Each launch of the stream runs the next script; a script sees every message sent to it so far.
function scriptedQuery(scripts: Script[]): QueryFn {
  let launch = 0;
  return ({ prompt }) => {
    const script = scripts[launch++] ?? async function* () {};
    const sent: SDKUserMessage[] = [];
    const waiters: (() => void)[] = [];
    void (async () => {
      for await (const message of prompt) {
        sent.push(message);
        for (const wake of waiters.splice(0)) wake();
      }
    })();
    const wait = async (n: number): Promise<void> => {
      while (sent.length < n) await new Promise<void>((resolve) => waiters.push(resolve));
    };
    return script(sent, wait)[Symbol.asyncIterator]() as never;
  };
}

function setup(scripts: Script[]) {
  const dataDir = mkdtempSync(join(tmpdir(), "coach-log-"));
  const db = openDatabase(dataDir);
  const log = new RecordingLog();
  const session = new CoachSession({
    db,
    query: scriptedQuery(scripts),
    contentDir: contentDir(),
    dataDir,
    world: makeWorld(db).world,
    env: {},
    log,
  });
  const ends = () => log.named("coach.turn_end").map((entry) => entry.fields);
  return { db, log, session, ends };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("coach turns in the log", () => {
  it("closes every message one result answered, and numbers the next turn after them", async () => {
    const { session, ends } = setup([
      async function* (sent, wait) {
        await wait(1);
        yield result([String(sent[0]?.uuid)]);
        await wait(3);
        // The SDK ran the second and third messages as one turn.
        yield result([String(sent[1]?.uuid), String(sent[2]?.uuid)]);
        await wait(4);
        yield result([String(sent[3]?.uuid)]);
      },
    ]);
    await session.start();
    await session.send("one");
    await vi.waitFor(() => expect(ends()).toHaveLength(1));
    await session.send("two");
    await session.send("three");
    await vi.waitFor(() => expect(ends()).toHaveLength(2));
    await session.send("four");
    await vi.waitFor(() => expect(ends()).toHaveLength(3));
    expect(ends().map((end) => end.turns)).toEqual([[1], [2, 3], [4]]);
    expect(ends().map((end) => end.turn)).toEqual([1, 2, 4]);
    await session.stop();
  });

  it("closes nothing for a result naming no message it sent, and logs no made-up timing", async () => {
    const { session, ends } = setup([
      async function* (sent, wait) {
        await wait(1);
        yield result(["00000000-0000-4000-8000-00000000cafe"]);
        yield result([String(sent[0]?.uuid)]);
      },
    ]);
    await session.start();
    await session.send("one");
    await vi.waitFor(() => expect(ends()).toHaveLength(2));
    expect(ends()[0]).toMatchObject({ turn: null, turns: [], duration_ms: null, waited_ms: null });
    expect(ends()[1]).toMatchObject({ turn: 1, turns: [1] });
    await session.stop();
  });

  it("closes nothing for a result with no uuids once results have named their messages", async () => {
    const { session, ends } = setup([
      async function* (sent, wait) {
        await wait(1);
        yield result([String(sent[0]?.uuid)]);
        await wait(2);
        // A turn the SDK ran on its own carries no uuid at all.
        yield result(null);
        yield result([String(sent[1]?.uuid)]);
      },
    ]);
    await session.start();
    await session.send("one");
    await vi.waitFor(() => expect(ends()).toHaveLength(1));
    await session.send("two");
    await vi.waitFor(() => expect(ends()).toHaveLength(3));
    expect(ends().map((end) => end.turns)).toEqual([[1], [], [2]]);
    await session.stop();
  });

  it("names the oldest open turn when a stream dies with two queued", async () => {
    const { session, log } = setup([
      // biome-ignore lint/correctness/useYield: this stream dies before it answers anything
      async function* (_sent, wait) {
        await wait(2);
        throw new Error("cli exited");
      },
    ]);
    await session.start();
    await session.send("one");
    await session.send("two");
    await vi.waitFor(() => expect(log.named("coach.turn_error")).toHaveLength(1));
    expect(log.named("coach.turn_error")[0]?.fields).toMatchObject({
      turn: 1,
      queued_turns: [1, 2],
    });
    await session.stop();
  });

  it("splits a queued turn's time into the wait behind the previous answer and its own", async () => {
    const { session, log, ends } = setup([
      async function* (sent, wait) {
        await wait(2);
        await pause(80);
        yield result([String(sent[0]?.uuid)]);
        await pause(40);
        yield result([String(sent[1]?.uuid)]);
      },
    ]);
    await session.start();
    await session.send("one");
    await session.send("two");
    await vi.waitFor(() => expect(ends()).toHaveLength(2));
    expect(log.named("coach.turn_start").map((entry) => entry.fields.queued_behind)).toEqual([
      0, 1,
    ]);
    const [first, second] = ends();
    expect(first?.waited_ms).toBe(0);
    expect(Number(first?.duration_ms)).toBeGreaterThanOrEqual(70);
    expect(Number(second?.waited_ms)).toBeGreaterThanOrEqual(70);
    expect(Number(second?.duration_ms)).toBeGreaterThanOrEqual(30);
    expect(Number(second?.duration_ms)).toBeLessThan(Number(second?.waited_ms));
    await session.stop();
  });

  it("names the turn a dying stream cut off, and starts clean on the next launch", async () => {
    const { session, log, ends } = setup([
      async function* (sent, wait) {
        await wait(1);
        yield result([String(sent[0]?.uuid)]);
        await wait(2);
        throw new Error("cli exited");
      },
      async function* (sent, wait) {
        await wait(1);
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: { content: [{ type: "tool_use", id: "toolu_3", name: "get_game", input: {} }] },
        } as unknown as SDKMessage;
        yield result([String(sent[0]?.uuid)]);
      },
    ]);
    await session.start();
    await session.send("one");
    await vi.waitFor(() => expect(ends()).toHaveLength(1));
    await session.send("two");
    await vi.waitFor(() => expect(log.named("coach.turn_error")).toHaveLength(1));
    expect(log.named("coach.turn_error")[0]?.fields).toMatchObject({ turn: 2, queued_turns: [2] });
    await session.send("three");
    await vi.waitFor(() => expect(ends()).toHaveLength(2));
    // The relaunch dropped the turn the dead stream never answered.
    expect(ends()[1]).toMatchObject({ turn: 3, turns: [3] });
    expect(log.named("coach.tool_call")[0]?.fields).toMatchObject({
      tool_use_id: "toolu_3",
      turn: 3,
    });
    await session.stop();
  });

  it("says notifications were folded only when they waited for an answer", async () => {
    const { db, session, log, ends } = setup([
      async function* (sent, wait) {
        await wait(1);
        await pause(30);
        yield result([String(sent[0]?.uuid)]);
        await wait(2);
        yield result([String(sent[1]?.uuid)]);
        await wait(3);
        yield result([String(sent[2]?.uuid)]);
      },
    ]);
    const turn = (ply: number) => ({
      type: "turn" as const,
      game_id: 1,
      ply,
      move_number: ply,
      player_san: "e4",
      player_uci: "e2e4",
      cp_loss: 0,
      classification: "best" as const,
      best_san: "e4",
      engine_reply_san: "e5",
      fen: "8/8/8/8/8/8/8/K6k w - - 0 1",
    });
    await session.start();
    await session.send("one");
    // Arrives while the coach is answering, so it waits and is folded.
    writeNotification(db, session.ensureSessionId(), turn(1));
    session.flushNotifications();
    await vi.waitFor(() => expect(ends()).toHaveLength(2));
    // Arrives with the coach idle.
    writeNotification(db, session.ensureSessionId(), turn(3));
    session.flushNotifications();
    await vi.waitFor(() => expect(ends()).toHaveLength(3));
    const starts = log.named("coach.turn_start").map((entry) => entry.fields);
    expect(starts.map((start) => start.source)).toEqual([
      "user_text",
      "notifications",
      "notifications",
    ]);
    expect(starts.map((start) => start.folded)).toEqual([undefined, true, false]);
    expect(starts[0]).toMatchObject({ message: "one" });
    expect(starts[0]).not.toHaveProperty("text");
    await session.stop();
  });
});
