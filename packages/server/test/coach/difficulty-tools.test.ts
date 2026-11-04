import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildCoachTools } from "../../src/coach/tools.js";
import { openDatabase } from "../../src/db/open.js";
import { getCurrentElo } from "../../src/db/settings.js";
import { contentDir } from "../../src/paths.js";
import { makeWorld } from "../fakes/fake-world.js";

function setup() {
  const db = openDatabase(mkdtempSync(join(tmpdir(), "difficulty-tools-")));
  const fake = makeWorld(db);
  const tools = buildCoachTools({ db, contentDir: contentDir(), world: fake.world });
  const find = (name: string) => {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`tool ${name} is not registered`);
    return found;
  };
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const def = find(name);
    const parsed = z.object(def.inputSchema).parse(input);
    const result = await def.handler(parsed as never, {});
    const text = (result.content[0] as { text: string }).text;
    return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
  };
  const accepts = (input: Record<string, unknown>) =>
    z.object(find("set_difficulty").inputSchema).safeParse(input).success;
  return { db, ...fake, call, accepts };
}

describe("set_difficulty", () => {
  it("sets the level and records a coach change with the reason", async () => {
    const { db, call } = setup();
    const out = await call("set_difficulty", {
      elo: 800,
      reason: "the student said it is too easy",
    });
    expect(out.isError).toBe(false);
    expect(out.body).toMatchObject({ from_elo: 600, to_elo: 800, reason: "coach" });
    expect(getCurrentElo(db)).toBe(800);
    expect(
      db.prepare("SELECT from_elo, to_elo, reason, note FROM difficulty_changes").all(),
    ).toEqual([
      { from_elo: 600, to_elo: 800, reason: "coach", note: "the student said it is too easy" },
    ]);
  });

  it("refuses 50 and 4000, and a missing reason, at the schema", () => {
    const { accepts } = setup();
    expect(accepts({ elo: 100, reason: "x" })).toBe(true);
    expect(accepts({ elo: 3190, reason: "x" })).toBe(true);
    expect(accepts({ elo: 50, reason: "x" })).toBe(false);
    expect(accepts({ elo: 4000, reason: "x" })).toBe(false);
    expect(accepts({ elo: 800 })).toBe(false);
  });

  it("logs nothing when the level would not move", async () => {
    const { db, call } = setup();
    const out = await call("set_difficulty", { elo: 600, reason: "same" });
    expect(out.body).toEqual({ unchanged: true, current_elo: 600 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM difficulty_changes").get()).toEqual({ n: 0 });
  });
});

describe("new_game and the setting", () => {
  it("starts at the setting when elo is omitted", async () => {
    const { db, call, game } = setup();
    await call("set_difficulty", { elo: 900, reason: "r" });
    await call("new_game", { color: "white" });
    expect(game.snapshot()).not.toBeNull();
    expect(db.prepare("SELECT target_elo FROM games").all()).toEqual([{ target_elo: 900 }]);
  });

  it("uses an explicit elo for that game and leaves the setting alone", async () => {
    const { db, call } = setup();
    await call("new_game", { color: "white", elo: 1500 });
    expect(db.prepare("SELECT target_elo FROM games").all()).toEqual([{ target_elo: 1500 }]);
    expect(getCurrentElo(db)).toBe(600);
  });
});

describe("get_progress", () => {
  it("reports the level and the last change", async () => {
    const { call } = setup();
    await call("set_difficulty", { elo: 700, reason: "r" });
    const out = await call("get_progress");
    expect(out.body).toMatchObject({
      difficulty: { current_elo: 700, last_change: { to_elo: 700, reason: "coach" } },
    });
  });
});
