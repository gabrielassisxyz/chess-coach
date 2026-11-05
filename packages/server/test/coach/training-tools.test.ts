import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildTrainingTools } from "../../src/coach/training-tools.js";
import { createCoachSession } from "../../src/db/chat.js";
import { openDatabase } from "../../src/db/open.js";
import { ReviewDesk } from "../../src/srs/review.js";
import { makeWorld } from "../fakes/fake-world.js";

const FORK = "r2qk2r/pQp1ppbp/6p1/1N3P2/2p2B2/8/PPn2P1P/R4K1R w kq - 2 14";

function setup() {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "training-tools-")));
  db.prepare(
    `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
     VALUES ('forks:0', 'test', 'fork', 'easy', ?, '["f4e5"]', '[]', 'the bishop forks')`,
  ).run(FORK);
  const session = createCoachSession(db, { promptVersion: "v" });
  const notifications = { sessionId: () => session.id };
  const fake = makeWorld(db, [], { desk: new ReviewDesk({ db, notifications }), notifications });
  const tools = buildTrainingTools(fake.world);
  const call = async (name: string, input: Record<string, unknown>) => {
    const def = tools.find((entry) => entry.name === name);
    if (!def) throw new Error(`${name} is not registered`);
    const result = await def.handler(z.object(def.inputSchema).parse(input) as never, {});
    return {
      isError: result.isError === true,
      body: JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>,
    };
  };
  const cards = () => db.prepare("SELECT * FROM srs_cards").all() as Record<string, unknown>[];
  return { db, fake, call, cards };
}

describe("serve_puzzle", () => {
  it("starts a one-item training activity with exploration open", async () => {
    const { fake, call } = setup();
    const { body, isError } = await call("serve_puzzle", { puzzle_id: "forks:0" });
    expect(isError).toBe(false);
    expect(body).toEqual({ item_kind: "puzzle", id: "forks:0", fen: FORK, orientation: "white" });
    expect(fake.activity.current()).toMatchObject({
      kind: "training",
      input_enabled: true,
      item: { puzzle_id: "forks:0", position_in_queue: 1, queue_length: 1 },
    });
  });

  it("names an unknown puzzle and an open session", async () => {
    const { call } = setup();
    expect((await call("serve_puzzle", { puzzle_id: "nope:9" })).body.error).toBe(
      "puzzle_not_found",
    );
    await call("serve_puzzle", { puzzle_id: "forks:0" });
    const again = await call("serve_puzzle", { puzzle_id: "forks:0" });
    expect(again).toMatchObject({ isError: true, body: { error: "training_active" } });
  });

  it("leaves one card behind a wrong answer, however many times it is missed", async () => {
    const { fake, call, cards } = setup();
    await call("serve_puzzle", { puzzle_id: "forks:0" });
    await fake.activity.trainingAnswer("h1g1");
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toMatchObject({ puzzle_id: "forks:0", source_kind: "teaching" });
    await fake.activity.endTraining();
    await call("serve_puzzle", { puzzle_id: "forks:0" });
    await fake.activity.trainingAnswer("h1g1");
    expect(cards()).toHaveLength(1);
  });

  it("reports the same puzzle_result row a queued puzzle would", async () => {
    const { fake, call, db } = setup();
    await call("serve_puzzle", { puzzle_id: "forks:0" });
    await fake.activity.trainingAnswer("f4e5");
    const rows = db
      .prepare("SELECT content_json FROM chat_messages WHERE kind = 'notification'")
      .all();
    const types = (rows as { content_json: string }[]).map((r) => JSON.parse(r.content_json).type);
    expect(types).toContain("puzzle_result");
  });
});

describe("serve_card", () => {
  const addCard = (db: ReturnType<typeof setup>["db"]): number =>
    Number(
      db
        .prepare(
          `INSERT INTO srs_cards (source_kind, prompt_fen, student_color, expected_uci, created_at, next_review_at)
           VALUES ('teaching', ?, 'white', 'f4e5', 'x', '2099-01-01T00:00:00.000Z')`,
        )
        .run(FORK).lastInsertRowid,
    );

  it("serves a card that is not due and answers with the srs_answer row", async () => {
    const { db, fake, call } = setup();
    const id = addCard(db);
    const { body } = await call("serve_card", { card_id: id });
    expect(body).toMatchObject({ item_kind: "card", id, fen: FORK, orientation: "white" });
    await fake.activity.trainingAnswer("f4e5");
    const rows = db
      .prepare("SELECT content_json FROM chat_messages WHERE kind = 'notification'")
      .all();
    const types = (rows as { content_json: string }[]).map((r) => JSON.parse(r.content_json).type);
    expect(types).toContain("srs_answer");
  });

  it("names an unknown card and an open session", async () => {
    const { db, call } = setup();
    expect((await call("serve_card", { card_id: 404 })).body.error).toBe("card_not_found");
    const id = addCard(db);
    await call("serve_card", { card_id: id });
    expect((await call("serve_card", { card_id: id })).body.error).toBe("training_active");
  });

  it("refuses a card over the unfinished live game and leaves the board on it", async () => {
    const { db, fake, call } = setup();
    await fake.game.newGame({ color: "white", elo: 1200 });
    const live = await fake.activity.enterLiveGame();
    const out = await call("serve_card", { card_id: addCard(db) });
    expect(out).toMatchObject({ isError: true, body: { error: "live_game_active" } });
    expect(fake.activity.current()).toEqual(live);
  });
});
