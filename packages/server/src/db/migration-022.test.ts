import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "./migrate.js";

let tmp: string;
let db: BetterSqlite3.Database;

// A database as it stands at 021, opened the way the server opens it: with foreign keys enforced.
function databaseAt021(): BetterSqlite3.Database {
  const dir = join(tmp, "at-021");
  mkdirSync(dir);
  for (const name of readdirSync(defaultMigrationsDir)) {
    if (name < "022") cpSync(join(defaultMigrationsDir, name), join(dir, name));
  }
  const opened = new BetterSqlite3(join(tmp, "a.db"));
  opened.pragma("foreign_keys = ON");
  runMigrations(opened, dir);
  return opened;
}

interface StoredRow {
  id: number;
  kind: "own" | "reply";
  position: string;
  ply: number;
  uci: string;
  cpLoss: number | null;
  evalCp: number | null;
  counts: [wins: number | null, draws: number | null, losses: number | null];
}

// Explicit ids with gaps, so a copy that lets SQLite number the rows again is caught.
const ROWS_AT_021: StoredRow[] = [
  {
    id: 7,
    kind: "own",
    position: "a",
    ply: 7,
    uci: "c2c3",
    cpLoss: 10,
    evalCp: 30,
    counts: [5, 1, 4],
  },
  {
    id: 11,
    kind: "reply",
    position: "b",
    ply: 8,
    uci: "g8f6",
    cpLoss: null,
    evalCp: null,
    counts: [null, null, null],
  },
  {
    id: 12,
    kind: "own",
    position: "c",
    ply: 9,
    uci: "d2d4",
    cpLoss: 0,
    evalCp: -15,
    counts: [null, null, null],
  },
];

function storeRowsAt021(): void {
  db.prepare(
    "INSERT INTO repertoires (id, side, group_name, variation_name) VALUES (4, 'white', 'Italian Game', 'Classical Variation (4.c3)')",
  ).run();
  const insert = db.prepare(
    `INSERT INTO repertoire_positions (id, repertoire_id, kind, position_key, ply, line_san,
       move_uci, move_san, share, reach, opening_name, idea, source, cp_loss, eval_cp,
       wins, draws, losses)
     VALUES (?, 4, ?, ?, ?, '["e4","e5"]', ?, 'x', 0.4, 0.2, 'Italian Game', 'An idea.', 'explorer',
       ?, ?, ?, ?, ?)`,
  );
  for (const row of ROWS_AT_021) {
    insert.run(
      row.id,
      row.kind,
      row.position,
      row.ply,
      row.uci,
      row.cpLoss,
      row.evalCp,
      ...row.counts,
    );
  }
}

const positions = (): unknown[] =>
  db.prepare("SELECT * FROM repertoire_positions ORDER BY id").all();

const columnsOfPositions = (): Array<{
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
}> =>
  db.prepare("PRAGMA table_info(repertoire_positions)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-mig022-"));
  db = databaseAt021();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("022_repertoire_eval_depth", () => {
  it("keeps every stored row as it was and leaves its depth null", () => {
    storeRowsAt021();
    const before = positions();
    expect(before).toHaveLength(ROWS_AT_021.length);

    expect(runMigrations(db, defaultMigrationsDir)).toEqual(["022_repertoire_eval_depth.sql"]);

    expect(positions()).toEqual(before.map((row) => ({ ...(row as object), eval_depth: null })));
    expect(db.prepare("SELECT id FROM repertoire_positions ORDER BY id").all()).toEqual([
      { id: 7 },
      { id: 11 },
      { id: 12 },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("adds one nullable integer column at the end and changes no other column", () => {
    const before = columnsOfPositions();
    runMigrations(db, defaultMigrationsDir);
    const after = columnsOfPositions();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual([
      expect.objectContaining({
        name: "eval_depth",
        type: "INTEGER",
        notnull: 0,
        dflt_value: null,
      }),
    ]);
  });

  it("stores a depth on a row written after it, and a row with none keeps null", () => {
    storeRowsAt021();
    runMigrations(db, defaultMigrationsDir);
    db.prepare("UPDATE repertoire_positions SET eval_depth = 9 WHERE id = 7").run();
    expect(db.prepare("SELECT id, eval_depth FROM repertoire_positions ORDER BY id").all()).toEqual(
      [
        { id: 7, eval_depth: 9 },
        { id: 11, eval_depth: null },
        { id: 12, eval_depth: null },
      ],
    );
  });
});
