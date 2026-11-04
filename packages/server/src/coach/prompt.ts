import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface CoachPrompt {
  append: string;
  version: string;
}

const PROMPT_FILE = join("prompts", "coach.md");
const REFERENCE_STEMS = ["curriculum", "elo-milestones", "chess-pedagogy"] as const;

// The version is the hash of the exact bytes handed to the model, so any edit to the bundle
// retires stored sessions that were started under the old text.
export function buildCoachPrompt(contentDir: string): CoachPrompt {
  const files = [PROMPT_FILE, ...REFERENCE_STEMS.map((stem) => join("references", `${stem}.md`))];
  const append = files.map((file) => readFileSync(join(contentDir, file), "utf8")).join("\n\n");
  return { append, version: createHash("sha256").update(append).digest("hex") };
}
