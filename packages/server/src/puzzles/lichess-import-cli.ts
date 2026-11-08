import { createInterface } from "node:readline";
import { systemClock } from "../clock.js";
import { openDatabase } from "../db/open.js";
import { createFileLog } from "../log.js";
import { dataDir } from "../paths.js";
import { importLichessPuzzles } from "./lichess-import.js";

const db = openDatabase(dataDir());
const log = createFileLog({ dir: `${dataDir()}/logs` });
const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

try {
  const { added, skipped, failed } = await importLichessPuzzles({
    lines,
    db,
    clock: systemClock,
    log,
  });
  process.stdout.write(`added ${added}, skipped ${skipped}, failed ${failed}\n`);
} finally {
  db.close();
}
