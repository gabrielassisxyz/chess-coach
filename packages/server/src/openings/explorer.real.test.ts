import { describe, expect, it } from "vitest";
import { httpExplorerFetcher, parsePosition } from "./explorer-client.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Opt-in: one real call, shape only. The explorer wants a Lichess API token in LICHESS_API_TOKEN.
describe.skipIf(process.env.CHESS_COACH_EXPLORER !== "1")("real Lichess explorer", () => {
  it("answers the start position in the shape the generator reads", async () => {
    const text = await httpExplorerFetcher(process.env.LICHESS_API_TOKEN).fetch(START);
    const position = parsePosition(text);
    expect(position.moves.length).toBeGreaterThan(0);
    expect(position.white + position.draws + position.black).toBeGreaterThan(200);
  }, 30_000);
});
