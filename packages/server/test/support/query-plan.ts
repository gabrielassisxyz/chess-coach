import { expect } from "vitest";
import type { Database } from "../../src/db/open.js";

// The plan names a table by its alias, and the queries under test alias puzzle_attempts as a and
// puzzles as p. The primary key of puzzles is a text column, so SQLite reaches it through an
// automatic index and not through the rowid.
const ATTEMPTS_SCAN = /^SCAN a\b/;
const PUZZLES_STEP = /^(?:SCAN|SEARCH) p\b/;
const PUZZLES_BY_PRIMARY_KEY = "SEARCH p USING INDEX sqlite_autoindex_puzzles_1 (id=?)";
const ATTEMPTS_CROSS_JOINED = /\bFROM puzzle_attempts a CROSS JOIN puzzles p\b/;

/** The `detail` column of `EXPLAIN QUERY PLAN`, one string per step, in the order SQLite prints them. */
export function queryPlanSteps(db: Database, sql: string): string[] {
  // The plan does not depend on the values, so every placeholder is bound to NULL.
  const placeholders = (sql.match(/\?/g) ?? []).map(() => null);
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...placeholders) as { detail: string }[];
  return rows.map((row) => row.detail);
}

/**
 * A query over the student's puzzle attempts must cost what the attempts cost, however many
 * puzzles are stored: the plan starts with a scan of puzzle_attempts and reaches puzzles only by
 * its primary key. The database has no sqlite_stat1, so without CROSS JOIN the planner is free to
 * walk every puzzle by an index and probe the attempts for each one.
 *
 * Where the planner happens to choose the right order anyway, the plan cannot tell CROSS JOIN from
 * JOIN, so the form is asserted too: it is what keeps a later index or import from changing it.
 */
export function expectAttemptsLeadThePuzzleJoin(db: Database, sql: string): void {
  // The migrations create this index; stating it keeps the premise whatever the schema does later.
  db.exec("CREATE INDEX IF NOT EXISTS puzzles_by_motif ON puzzles (motif)");
  const steps = queryPlanSteps(db, sql);
  const plan = `plan:\n${steps.join("\n")}`;
  expect(steps[0], plan).toMatch(ATTEMPTS_SCAN);
  expect(
    steps.filter((step) => PUZZLES_STEP.test(step)),
    plan,
  ).toEqual([PUZZLES_BY_PRIMARY_KEY]);
  expect(sql.replace(/\s+/g, " "), "the join form").toMatch(ATTEMPTS_CROSS_JOINED);
}
