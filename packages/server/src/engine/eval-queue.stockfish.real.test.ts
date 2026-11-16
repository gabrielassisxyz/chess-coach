import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { writeEvalCacheFile } from "../../test/support/eval-cache-fixture.js";
import { openDatabase } from "../db/open.js";
import { silentLog } from "../log.js";
import { decodeValue, openEvalCache, openEvalCacheWriter, packKey } from "./eval-cache.js";
import { EvalQueue, EvalQueueWorker, QUEUE_NICENESS } from "./eval-queue.js";
import { spawnStockfish } from "./process.js";

// After 1.f3 e5 2.g4 with Black to move: Qh4 is mate in one. The file scores from White's side and
// the engine from the side to move, and Black is the side to move, so a sign slipped anywhere
// between the search and the stored row would read back as a lost position.
const BLACK_MATES_IN_ONE = "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2";

describe.skipIf(process.env.CHESS_COACH_STOCKFISH !== "1")(
  "the evaluation queue against the real engine",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-queue-real-"));
    const db = openDatabase(dir);
    const path = writeEvalCacheFile([]);
    const writer = openEvalCacheWriter(path);
    const queue = new EvalQueue(db);
    const cache = openEvalCache(path, silentLog, (miss) => queue.offer(miss));
    const worker = new EvalQueueWorker({
      queue,
      store: writer ?? { ensureOpen: () => {}, store: () => "empty" },
      spawn: () => spawnStockfish(undefined, QUEUE_NICENESS),
      busy: () => false,
      search: { depth: 12, lines: 3, capMs: 30_000 },
    });

    afterAll(async () => {
      await worker.stop();
      cache.close();
      writer?.close();
      db.close();
    });

    it("searches a queued position under nice, stores it and answers the next lookup from the cache", async () => {
      expect(writer).not.toBeNull();
      expect(cache.lookup(BLACK_MATES_IN_ONE, { lines: 3, depth: 12 })).toBeNull();
      expect(queue.size()).toBe(1);

      expect(await worker.runOnce()).toBe("done");

      expect(queue.size()).toBe(0);
      const hit = cache.lookup(BLACK_MATES_IN_ONE, { lines: 3, depth: 12 });
      expect(hit?.lines).toHaveLength(3);
      expect(hit?.depth).toBeGreaterThanOrEqual(12);
      expect(hit?.lines[0]?.moves[0]).toBe("d8h4");
      expect(hit?.lines[0]?.score).toBe(10000);

      const raw = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
      try {
        const epd = BLACK_MATES_IN_ONE.split(" ").slice(0, 4).join(" ");
        const row = raw
          .prepare("SELECT source, value FROM evals WHERE key = ?")
          .get(packKey(epd)) as {
          source: number;
          value: Buffer;
        };
        expect(row.source).toBe(1);
        const [set] = decodeValue(row.value);
        expect(set?.lines[0]?.score).toBe(-10000);
        expect(set?.knodes).toBeGreaterThan(0);
      } finally {
        raw.close();
      }
    });
  },
);
