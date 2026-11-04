import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertGradedGame } from "../../test/fixture-game.js";
import { buildApp } from "../app.js";
import { type Database, openDatabase } from "../db/open.js";
import { createCardsFromGame } from "../srs/cards.js";

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-cards-http-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function get(url: string) {
  const app = buildApp({ db });
  const response = await app.inject({ method: "GET", url });
  await app.close();
  return response;
}

describe("GET /api/cards", () => {
  it("lists the cards newest first with SAN for both moves", async () => {
    createCardsFromGame(db, insertGradedGame(db), { now: () => new Date("2026-02-01T00:00:00Z") });
    const response = await get("/api/cards");
    expect(response.statusCode).toBe(200);
    const { cards } = response.json() as { cards: Record<string, unknown>[] };
    expect(cards.map((card) => card.cp_loss)).toEqual([420, 150, 81]);
    expect(cards[0]).toMatchObject({
      played_san: "e4",
      expected_san: "d4",
      classification: "blunder",
      explanation: null,
      next_review_at: "2026-02-01T00:00:00.000Z",
    });
    expect(cards[0]).toHaveProperty("prompt_fen");
  });

  it("honours limit and rejects values outside 1..500", async () => {
    createCardsFromGame(db, insertGradedGame(db), { now: () => new Date() });
    const limited = await get("/api/cards?limit=2");
    expect((limited.json() as { cards: unknown[] }).cards).toHaveLength(2);
    expect((await get("/api/cards?limit=500")).statusCode).toBe(200);
    expect((await get("/api/cards?limit=501")).statusCode).toBe(400);
    expect((await get("/api/cards?limit=0")).statusCode).toBe(400);
    expect((await get("/api/cards?limit=abc")).statusCode).toBe(400);
  });

  it("applies the default limit of 50", async () => {
    const insert = db.prepare(
      `INSERT INTO srs_cards (source_kind, prompt_fen, student_color, expected_uci, created_at, next_review_at)
       VALUES ('teaching', 'f', 'white', 'd2d4', 't', 't')`,
    );
    for (let i = 0; i < 60; i++) insert.run();
    expect(((await get("/api/cards")).json() as { cards: unknown[] }).cards).toHaveLength(50);
  });

  it("is absent when the app is built without a database", async () => {
    const app = buildApp();
    expect((await app.inject({ method: "GET", url: "/api/cards" })).statusCode).toBe(404);
    await app.close();
  });
});
