import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildCoachTools } from "../../src/coach/tools.js";
import { openDatabase } from "../../src/db/open.js";
import { getCard, listCardsNewestFirst } from "../../src/db/srs.js";
import { contentDir } from "../../src/paths.js";
import { makeWorld } from "../fakes/fake-world.js";
import { insertGradedGame, START_FEN } from "../fixture-game.js";

function setup() {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "srs-tools-")));
  const fake = makeWorld(db);
  const now = () => new Date("2026-03-01T00:00:00.000Z");
  const tools = buildCoachTools({ db, contentDir: contentDir(), world: fake.world, now });
  const find = (name: string) => {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`tool ${name} is not registered`);
    return found;
  };
  const call = async (name: string, input: Record<string, unknown>) => {
    const def = find(name);
    const parsed = z.object(def.inputSchema).parse(input);
    const result = await def.handler(parsed as never, {});
    const text = (result.content[0] as { text: string }).text;
    return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
  };
  const accepts = (name: string, input: Record<string, unknown>) =>
    z.object(find(name).inputSchema).safeParse(input).success;
  return { db, fake, tools, call, accepts };
}

const teaching = {
  fen: START_FEN,
  played_uci: "e2e4",
  best_uci: "d2d4",
  explanation: "Develop with a plan.",
};

describe("registration", () => {
  it("registers the three SRS tools", () => {
    const names = setup().tools.map((entry) => entry.name);
    expect(names).toEqual(
      expect.arrayContaining(["create_srs_cards", "add_srs_card", "explain_card"]),
    );
  });
});

describe("create_srs_cards", () => {
  it("creates the batch for a finished game and then skips it", async () => {
    const { db, call } = setup();
    const gameId = insertGradedGame(db);
    expect(await call("create_srs_cards", { game_id: gameId })).toEqual({
      isError: false,
      body: { created: 3, skipped: 0 },
    });
    expect((await call("create_srs_cards", { game_id: gameId })).body).toEqual({
      created: 0,
      skipped: 3,
    });
  });

  it("answers game_not_finished for a live game", async () => {
    const { db, call } = setup();
    const gameId = insertGradedGame(db, false);
    expect(await call("create_srs_cards", { game_id: gameId })).toMatchObject({
      isError: true,
      body: { error: "game_not_finished" },
    });
  });
});

describe("add_srs_card", () => {
  it("stores a teaching card with numbers the server measured", async () => {
    const { db, call, fake } = setup();
    const out = await call("add_srs_card", teaching);
    expect(out).toMatchObject({
      isError: false,
      body: { cp_loss: 220, classification: "mistake" },
    });
    expect(fake.evaluated).toEqual([{ fen: START_FEN, uci: "e2e4", color: "w" }]);
    const [card] = listCardsNewestFirst(db, 5);
    expect(card).toMatchObject({
      sourceKind: "teaching",
      sourceGameId: null,
      sourceMoveId: null,
      studentColor: "white",
      cpLoss: 220,
      expectedUci: "d2d4",
      explanation: "Develop with a plan.",
      nextReviewAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("rejects a played move that is illegal in the position", async () => {
    const { db, call, fake } = setup();
    const out = await call("add_srs_card", { ...teaching, played_uci: "e2e5" });
    expect(out).toMatchObject({ isError: true, body: { error: "illegal_move" } });
    expect(fake.evaluated).toEqual([]);
    expect(listCardsNewestFirst(db, 5)).toEqual([]);
  });

  it("rejects a best move that is illegal, and malformed input at the schema", async () => {
    const { call, accepts } = setup();
    expect((await call("add_srs_card", { ...teaching, best_uci: "a1a8" })).isError).toBe(true);
    expect(accepts("add_srs_card", { ...teaching, played_uci: "e4" })).toBe(false);
    expect(accepts("add_srs_card", { ...teaching, fen: "nonsense" })).toBe(false);
    expect(accepts("add_srs_card", { ...teaching, explanation: "" })).toBe(false);
  });
});

describe("explain_card", () => {
  it("writes the explanation onto the card", async () => {
    const { db, call } = setup();
    await call("add_srs_card", teaching);
    const [card] = listCardsNewestFirst(db, 1);
    const out = await call("explain_card", {
      card_id: card?.id,
      explanation: "Better: take space.",
    });
    expect(out.isError).toBe(false);
    expect(getCard(db, card?.id ?? 0)?.explanation).toBe("Better: take space.");
  });

  it("answers card_not_found for an unknown id", async () => {
    expect(await setup().call("explain_card", { card_id: 42, explanation: "x" })).toMatchObject({
      isError: true,
      body: { error: "card_not_found" },
    });
  });

  it("accepts 2000 characters and refuses 2001 or none", () => {
    const { accepts } = setup();
    expect(accepts("explain_card", { card_id: 1, explanation: "x".repeat(2000) })).toBe(true);
    expect(accepts("explain_card", { card_id: 1, explanation: "x".repeat(2001) })).toBe(false);
    expect(accepts("explain_card", { card_id: 1, explanation: "" })).toBe(false);
  });
});

describe("get_due_cards", () => {
  it("returns the coach's view of due cards, oldest first, and no exposure id", async () => {
    const { db, call } = setup();
    insertGradedGame(db);
    await call("create_srs_cards", { game_id: 1 });
    const out = await call("get_due_cards", { limit: 2 });
    const cards = out.body as unknown as Record<string, unknown>[];
    expect(cards).toHaveLength(2);
    expect(Object.keys(cards[0] ?? {}).sort()).toEqual(
      [
        "classification",
        "cp_loss",
        "explanation",
        "expected_san",
        "id",
        "next_review_at",
        "played_san",
        "prompt_fen",
        "student_color",
      ].sort(),
    );
    expect(cards.map((card) => card.id)).toEqual([1, 2]);
    expect(JSON.stringify(out.body)).not.toMatch(/exposure/);
  });

  it("is capped at 20 and read-only", async () => {
    const { db, accepts, call } = setup();
    expect(accepts("get_due_cards", { limit: 21 })).toBe(false);
    expect(accepts("get_due_cards", { limit: 0 })).toBe(false);
    expect(accepts("get_due_cards", {})).toBe(true);
    expect((await call("get_due_cards", {})).body).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM srs_reviews").get()).toEqual({ n: 0 });
  });
});
