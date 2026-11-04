import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentDir, dataDir, resolveAppRoot } from "./paths.js";

const originalCwd = process.cwd();
let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "cc-paths-")));
  delete process.env.CHESS_COACH_DATA_DIR;
  delete process.env.CHESS_COACH_CONTENT_DIR;
});
afterEach(() => {
  process.chdir(originalCwd);
  delete process.env.CHESS_COACH_DATA_DIR;
  delete process.env.CHESS_COACH_CONTENT_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveAppRoot", () => {
  it("finds the workspace root from packages/server", () => {
    process.chdir(join(originalCwd));
    const root = resolveAppRoot();
    expect(existsSync(join(root, "pnpm-workspace.yaml"))).toBe(true);
    expect(dataDir()).toBe(join(root, "data"));
    expect(contentDir()).toBe(join(root, "content"));
  });

  it("gives the same root from an unrelated directory", () => {
    const expected = resolveAppRoot();
    process.chdir(tmp);
    expect(resolveAppRoot()).toBe(expected);
  });
});

describe("overrides", () => {
  it("honours CHESS_COACH_DATA_DIR and CHESS_COACH_CONTENT_DIR from an unrelated directory", () => {
    process.chdir(tmp);
    process.env.CHESS_COACH_DATA_DIR = join(tmp, "d");
    process.env.CHESS_COACH_CONTENT_DIR = join(tmp, "c");
    expect(dataDir()).toBe(join(tmp, "d"));
    expect(contentDir()).toBe(join(tmp, "c"));
  });
});
