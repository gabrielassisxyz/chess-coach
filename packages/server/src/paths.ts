import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_MARKER = "pnpm-workspace.yaml";

// Anchored on this file, not process.cwd(): pnpm runs scripts from the package directory.
export function resolveAppRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, ROOT_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no ${ROOT_MARKER} found above ${import.meta.url}`);
    dir = parent;
  }
}

export function dataDir(): string {
  const override = process.env.CHESS_COACH_DATA_DIR;
  return override ? resolve(override) : join(resolveAppRoot(), "data");
}

export function contentDir(): string {
  const override = process.env.CHESS_COACH_CONTENT_DIR;
  return override ? resolve(override) : join(resolveAppRoot(), "content");
}
