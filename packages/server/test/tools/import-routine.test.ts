import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importRoutine, stripEmDashes } from "../../../../tools/import-chess-rocket-cards.js";
import { buildApp } from "../../src/app.js";
import { buildRoutineTools } from "../../src/coach/routine-tools.js";
import { type Database, openDatabase } from "../../src/db/open.js";

const fixture = readFileSync(
  new URL("../fixtures/chess-rocket-routine.md", import.meta.url),
  "utf8",
);
const EM_DASH = String.fromCharCode(0x2014);
const withEmDash = fixture.replace("exists and", `exists ${EM_DASH}`);

describe("importRoutine", () => {
  let db: Database;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "import-routine-"));
    db = openDatabase(dir);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const rows = () => db.prepare("SELECT * FROM routines").all() as Record<string, string>[];

  it("stores the file once as an import for the week of 2026-10-27", () => {
    expect(importRoutine(db, withEmDash)).toEqual({ inserted: true });
    expect(importRoutine(db, withEmDash)).toEqual({ inserted: false });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ written_by: "import", week_start: "2026-10-27" });
  });

  it("replaces em-dashes before storing", () => {
    importRoutine(db, withEmDash);
    expect(withEmDash).toContain(EM_DASH);
    expect(rows()[0]?.body).not.toContain(EM_DASH);
    expect(stripEmDashes(`a ${EM_DASH} b`)).toBe("a, b");
  });

  it("serves the imported row through read_routine and GET /api/routine alike", async () => {
    importRoutine(db, withEmDash);
    const tool = buildRoutineTools({ db, now: () => new Date() }).find(
      (entry) => entry.name === "read_routine",
    );
    if (!tool) throw new Error("read_routine is not registered");
    const result = await tool.handler({} as never, {});
    const viaTool = JSON.parse((result.content[0] as { text: string }).text) as {
      routine: { body: string };
    };
    const app = buildApp({ db });
    const viaRoute = (await app.inject({ method: "GET", url: "/api/routine" })).json();
    await app.close();
    expect(viaTool.routine.body).toContain("Daily block");
    expect(viaTool.routine).toEqual(viaRoute);
  });
});
