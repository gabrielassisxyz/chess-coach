import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCoachPrompt } from "../../src/coach/prompt.js";
import { contentDir } from "../../src/paths.js";

function copyContent(): string {
  const dir = mkdtempSync(join(tmpdir(), "coach-prompt-"));
  cpSync(join(contentDir(), "prompts"), join(dir, "prompts"), { recursive: true });
  cpSync(join(contentDir(), "references"), join(dir, "references"), { recursive: true });
  return dir;
}

describe("buildCoachPrompt", () => {
  it("is stable across two builds of the same bundle", () => {
    const dir = copyContent();
    expect(buildCoachPrompt(dir).version).toBe(buildCoachPrompt(dir).version);
    expect(buildCoachPrompt(dir).version).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when one byte of a bundled file changes", () => {
    const dir = copyContent();
    const before = buildCoachPrompt(dir).version;
    const file = join(dir, "references", "curriculum.md");
    writeFileSync(file, `${readFileSync(file, "utf8")}x`);
    expect(buildCoachPrompt(dir).version).not.toBe(before);
  });

  it("puts the coach prompt first, then the three references", () => {
    const { append } = buildCoachPrompt(copyContent());
    const coach = readFileSync(join(contentDir(), "prompts", "coach.md"), "utf8");
    expect(append.startsWith(coach)).toBe(true);
    const order = ["curriculum", "elo-milestones", "chess-pedagogy"].map((stem) =>
      append.indexOf(readFileSync(join(contentDir(), "references", `${stem}.md`), "utf8")),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(0);
  });
});
