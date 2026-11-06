import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

  it("states up top that every reply is in Brazilian Portuguese", () => {
    const coach = readFileSync(join(contentDir(), "prompts", "coach.md"), "utf8");
    expect(coach).toContain("All replies to the student are in Brazilian Portuguese.");
  });

  it("lists exactly the stored motif values plus the two opening drills", () => {
    const stored = new Set<string>();
    for (const file of readdirSync(join(contentDir(), "puzzles"))) {
      if (!file.endsWith(".json")) continue;
      const puzzles = JSON.parse(readFileSync(join(contentDir(), "puzzles", file), "utf8")) as {
        motif?: unknown;
      }[];
      for (const puzzle of puzzles) if (typeof puzzle.motif === "string") stored.add(puzzle.motif);
    }
    stored.add("opening-white");
    stored.add("opening-black");
    const line = readFileSync(join(contentDir(), "prompts", "coach.md"), "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("Available puzzle motifs:"));
    expect(line).toBeDefined();
    const listed = new Set(
      (line ?? "")
        .replace("Available puzzle motifs:", "")
        .replace(/\.$/, "")
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token !== ""),
    );
    expect([...listed].sort()).toEqual([...stored].sort());
  });

  it("has a During Practice section with every end-of-item rule", () => {
    const coach = readFileSync(join(contentDir(), "prompts", "coach.md"), "utf8");
    expect(coach).toContain("## During Practice");
    const section = coach.slice(coach.indexOf("## During Practice"));
    expect(section).toContain("at most 120 words");
    expect(section).toContain("For each wrong try, one sentence on why it fails.");
    expect(section).toContain("Then why the right move is best.");
    expect(section).toContain("at most one habit line");
    expect(section).toContain("No routine, progress, due cards, plans");
    expect(section).toContain("No remarks about the session's state");
    expect(section).toContain("`show_position`/`make_move`");
    expect(section).toContain("`analyze`");
    expect(section).toContain("at most once per conversation");
  });

  it("runs Session Start only on a student-typed message, never on a notification", () => {
    const coach = readFileSync(join(contentDir(), "prompts", "coach.md"), "utf8");
    expect(coach).toContain("never for a server notification");
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
