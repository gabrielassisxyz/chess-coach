import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  getProgress,
  REFERENCE_NAMES,
  readReference,
  referenceInput,
} from "../../src/coach/tools.js";
import { openDatabase } from "../../src/db/open.js";
import { contentDir } from "../../src/paths.js";

const schema = z.object(referenceInput);

function freshDb() {
  return openDatabase(mkdtempSync(join(tmpdir(), "coach-tools-")));
}

describe("read_reference", () => {
  it("returns the file text for a known name", () => {
    const expected = readFileSync(join(contentDir(), "references", "curriculum.md"), "utf8");
    expect(readReference(contentDir(), "curriculum")).toBe(expected.slice(0, 60_000));
  });

  it("rejects a path-shaped name at the schema", () => {
    expect(schema.safeParse({ name: "../x" }).success).toBe(false);
    expect(schema.safeParse({ name: "curriculum.md" }).success).toBe(false);
    expect(schema.safeParse({ name: "curriculum" }).success).toBe(true);
  });

  it("offers exactly the seven reference stems", () => {
    expect([...REFERENCE_NAMES]).toHaveLength(7);
    for (const name of REFERENCE_NAMES)
      expect(readReference(contentDir(), name).length).toBeGreaterThan(0);
  });

  it("caps the text at 60000 characters", () => {
    const dir = mkdtempSync(join(tmpdir(), "coach-ref-"));
    mkdirSync(join(dir, "references"));
    writeFileSync(join(dir, "references", "curriculum.md"), "a".repeat(70_000));
    expect(readReference(dir, "curriculum")).toHaveLength(60_000);
  });
});

describe("get_progress", () => {
  it("is all zeros while the later tables do not exist", () => {
    expect(getProgress(freshDb())).toEqual({
      current_elo: 0,
      games_played: 0,
      cards_total: 0,
      cards_due: 0,
    });
  });

  it("reads what exists", () => {
    const db = freshDb();
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings VALUES ('current_elo', '950');
      CREATE TABLE srs_cards (id INTEGER PRIMARY KEY, next_review_at TEXT NOT NULL);
      INSERT INTO srs_cards (next_review_at) VALUES ('2026-01-01T00:00:00Z'), ('2999-01-01T00:00:00Z');`);
    expect(getProgress(db, new Date("2026-06-01T00:00:00Z"))).toEqual({
      current_elo: 950,
      games_played: 0,
      cards_total: 2,
      cards_due: 1,
    });
  });
});
