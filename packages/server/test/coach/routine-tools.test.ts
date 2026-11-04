import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildRoutineTools, writeRoutineInput } from "../../src/coach/routine-tools.js";
import { openDatabase } from "../../src/db/open.js";

const body = (tag: string): string => `## Daily block\n${tag} `.padEnd(300, "x");

function setup() {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "routine-tools-")));
  const tools = buildRoutineTools({ db, now: () => new Date("2026-11-02T10:00:00Z") });
  const find = (name: string) => {
    const def = tools.find((entry) => entry.name === name);
    if (!def) throw new Error(`${name} is not registered`);
    return def;
  };
  const read = async () => {
    const result = await find("read_routine").handler({} as never, {});
    return JSON.parse((result.content[0] as { text: string }).text) as { routine: unknown };
  };
  const write = async (input: Record<string, unknown>) => {
    const parsed = z.object(find("write_routine").inputSchema).parse(input);
    const result = await find("write_routine").handler(parsed as never, {});
    return JSON.parse((result.content[0] as { text: string }).text) as { id: number };
  };
  return { db, read, write };
}

describe("read_routine and write_routine", () => {
  it("answers null before any write", async () => {
    expect(await setup().read()).toEqual({ routine: null });
  });

  it("stores each write as a new row written by the coach and reads the newest", async () => {
    const { db, read, write } = setup();
    const first = await write({ body: body("one"), week_start: "2026-10-26" });
    const second = await write({ body: body("two"), week_start: "2026-11-02" });
    expect(second.id).toBeGreaterThan(first.id);
    expect(db.prepare("SELECT count(*) AS n FROM routines").get()).toEqual({ n: 2 });
    expect(await read()).toEqual({
      routine: {
        id: second.id,
        week_start: "2026-11-02",
        body: body("two"),
        written_by: "coach",
        created_at: "2026-11-02T10:00:00.000Z",
      },
    });
  });
});

describe("write_routine schema", () => {
  const schema = z.object(writeRoutineInput);
  const ok = { body: "a".repeat(200), week_start: "2026-11-02" };

  it("accepts the bounds and refuses just outside them", () => {
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ ...ok, body: "a".repeat(8000) }).success).toBe(true);
    expect(schema.safeParse({ ...ok, body: "a".repeat(199) }).success).toBe(false);
    expect(schema.safeParse({ ...ok, body: "a".repeat(8001) }).success).toBe(false);
  });

  it("refuses a week_start that is not a Monday ISO date", () => {
    for (const bad of [
      "2026-11-03",
      "2026-11-01",
      "2026-02-30",
      "11/02/2026",
      "2026-11-02T00:00:00Z",
    ]) {
      expect(schema.safeParse({ ...ok, week_start: bad }).success, bad).toBe(false);
    }
  });
});
