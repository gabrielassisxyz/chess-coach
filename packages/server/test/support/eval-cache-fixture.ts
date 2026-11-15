import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  type EvalCache,
  openEvalCache,
  packKey,
  type StoredSet,
} from "../../src/engine/eval-cache.js";
import { RecordingLog } from "../../src/log.js";

const PROMOTION_CODES: Record<string, number> = { "": 0, n: 1, b: 2, r: 3, q: 4 };

function packMove(uci: string): Buffer {
  const square = (text: string): number => text.charCodeAt(0) - 97 + (Number(text[1]) - 1) * 8;
  const packed =
    square(uci.slice(0, 2)) |
    (square(uci.slice(2, 4)) << 6) |
    ((PROMOTION_CODES[uci.slice(4)] ?? 0) << 12);
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(packed);
  return bytes;
}

/** The value bytes `tools/build_eval_cache.py` writes for these sets, which the golden fixture pins. */
export function encodeValue(sets: readonly StoredSet[]): Buffer {
  const parts: Buffer[] = [Buffer.from([1, sets.length])];
  for (const set of sets) {
    const head = Buffer.alloc(6);
    head.writeUInt8(set.depth, 0);
    head.writeUInt32LE(set.knodes, 1);
    head.writeUInt8(set.lines.length, 5);
    parts.push(head);
    for (const line of set.lines) {
      const lineHead = Buffer.alloc(3);
      lineHead.writeUInt8(line.moves.length | (line.mate ? 128 : 0), 0);
      lineHead.writeInt16LE(line.score, 1);
      parts.push(lineHead, ...line.moves.map(packMove));
    }
  }
  return Buffer.concat(parts);
}

/** A stored set from `[score, "uci uci"]` pairs, scored from White's side as the file is. */
export function storedSet(
  depth: number,
  lines: ReadonlyArray<readonly [number, string]>,
  options: { mate?: boolean } = {},
): StoredSet {
  return {
    depth,
    knodes: 1000,
    lines: lines.map(([score, moves]) => ({
      mate: options.mate ?? false,
      score,
      moves: moves === "" ? [] : moves.split(" "),
    })),
  };
}

export interface FixtureRow {
  /** The first four fields of the position's FEN. */
  epd: string;
  /** The sets as the file keeps them: the deepest first. */
  sets: StoredSet[];
  /** Bytes to store in place of the encoded sets, for a row that is damaged. */
  value?: Buffer;
}

/** Writes a file with the cache's table and one row for each position, under a temporary directory. */
export function writeEvalCacheFile(rows: readonly FixtureRow[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "eval-cache-")), "evals.db");
  const db = new BetterSqlite3(path);
  db.exec(
    "CREATE TABLE evals (key BLOB PRIMARY KEY, source INTEGER NOT NULL, depth INTEGER NOT NULL, value BLOB NOT NULL) WITHOUT ROWID",
  );
  const insert = db.prepare("INSERT INTO evals (key, source, depth, value) VALUES (?, 0, ?, ?)");
  for (const row of rows) {
    insert.run(packKey(row.epd), row.sets[0]?.depth ?? 0, row.value ?? encodeValue(row.sets));
  }
  db.close();
  return path;
}

/** A real cache over a file of these rows, with the log it wrote to. */
export function openFixtureCache(rows: readonly FixtureRow[]): {
  cache: EvalCache;
  log: RecordingLog;
  path: string;
} {
  const path = writeEvalCacheFile(rows);
  const log = new RecordingLog();
  return { cache: openEvalCache(path, log), log, path };
}

/** A cache that fails the test that reads it: for the paths that must never look a position up. */
export class ThrowingEvalCache implements EvalCache {
  calls = 0;

  lookup(): never {
    this.calls += 1;
    throw new Error("the evaluation cache was read");
  }

  close(): void {}
}
