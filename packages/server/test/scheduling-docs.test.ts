import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPERTOIRE_MISSED_MIN_MISSES,
  REPERTOIRE_MISSED_SIZE,
  REPERTOIRE_MISSED_WINDOW_DAYS,
} from "../src/activity/repertoire-session.js";

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

  it("says in the Repertoire drill entry that a move with no card is due as soon as it is stored, and names no pacing", () => {
    const drill = flat(/- \*\*Repertoire drill:\*\*[\s\S]*?(?=\n- \*\*)/.exec(agents)?.[0] ?? "");

    expect(drill).toContain("A move with no card is new and due as soon as it is stored");
    expect(drill).toContain("the scopes select from every move of the level");
    expect(drill).not.toContain("REPERTOIRE_SIBLING_STABLE_HOURS");
    expect(drill).not.toMatch(/sibling|held back/i);
  });

  it("says in the Repertoire drill entry what the missed scope serves, in which order and how many, with the numbers of its constants", () => {
    const drill = flat(/- \*\*Repertoire drill:\*\*[\s\S]*?(?=\n- \*\*)/.exec(agents)?.[0] ?? "");

    expect(drill).toContain("`missed` the moves the student missed most");
    expect(drill).toContain(
      `its card has ${REPERTOIRE_MISSED_MIN_MISSES} or more rows in \`drill_reviews\``,
    );
    expect(drill).toContain("`card_kind = 'repertoire'`, `grade = 1`");
    expect(drill).toContain(`within the ${REPERTOIRE_MISSED_WINDOW_DAYS} days before the start`);
    expect(drill).toContain("ordered by that count descending and then by line order");
    expect(drill).toContain(`at most ${REPERTOIRE_MISSED_SIZE} (`);
    for (const name of [
      "REPERTOIRE_MISSED_MIN_MISSES",
      "REPERTOIRE_MISSED_WINDOW_DAYS",
      "REPERTOIRE_MISSED_SIZE",
    ]) {
      expect(drill).toContain(`\`${name}\``);
    }
    expect(drill).toContain("a right first attempt on a card not yet due keeps its schedule");
    expect(drill).toContain("refused with `empty_queue` before any run is written or replaced");
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
