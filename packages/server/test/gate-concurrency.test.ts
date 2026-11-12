import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "vitest/node";

// A test of about 100 ms that waits on a busy machine is held to the same 5 s as one that hangs,
// so beside other load the gate failed for a reason that was not in the code. The gate keeps its
// test workers to a share of the machine, and these hold that share in place.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// One worker per physical core on an SMT machine: half the hardware threads, rounded up.
const WORKER_CEILING = Math.ceil(availableParallelism() / 2);

// Resolved the way vitest resolves it, so a cap written in a form it does not read as a share
// (a bare "50" is fifty workers) fails here instead of passing as text. The result is typed as
// Vite's resolved config, which has no `test`, though vitest's own options are on it.
async function resolvedWorkers(packageName: string): Promise<number> {
  const config = await resolveConfig({
    root: join(REPO_ROOT, "packages", packageName),
    watch: false,
  });
  return (config as unknown as { test: { maxWorkers: number } }).test.maxWorkers;
}

describe("the gate's test workers", () => {
  it.each(["server", "web"])(
    "stay within half the hardware threads in the %s suite",
    async (name) => {
      expect(await resolvedWorkers(name)).toBeLessThanOrEqual(WORKER_CEILING);
    },
  );

  it("belong to one package at a time", () => {
    const gate = readFileSync(join(REPO_ROOT, "bin", "ci"), "utf8");
    const testStep = gate.split("\n").find((line) => line.includes('"==> test"'));
    expect(testStep).toMatch(/\bpnpm -r\b.*--workspace-concurrency=1\b.*\brun test\b/);
  });
});
