import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ExplorerClock,
  type ExplorerFetcher,
  ExplorerRateLimited,
} from "../../src/openings/explorer-client.js";
import { positionKey } from "../../src/openings/from-games.js";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "explorer", "openings-tree.json");

/** Serves the recorded-shape answers by position and notes when each call arrived. */
export class FakeExplorer implements ExplorerFetcher {
  readonly calls: Array<{ key: string; at: number }> = [];
  rateLimitFirst = 0;
  private readonly answers = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;

  constructor(private readonly clock: ExplorerClock) {}

  async fetch(fen: string): Promise<string> {
    const key = positionKey(fen);
    this.calls.push({ key, at: this.clock.now() });
    if (this.rateLimitFirst > 0) {
      this.rateLimitFirst -= 1;
      throw new ExplorerRateLimited();
    }
    // A position nobody recorded is one the explorer has no games for.
    return JSON.stringify(this.answers[key] ?? { white: 0, draws: 0, black: 0, moves: [] });
  }
}

/** Time moves only when a test sleeps or advances it. */
export class FakeClock implements ExplorerClock {
  readonly sleeps: number[] = [];
  constructor(private time = 1_800_000_000_000) {}

  now(): number {
    return this.time;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.time += ms;
  }

  advance(ms: number): void {
    this.time += ms;
  }
}
