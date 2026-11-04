import { readFileSync } from "node:fs";
import { type ChessComFetcher, type ChessComGame, parseMonth } from "../../src/import/chesscom.js";

const MONTH_2026_10 = readFileSync(
  new URL("../fixtures/chesscom/2026-10.json", import.meta.url),
  "utf8",
);

// Serves the recorded October 2026 month and an empty list for any other; remembers what was asked.
export class FakeChessCom implements ChessComFetcher {
  readonly asked: string[] = [];
  failWith: Error | null = null;

  async month(username: string, year: number, month: number): Promise<ChessComGame[]> {
    this.asked.push(`${username}/${year}-${String(month).padStart(2, "0")}`);
    if (this.failWith) throw this.failWith;
    return year === 2026 && month === 10 ? parseMonth(MONTH_2026_10) : [];
  }
}
