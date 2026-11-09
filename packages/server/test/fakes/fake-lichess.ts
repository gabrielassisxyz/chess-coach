import { readFileSync } from "node:fs";
import {
  type LichessGame,
  type LichessGamesFetcher,
  parseLichessGames,
} from "../../src/import/lichess.js";

const MONTH_2026_10 = readFileSync(
  new URL("../fixtures/lichess/2026-10.ndjson", import.meta.url),
  "utf8",
);

// Serves the recorded October 2026 export and nothing for any other range, or `serves` when a test
// sets it. It checks nothing and remembers every call, so a test can tell whether a request was
// stopped before it got here.
export class FakeLichess implements LichessGamesFetcher {
  readonly asked: string[] = [];
  failWith: Error | null = null;
  serves: LichessGame[] | null = null;

  async games(username: string, from: string, to: string): Promise<LichessGame[]> {
    this.asked.push(`${username}/${from}..${to}`);
    if (this.failWith) throw this.failWith;
    if (this.serves) return this.serves;
    return from <= "2026-10" && "2026-10" <= to ? parseLichessGames(MONTH_2026_10) : [];
  }
}
