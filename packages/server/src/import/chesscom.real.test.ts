import { describe, expect, it } from "vitest";
import { httpFetcher } from "./chesscom.js";

// Opt-in: one real call to the public API. It asserts the shape only, never which games exist.
describe.skipIf(process.env.CHESS_COACH_CHESSCOM !== "1")("real Chess.com", () => {
  it("lists a month of games in the shape the importer reads", async () => {
    const games = await httpFetcher().month("assiszzz", 2026, 10);
    expect(Array.isArray(games)).toBe(true);
    for (const game of games) {
      expect(game.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof game.pgn).toBe("string");
      expect(typeof game.end_time).toBe("number");
    }
  }, 30_000);

  it("tells an existing account from a missing one", async () => {
    await expect(httpFetcher().playerExists("erik")).resolves.toBe(true);
    await expect(httpFetcher().playerExists("no-such-account-x9")).resolves.toBe(false);
  }, 30_000);
});
