import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultMigrationsDir, runMigrations } from "./migrate.js";

let tmp: string;
let db: BetterSqlite3.Database;

// A database as it stands before 027, opened the way the server opens it: with foreign keys enforced.
function databaseBefore027(): BetterSqlite3.Database {
  const dir = join(tmp, "before-027");
  mkdirSync(dir);
  for (const name of readdirSync(defaultMigrationsDir)) {
    if (name < "027") cpSync(join(defaultMigrationsDir, name), join(dir, name));
  }
  const opened = new BetterSqlite3(join(tmp, "a.db"));
  opened.pragma("foreign_keys = ON");
  runMigrations(opened, dir);
  return opened;
}

// The migrations up to and including 027, so that a column a later one adds to repertoires is not
// read as 027's doing.
function migrationsThrough027(): string {
  const dir = join(tmp, "through-027");
  mkdirSync(dir);
  for (const name of readdirSync(defaultMigrationsDir)) {
    if (name < "028") cpSync(join(defaultMigrationsDir, name), join(dir, name));
  }
  return dir;
}

const variations = (): unknown[] => db.prepare("SELECT * FROM repertoires ORDER BY id").all();

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
}

const columnsOfRepertoires = (): ColumnInfo[] =>
  db.prepare("PRAGMA table_info(repertoires)").all() as ColumnInfo[];

const INSERT_WITH_POINTS =
  "INSERT INTO repertoires (side, group_name, variation_name, points_effectiveness, points_soundness, points_learnability) VALUES ('white', 'Italian Game', ?, ?, ?, ?)";

const INSERT_WITH_BRANCH =
  "INSERT INTO repertoires (side, group_name, variation_name, branch_san) VALUES ('white', 'Italian Game', ?, ?)";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-mig027-"));
  db = databaseBefore027();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("027_repertoire_points_and_branch", () => {
  it("keeps every stored variation as it was and leaves its points and branch null", () => {
    db.prepare(
      "INSERT INTO repertoires (id, side, group_name, variation_name) VALUES (4, 'white', 'Italian Game', 'Classical Variation (4.c3)')",
    ).run();
    db.prepare(
      "INSERT INTO repertoires (id, side, group_name, variation_name) VALUES (9, 'white', 'Scandinavian Defense', 'Mieses-Kotroc Variation (2.exd5)')",
    ).run();
    const before = variations();
    expect(before).toHaveLength(2);

    expect(runMigrations(db, migrationsThrough027())).toContain(
      "027_repertoire_points_and_branch.sql",
    );

    const nothingStored = {
      points_effectiveness: null,
      points_soundness: null,
      points_learnability: null,
      branch_san: null,
    };
    expect(variations()).toEqual(before.map((row) => ({ ...(row as object), ...nothingStored })));
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("adds four nullable columns at the end and changes no other column", () => {
    const before = columnsOfRepertoires();
    runMigrations(db, migrationsThrough027());
    const after = columnsOfRepertoires();
    const nullable = { notnull: 0, dflt_value: null };
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual([
      expect.objectContaining({ name: "points_effectiveness", type: "INTEGER", ...nullable }),
      expect.objectContaining({ name: "points_soundness", type: "INTEGER", ...nullable }),
      expect.objectContaining({ name: "points_learnability", type: "INTEGER", ...nullable }),
      expect.objectContaining({ name: "branch_san", type: "TEXT", ...nullable }),
    ]);
  });

  it("stores the three points together or none, and never a negative number", () => {
    runMigrations(db, defaultMigrationsDir);
    db.prepare(INSERT_WITH_POINTS).run("whole", 3, 2, 1);

    expect(() =>
      db
        .prepare(
          "INSERT INTO repertoires (side, group_name, variation_name, points_effectiveness) VALUES ('white', 'Italian Game', 'partial', 3)",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare(INSERT_WITH_POINTS).run("negative", -1, 4, 3)).toThrow(
      /CHECK constraint failed/,
    );
    expect(db.prepare("SELECT variation_name FROM repertoires").all()).toEqual([
      { variation_name: "whole" },
    ]);
  });

  it("stores a branch as a JSON list and refuses anything else", () => {
    runMigrations(db, defaultMigrationsDir);
    db.prepare(INSERT_WITH_BRANCH).run("list", JSON.stringify(["e4", "e5", "Nf3"]));

    expect(() => db.prepare(INSERT_WITH_BRANCH).run("text", "not json")).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => db.prepare(INSERT_WITH_BRANCH).run("object", '{"move":"e4"}')).toThrow(
      /CHECK constraint failed/,
    );
    expect(db.prepare("SELECT variation_name FROM repertoires").all()).toEqual([
      { variation_name: "list" },
    ]);
  });
});
