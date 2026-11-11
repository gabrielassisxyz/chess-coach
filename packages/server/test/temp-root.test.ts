import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, inject, it } from "vitest";
import {
  BUILD_DISK,
  BUILD_DISK_TEMP,
  chooseTempBase,
  createTempRoot,
  requireTempRoot,
  setupTempRoot,
  sweepTempRoots,
  TEMP_ROOT_PREFIX,
} from "./support/temp-root.js";

const ROOT_NAME = /^chess-coach-tests-(\d+)-[A-Za-z0-9]{6}$/;

function scratchBase(): string {
  return mkdtempSync(join(tmpdir(), "temp-root-base-"));
}

function plantRoot(base: string, pid: number): string {
  const root = mkdtempSync(join(base, `${TEMP_ROOT_PREFIX}${pid}-`));
  writeFileSync(join(root, "chess-coach.db"), "left by a run");
  return root;
}

describe("the base of a run's temporary root", () => {
  const systemTemp = () => "/system-temp";

  it("is TMPDIR when the caller set it", () => {
    const base = chooseTempBase({
      env: { TMPDIR: "/lane/scratch" },
      exists: () => true,
      systemTemp,
    });
    expect(base).toBe("/lane/scratch");
  });

  it("is the build disk's directory when TMPDIR is unset or empty and the disk exists", () => {
    const exists = (path: string) => path === BUILD_DISK;
    expect(chooseTempBase({ env: {}, exists, systemTemp })).toBe(BUILD_DISK_TEMP);
    expect(chooseTempBase({ env: { TMPDIR: " " }, exists, systemTemp })).toBe(BUILD_DISK_TEMP);
  });

  it("is the system temporary directory where there is no build disk, as on a CI runner", () => {
    expect(chooseTempBase({ env: {}, exists: () => false, systemTemp })).toBe("/system-temp");
  });
});

describe("a run's root", () => {
  it("is named after the run's process, directly under the base, which it creates", () => {
    const base = join(scratchBase(), "not-yet");
    const root = createTempRoot(base, 4242);
    expect(dirname(root)).toBe(base);
    expect(basename(root)).toMatch(ROOT_NAME);
    expect(ROOT_NAME.exec(basename(root))?.[1]).toBe("4242");
    expect(existsSync(root)).toBe(true);
  });
});

describe("the sweep of roots left by killed runs", () => {
  it("removes a root whose process is gone and keeps live roots and everything else", () => {
    const base = scratchBase();
    const dead = plantRoot(base, 111);
    const live = plantRoot(base, 222);
    mkdirSync(join(base, "unrelated-dir"));
    writeFileSync(join(base, `${TEMP_ROOT_PREFIX}notes`), "not a root");

    const removed = sweepTempRoots(base, (pid) => pid === 222);

    expect(removed).toEqual([basename(dead)]);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(readdirSync(base).sort()).toEqual(
      [basename(live), `${TEMP_ROOT_PREFIX}notes`, "unrelated-dir"].sort(),
    );
  });

  it("does nothing when the base does not exist yet", () => {
    expect(sweepTempRoots(join(scratchBase(), "missing"), () => false)).toEqual([]);
  });
});

describe("the global setup", () => {
  it("sweeps dead roots, provides a fresh root, and removes it with its contents at teardown", () => {
    const base = scratchBase();
    const dead = plantRoot(base, 111);
    const provided: [string, string][] = [];
    const project = { provide: (key: "tempRoot", value: string) => provided.push([key, value]) };

    const teardown = setupTempRoot(project, { base, pid: 333, isRunning: (pid) => pid === 333 });

    expect(existsSync(dead)).toBe(false);
    expect(provided).toHaveLength(1);
    const [key, root] = provided[0] ?? ["", ""];
    expect(key).toBe("tempRoot");
    expect(dirname(root)).toBe(base);
    expect(ROOT_NAME.exec(basename(root))?.[1]).toBe("333");
    writeFileSync(join(mkdtempSync(join(root, "a-test-")), "chess-coach.db"), "scratch");

    teardown();

    expect(existsSync(root)).toBe(false);
    expect(readdirSync(base)).toEqual([]);
  });
});

describe("inside a test", () => {
  it("os.tmpdir() is the run's root, so every scratch directory lands in it", () => {
    const root = inject("tempRoot");
    expect(tmpdir()).toBe(root);
    expect(basename(root)).toMatch(ROOT_NAME);
  });

  it("refuses to run without a provided root rather than write into a stray directory", () => {
    expect(() => requireTempRoot(undefined)).toThrow(/globalSetup/);
    expect(() => requireTempRoot("")).toThrow(/globalSetup/);
    expect(requireTempRoot("/some/root")).toBe("/some/root");
  });
});

describe("the test sources", () => {
  // Split so this file does not match its own search.
  const SYSTEM_TEMP_LITERAL = ["", "tmp"].join("/");
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

  function testSources(pkg: string): string[] {
    const files: string[] = [];
    for (const dir of ["src", "test"]) {
      const top = join(repoRoot, "packages", pkg, dir);
      if (!existsSync(top)) continue;
      for (const entry of readdirSync(top, { recursive: true, encoding: "utf8" })) {
        const isTestCode = dir === "test" || /\.test\.tsx?$/.test(entry);
        if (isTestCode && /\.tsx?$/.test(entry)) files.push(join("packages", pkg, dir, entry));
      }
    }
    return files;
  }

  it("never hard-code the system temporary directory, which would bypass the run's root", () => {
    const files = [...testSources("server"), ...testSources("web")];
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((file) =>
      readFileSync(join(repoRoot, file), "utf8").includes(SYSTEM_TEMP_LITERAL),
    );
    expect(offenders).toEqual([]);
  });
});
