import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { openDatabase } from "../db/open.js";
import { contentDir } from "../paths.js";
import { seedPuzzles } from "../puzzles/seed.js";

async function get(url: string) {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "puzzle-route-")));
  seedPuzzles(db, contentDir());
  const app = buildApp({ db });
  const response = await app.inject({ method: "GET", url });
  await app.close();
  return response;
}

describe("GET /api/puzzles", () => {
  it("returns ten fork puzzles with attempt counts and no solution", async () => {
    const response = await get("/api/puzzles?motif=fork&limit=10");
    expect(response.statusCode).toBe(200);
    const body = response.json() as { total: number; puzzles: Record<string, unknown>[] };
    expect(body.puzzles).toHaveLength(10);
    expect(body.total).toBeGreaterThanOrEqual(28);
    expect(Object.keys(body.puzzles[0] as object).sort()).toEqual(
      ["attempts", "difficulty", "explanation", "fen", "id", "motif", "solved"].sort(),
    );
  });

  it("answers an empty list for a motif with no puzzles", async () => {
    const response = await get("/api/puzzles?motif=nope");
    expect(response.json()).toEqual({ total: 0, puzzles: [] });
  });

  it("caps the limit at 50 and rejects a non-numeric one", async () => {
    const big = await get("/api/puzzles?limit=500");
    expect((big.json() as { puzzles: unknown[] }).puzzles).toHaveLength(50);
    expect((await get("/api/puzzles?limit=abc")).statusCode).toBe(400);
  });
});
