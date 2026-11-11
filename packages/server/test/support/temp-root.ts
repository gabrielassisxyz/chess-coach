import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

// The vitest globalSetup of the server package: one temporary root per run, under which every
// test's scratch directory lands, removed when the run ends. A run killed before its teardown
// leaves one root behind instead of the hundreds of directories its tests made, and the next
// run removes it.

// The owner's machine keeps scratch files on its build disk rather than on the tmpfs; a CI
// runner has no such disk and keeps its default, the same rule `bin/ci` applies to Node's
// compile cache.
export const BUILD_DISK = "/mnt/build";
export const BUILD_DISK_TEMP = join(BUILD_DISK, "chess-coach-tmp");
export const TEMP_ROOT_PREFIX = "chess-coach-tests-";

const ROOT_NAME = /^chess-coach-tests-(\d+)-[A-Za-z0-9]{6}$/;

declare module "vitest" {
  export interface ProvidedContext {
    tempRoot: string;
  }
}

export interface TempBaseInputs {
  env: { TMPDIR?: string };
  exists: (path: string) => boolean;
  systemTemp: () => string;
}

/** A TMPDIR the caller set wins, so a lane that exports its own per-worktree one keeps it. */
export function chooseTempBase({ env, exists, systemTemp }: TempBaseInputs): string {
  const fromCaller = env.TMPDIR?.trim();
  if (fromCaller) return fromCaller;
  if (exists(BUILD_DISK)) return BUILD_DISK_TEMP;
  return systemTemp();
}

export function createTempRoot(base: string, pid: number): string {
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${TEMP_ROOT_PREFIX}${pid}-`));
}

/**
 * Removes the roots of runs whose process is gone. A live root belongs to a run going on in
 * another worktree, so it stays; a reused pid only delays a removal.
 */
export function sweepTempRoots(base: string, isRunning: (pid: number) => boolean): string[] {
  if (!existsSync(base)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(base)) {
    const pid = ROOT_NAME.exec(name)?.[1];
    if (pid === undefined || isRunning(Number(pid))) continue;
    rmSync(join(base, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface TempRootRun {
  base: string;
  pid: number;
  isRunning: (pid: number) => boolean;
}

export function setupTempRoot(
  project: Pick<TestProject, "provide">,
  { base, pid, isRunning }: TempRootRun,
): () => void {
  sweepTempRoots(base, isRunning);
  const root = createTempRoot(base, pid);
  project.provide("tempRoot", root);
  return () => rmSync(root, { recursive: true, force: true });
}

/** Without a root, TMPDIR would become the string "undefined", a directory in the package. */
export function requireTempRoot(root: string | undefined): string {
  if (!root) {
    throw new Error(
      "No temporary root was provided: test/support/temp-root.ts must run as the vitest " +
        "globalSetup of this package (see vitest.config.ts).",
    );
  }
  return root;
}

export default function setup(project: TestProject): () => void {
  const base = chooseTempBase({ env: process.env, exists: existsSync, systemTemp: tmpdir });
  return setupTempRoot(project, { base, pid: process.pid, isRunning: processIsRunning });
}
