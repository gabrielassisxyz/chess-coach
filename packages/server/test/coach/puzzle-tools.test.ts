import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildPuzzleTools } from "../../src/coach/puzzle-tools.js";
import { openDatabase } from "../../src/db/open.js";
import { contentDir } from "../../src/paths.js";
import { seedPuzzles } from "../../src/puzzles/seed.js";

function setup() {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "puzzle-tools-")));
  seedPuzzles(db, contentDir());
  const [def] = buildPuzzleTools(db);
  if (!def) throw new Error("get_puzzles is not registered");
  const schema = z.object(def.inputSchema);
  const call = async (input: Record<string, unknown>) => {
    const result = await def.handler(schema.parse(input) as never, {});
    return JSON.parse((result.content[0] as { text: string }).text) as {
      total: number;
      puzzles: Record<string, unknown>[];
    };
  };
  return { def, schema, call };
}

describe("get_puzzles", () => {
  it("is named get_puzzles", () => {
    expect(setup().def.name).toBe("get_puzzles");
  });

  it("returns only id, motif, difficulty, fen and explanation", async () => {
    const { puzzles } = await setup().call({ motif: "fork", limit: 5 });
    expect(puzzles).toHaveLength(5);
    for (const puzzle of puzzles) {
      expect(Object.keys(puzzle).sort()).toEqual([
        "difficulty",
        "explanation",
        "fen",
        "id",
        "motif",
      ]);
    }
  });

  it("never leaks a solution into the serialized answer", async () => {
    const { call } = setup();
    const text = JSON.stringify(await call({ limit: 20 }));
    expect(text).not.toMatch(/solution/);
  });

  it("limits to 20 at the schema and defaults to 10", async () => {
    const { schema, call } = setup();
    expect(schema.safeParse({ limit: 21 }).success).toBe(false);
    expect((await call({})).puzzles).toHaveLength(10);
  });
});
