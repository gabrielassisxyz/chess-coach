import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// main.ts boots the real engines and the real Claude session as it loads, so no test can import it;
// the two calls it wires are guarded here by reading its text. A cap on either would change the
// grades of imported games or the coach's reading of a move.
describe("the grading calls wired in main.ts", () => {
  it("call evaluatePlayerMove with four arguments, so no time cap reaches the searches", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const calls = [...source.matchAll(/evaluatePlayerMove\(([^()]*)\)/g)].map((match) => match[1]);

    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args?.split(",").filter((part) => part.trim() !== "")).toHaveLength(4);
    }
  });
});

// The cache answers the analysis lane only. Grading, the drill generators and the review all take a
// searcher or an evaluator from the entry point, so a module that imported the reader would be one
// that could look a position up where it must search.
describe("the evaluation cache reader", () => {
  it("is imported by the engine pool and the entry point only", () => {
    const sourceDir = new URL("../src/", import.meta.url);
    const importers = readdirSync(sourceDir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) =>
        /from "(\.{1,2}\/)+(.*\/)?eval-cache\.js"/.test(
          readFileSync(new URL(file, sourceDir), "utf8"),
        ),
      )
      .sort();

    expect(importers).toEqual(["engine/pool.ts", "main.ts"]);
  });
});
