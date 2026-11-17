import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "../../..");
const read = (...path: string[]): string => readFileSync(join(repositoryRoot, ...path), "utf8");
// A sentence in AGENTS.md wraps where the line ends, so the phrases are matched with the breaks gone.
const flat = (text: string): string => text.replace(/\s+/g, " ");

const agents = read("AGENTS.md");
const coach = read("content", "prompts", "coach.md");
const pedagogy = read("content", "references", "chess-pedagogy.md");

// What the prompt and the spec say about scheduling is what the coach tells the student and what the
// next session builds on, so a sentence that still describes the fixed ladder is a defect.
const OLD_SCHEDULER = /SM-?2|ladder|\b4 ?hr\b|\b4 hours\b|4-hour|After 4 hours/i;

describe("the documentation of how cards are scheduled", () => {
  const scheduling = flat(/- \*\*Card scheduling:\*\*[\s\S]*?(?=\n- \*\*)/.exec(agents)?.[0] ?? "");

  it("has an AGENTS.md entry that names the library, its pin and its one module", () => {
    expect(scheduling).toContain("FSRS-6");
    expect(scheduling).toContain("`ts-fsrs`");
    expect(scheduling).toContain("exactly 5.4.2");
    expect(scheduling).toContain("`packages/server/src/srs/fsrs.ts`");
  });

  it("gives the parameters and the intervals they produce", () => {
    for (const phrase of [
      "`request_retention` 0.9",
      "no fuzz",
      "due in 1 minute, Hard in 6, Good in 10 and Easy in 8 days",
      "10 minutes, then 2, 11, 46 and 163 days",
    ]) {
      expect(scheduling).toContain(phrase);
    }
  });

  it("describes the four grades, who chooses them and the keys", () => {
    for (const phrase of [
      "A grade is 1 Again, 2 Hard, 3 Good or 4 Easy",
      "four buttons, Again, Hard, Good and Easy",
      "the keys 1 to 4",
      "Enter on the suggested grade",
      "`rate_card` carries `grade` from 1 to 4",
      "refused as `invalid_command`",
    ]) {
      expect(scheduling).toContain(phrase);
    }
  });

  it("describes what the drills rate and the log they leave", () => {
    for (const phrase of [
      "Good for a pass and Again for a miss",
      "the game review",
      "`drill_reviews`",
      "keeps its schedule",
    ]) {
      expect(scheduling).toContain(phrase);
    }
  });

  it("says in the Practice runs entry that a card due within 20 minutes is served again", () => {
    const runs = flat(/- \*\*Practice runs:\*\*[\s\S]*?(?=\n- \*\*)/.exec(agents)?.[0] ?? "");

    expect(runs).toContain("no more than 20 minutes after");
    expect(runs).toContain("`LEARN_AHEAD_MS`");
    expect(runs).toContain("`queue_length`");
    expect(runs).toContain("nothing is queued and nothing is held");
    expect(runs).toContain("fresh exposure");
  });

  it("names the grades as the desk's suggestion and the drills' ratings, never a quality", () => {
    expect(agents).toContain("`suggested_grade`");
    expect(agents).not.toContain("suggested quality");
    expect(agents).not.toMatch(/quality 4|quality 2|rates it once, quality/);
  });

  it("tells the coach about FSRS, the four buttons and the return inside a session", () => {
    const flow = flat(
      coach.slice(coach.indexOf("## SRS Review Flow"), coach.indexOf("## Post-Game Flow")),
    );

    expect(flow).toContain("FSRS");
    for (const grade of ["Again", "Hard", "Good", "Easy"]) expect(flow).toContain(grade);
    expect(flow).toContain("inside the same training");
    expect(flow).toContain("within 20 minutes of its rating");
  });

  it("no longer names the old ladder in the spec, the coach prompt or the pedagogy it embeds", () => {
    expect(agents).not.toMatch(OLD_SCHEDULER);
    expect(coach).not.toMatch(OLD_SCHEDULER);
    expect(pedagogy).not.toMatch(OLD_SCHEDULER);
  });
});
