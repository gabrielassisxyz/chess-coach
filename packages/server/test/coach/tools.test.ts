import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { REFERENCE_NAMES, readReference, referenceInput } from "../../src/coach/tools.js";
import { openDatabase } from "../../src/db/open.js";
import { contentDir } from "../../src/paths.js";
import { computeCoachProgress } from "../../src/progress/compute.js";

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
  it("returns the progress object without the game list and with games_played", () => {
    const progress = computeCoachProgress(freshDb(), {
      now: () => new Date("2026-06-01T00:00:00Z"),
    });
    expect(Object.keys(progress).sort()).toEqual(
      [
        "cards",
        "difficulty",
        "games_played",
        "puzzles_by_motif",
        "rating_history",
        "streak_days",
      ].sort(),
    );
    expect(progress.games_played).toBe(0);
    expect(progress.difficulty).toEqual({ current_elo: 600, last_change: null });
  });
});
