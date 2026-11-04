import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeWorld } from "../../test/fakes/fake-world.js";
import { openDatabase } from "../db/open.js";
import { contentDir } from "../paths.js";
import { buildCoachTools } from "./tools.js";

// Tools the prompt describes before the bead that registers them has landed. Each bead that
// registers one deletes its entry; the test below fails if an entry outlives its bead.
const REGISTERED_BY_A_LATER_BEAD = [
  "get_due_cards",
  "create_srs_cards",
  "add_srs_card",
  "explain_card",
];

const prompt = readFileSync(join(contentDir(), "prompts", "coach.md"), "utf8");

function registeredNames(): string[] {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "prompt-tools-")));
  const world = makeWorld(db).world;
  return buildCoachTools({ db, contentDir: contentDir(), world }).map((entry) => entry.name);
}

// A tool call in the prompt is `snake_name` in backticks or any `name(`; plain words never are.
function toolNamesIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/`([a-z]+(?:_[a-z]+)+)[`(]/g)) found.add(match[1] as string);
  for (const match of text.matchAll(/\b([a-z]+(?:_[a-z]+)*)\(/g)) found.add(match[1] as string);
  return found;
}

describe("coach prompt tool names", () => {
  const registered = registeredNames();
  const mentioned = toolNamesIn(prompt);

  it("mentions every tool the prompt knows about", () => {
    expect(mentioned.size).toBeGreaterThanOrEqual(10);
  });

  it("never names a tool that is neither registered nor awaiting a later bead", () => {
    const unknown = [...mentioned].filter(
      (name) => !registered.includes(name) && !REGISTERED_BY_A_LATER_BEAD.includes(name),
    );
    expect(unknown).toEqual([]);
  });

  it("documents every registered tool", () => {
    const missing = registered.filter((name) => !mentioned.has(name));
    expect(missing).toEqual([]);
  });

  it("keeps the exemption list honest: nothing registered is still exempt", () => {
    const stale = REGISTERED_BY_A_LATER_BEAD.filter((name) => registered.includes(name));
    expect(stale).toEqual([]);
  });

  it("extracts names from both spellings", () => {
    expect(toolNamesIn("use `get_game` then show_position(fen) and `curriculum`")).toEqual(
      new Set(["get_game", "show_position"]),
    );
  });
});
