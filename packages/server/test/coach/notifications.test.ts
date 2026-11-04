import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import type { CoachEvent } from "../../src/coach/events.js";
import { CoachSession, type QueryFn } from "../../src/coach/session.js";
import { listChatTail, listUndeliveredNotifications } from "../../src/db/chat.js";
import { openDatabase } from "../../src/db/open.js";
import { type TurnNotification, writeNotification } from "../../src/game/notifications.js";
import { contentDir } from "../../src/paths.js";
import { FakeSdk, loadRecordedTurns } from "../fakes/fake-sdk.js";
import { makeWorld } from "../fakes/fake-world.js";

const FEN = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";

function turn(ply: number, cpLoss = 10): TurnNotification {
  return {
    type: "turn",
    game_id: 1,
    ply,
    move_number: Math.ceil(ply / 2),
    player_san: `m${ply}`,
    player_uci: "a2a3",
    cp_loss: cpLoss,
    classification: "great",
    best_san: "d4",
    engine_reply_san: "e5",
    fen: FEN,
  };
}

function setup(query?: (sdk: FakeSdk) => QueryFn) {
  const dataDir = mkdtempSync(join(tmpdir(), "coach-notify-"));
  const db = openDatabase(dataDir);
  const sdk = new FakeSdk();
  const session = new CoachSession({
    db,
    query: query ? query(sdk) : sdk.query,
    contentDir: contentDir(),
    dataDir,
    world: makeWorld(db).world,
    env: {},
    log: () => {},
  });
  const events: CoachEvent[] = [];
  session.onEvent((event) => events.push(event));
  const add = (content: TurnNotification): void => {
    writeNotification(db, session.ensureSessionId(), content);
  };
  const undelivered = () => listUndeliveredNotifications(db, session.ensureSessionId()).length;
  return { db, dataDir, sdk, session, events, add, undelivered };
}

// A query whose every answer waits for the test, so a turn can be held open while moves arrive.
function gatedQuery(texts: string[], gate: { open: () => void }): QueryFn {
  const answer: SDKMessage[] = loadRecordedTurns()[0] ?? [];
  let release: (() => void) | undefined;
  gate.open = () => release?.();
  return ({ prompt }) => {
    async function* run(): AsyncGenerator<SDKMessage, void> {
      for await (const user of prompt as AsyncIterable<SDKUserMessage>) {
        texts.push(String(user.message.content));
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        for (const message of answer) yield message;
      }
    }
    return run();
  };
}

describe("notification delivery", () => {
  it("sends two undelivered rows as one message after a restart, then never again", async () => {
    const first = setup();
    first.add(turn(1));
    first.add(turn(3));
    await first.session.start();
    await vi.waitFor(() => expect(first.sdk.userTexts).toHaveLength(1));
    expect(first.sdk.userTexts[0]).toContain("Several updates arrived");
    expect(first.undelivered()).toBe(0);
    await first.session.stop();

    const second = new FakeSdk();
    const again = new CoachSession({
      db: first.db,
      query: second.query,
      contentDir: contentDir(),
      dataDir: first.dataDir,
      world: makeWorld(first.db).world,
      env: {},
      log: () => {},
    });
    await again.start();
    await again.stop();
    expect(second.userTexts).toEqual([]);
  });

  it("does not mark an unsent notification as a lost answer on restart", async () => {
    const { db, session, add } = setup();
    add(turn(1));
    await session.start();
    const rows = listChatTail(db, session.ensureSessionId(), 10);
    expect(rows.map((row) => row.kind)).toEqual(["notification"]);
    await session.stop();
  });

  it("keeps rows written during boot recovery for start() and launches the SDK once", async () => {
    const { sdk, session, add, undelivered } = setup();
    add(turn(1));
    session.flushNotifications();
    expect(sdk.calls).toHaveLength(0);
    expect(undelivered()).toBe(1);
    await session.start();
    await vi.waitFor(() => expect(sdk.userTexts).toHaveLength(1));
    expect(sdk.calls).toHaveLength(1);
    await session.stop();
  });

  it("folds the moves that arrive while the coach answers into the next single message", async () => {
    const texts: string[] = [];
    const gate = { open: () => {} };
    const { session, events, add, undelivered } = setup(() => gatedQuery(texts, gate));
    await session.start();

    add(turn(1, 150));
    session.flushNotifications();
    await vi.waitFor(() => expect(texts).toHaveLength(1));
    expect(texts[0]).toContain("The student played 1. m1");

    add(turn(3, 200));
    add(turn(5, 20));
    add(turn(7, 5));
    session.flushNotifications();
    expect(texts).toHaveLength(1);
    expect(undelivered()).toBe(3);

    gate.open();
    await vi.waitFor(() => expect(texts).toHaveLength(2));
    expect(texts[1]).toContain("(3 in all)");
    expect(texts[1]).toContain("- 2. m3 (great, cp loss 200");
    expect(texts[1]).toContain("The student played 4. m7");
    expect(undelivered()).toBe(0);

    gate.open();
    await vi.waitFor(() => expect(events.filter((e) => e.kind === "turn_end")).toHaveLength(2));
    expect(texts).toHaveLength(2);
    await session.stop();
  });
});
