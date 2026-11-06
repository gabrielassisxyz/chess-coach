import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { type CoachEvent, mapSdkMessage } from "../../src/coach/events.js";
import { CoachSession, type QueryFn } from "../../src/coach/session.js";
import { findLatestOpenSession } from "../../src/db/chat.js";
import { openDatabase } from "../../src/db/open.js";
import { makeWorld } from "../fakes/fake-world.js";

// Opt-in: this spends a little of the owner's Claude Code subscription.
const enabled = process.env.CHESS_COACH_SDK === "1";
const TURN_TIMEOUT_MS = 180_000;
const CODEWORD = "PELICAN-7";

function makeContentDir(root: string): string {
  const dir = join(root, "content");
  mkdirSync(join(dir, "prompts"), { recursive: true });
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(
    join(dir, "prompts", "coach.md"),
    "You are a terse chess coach. Keep answers under 30 words.\n",
  );
  const words: Record<string, string> = {
    curriculum: "Curriculum: ZEBRA-CURRICULUM starts with piece safety.",
    "elo-milestones": "Milestones: 800 means no hanging pieces.",
    "chess-pedagogy": "Pedagogy: ask before telling.",
  };
  for (const [stem, text] of Object.entries(words)) {
    writeFileSync(join(dir, "references", `${stem}.md`), `${text}\n`);
  }
  return dir;
}

interface Harness {
  session: CoachSession;
  events: CoachEvent[];
  initTools: string[][];
  authSources: string[];
}

function tappedQuery(initTools: string[][], authSources: string[]): QueryFn {
  const recordTo = process.env.CHESS_COACH_RECORD;
  return (params) => {
    const stream = query(params);
    async function* tap() {
      for await (const message of stream) {
        if (recordTo) appendFileSync(recordTo, `${JSON.stringify(message)}\n`);
        const init = mapSdkMessage(message).init;
        if (init) {
          initTools.push(init.tools);
          authSources.push(init.apiKeySource);
        }
        yield message;
      }
    }
    return Object.assign(tap(), { close: () => stream.close() });
  };
}

function openHarness(root: string, contentDir: string): Harness {
  const dataDir = join(root, "data");
  const initTools: string[][] = [];
  const authSources: string[] = [];
  const db = openDatabase(dataDir);
  const session = new CoachSession({
    db,
    query: tappedQuery(initTools, authSources),
    contentDir,
    dataDir,
    world: makeWorld(db).world,
  });
  const events: CoachEvent[] = [];
  session.onEvent((event) => events.push(event));
  return { session, events, initTools, authSources };
}

async function ask(h: Harness, text: string): Promise<string> {
  const from = h.events.length;
  await h.session.send(text, "play");
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const turn = h.events.slice(from);
    if (turn.some((e) => e.kind === "turn_end" || e.kind === "turn_error")) {
      const error = turn.find((e) => e.kind === "turn_error");
      if (error) throw new Error(`turn failed: ${JSON.stringify(error)}`);
      return turn.flatMap((e) => (e.kind === "text_delta" ? [e.text] : [])).join("");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("turn did not finish in time");
}

describe.skipIf(!enabled)("real Agent SDK", () => {
  const root = mkdtempSync(join(tmpdir(), "chess-coach-probe-"));
  const contentDir = makeContentDir(root);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it(
    "streams a reply, resumes after a restart, and calls the chess tool",
    async () => {
      const first = openHarness(root, contentDir);
      await first.session.start();
      const reply = await ask(first, `Remember the codeword ${CODEWORD}. Reply with just OK.`);
      expect(reply.length).toBeGreaterThan(0);
      expect(first.events.some((e) => e.kind === "text_delta")).toBe(true);
      const sessionId = first.session.conversationRow("play")?.claudeSessionId;
      expect(sessionId).toBeTruthy();
      expect(first.authSources).toEqual(["none"]);
      const tools = first.initTools[0] ?? [];
      for (const builtin of ["Bash", "Read", "Write", "Edit"]) expect(tools).not.toContain(builtin);
      expect(tools).toContain("mcp__chess__read_reference");
      expect(tools.filter((name) => !name.startsWith("mcp__chess__"))).toEqual([]);
      await first.session.stop();

      const second = openHarness(root, contentDir);
      await second.session.start();
      expect(second.session.conversationRow("play")?.claudeSessionId).toBe(sessionId);
      const recall = await ask(
        second,
        "What codeword did I ask you to remember? Answer with the codeword only.",
      );
      expect(recall).toContain(CODEWORD);
      expect(second.session.conversationRow("play")?.claudeSessionId).toBe(sessionId);

      await ask(
        second,
        "Call the read_reference tool for the curriculum, then quote its first word after the colon.",
      );
      expect(
        second.events.some((e) => e.kind === "tool_use" && e.name === "mcp__chess__read_reference"),
      ).toBe(true);
      await second.session.stop();

      const db = openDatabase(join(root, "data"));
      expect(findLatestOpenSession(db)?.claudeSessionId).toBe(sessionId);
      db.close();
    },
    TURN_TIMEOUT_MS * 4,
  );
});
