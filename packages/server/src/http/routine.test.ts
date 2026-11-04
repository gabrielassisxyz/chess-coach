import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { openDatabase } from "../db/open.js";
import { insertRoutine } from "../db/routines.js";

function setup(rows: number) {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "routine-route-")));
  for (let i = 1; i <= rows; i += 1) {
    insertRoutine(db, {
      weekStart: "2026-10-26",
      body: `body ${i}`,
      writtenBy: "coach",
      createdAt: `2026-11-0${i}T10:00:00.000Z`,
    });
  }
  const app = buildApp({ db });
  return { app, get: (url: string) => app.inject({ method: "GET", url }) };
}

describe("GET /api/routine", () => {
  it("answers 404 when none was written", async () => {
    const { app, get } = setup(0);
    expect((await get("/api/routine")).statusCode).toBe(404);
    await app.close();
  });

  it("returns the newest row", async () => {
    const { app, get } = setup(3);
    const response = await get("/api/routine");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: 3,
      week_start: "2026-10-26",
      body: "body 3",
      written_by: "coach",
      created_at: "2026-11-03T10:00:00.000Z",
    });
    await app.close();
  });
});

describe("GET /api/routine/history", () => {
  it("lists the five newest first", async () => {
    const { app, get } = setup(7);
    const body = (await get("/api/routine/history?limit=5")).json() as {
      routines: { id: number }[];
    };
    expect(body.routines.map((row) => row.id)).toEqual([7, 6, 5, 4, 3]);
    await app.close();
  });

  it("rejects a non-numeric limit", async () => {
    const { app, get } = setup(1);
    expect((await get("/api/routine/history?limit=abc")).statusCode).toBe(400);
    await app.close();
  });
});
