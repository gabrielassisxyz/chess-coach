import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { mapSdkMessage, type SessionInit } from "../../src/coach/events.js";
import { openDatabase } from "../../src/db/open.js";
import { createRepertoireVariation, insertRepertoireOwnMove } from "../../src/db/repertoires.js";
import { RecordingLog } from "../../src/log.js";
import {
  generateRepertoireIdeas,
  type IdeaQueryFn,
  ideaRejection,
  sdkIdeaSession,
} from "../../src/openings/repertoire-ideas.js";

// Opt-in: this spends a little of the owner's Claude Code subscription.
const enabled = process.env.CHESS_COACH_SDK === "1";
const CALL_TIMEOUT_MS = 180_000;

function tappedQuery(inits: SessionInit[]): IdeaQueryFn {
  return (params) => {
    const stream = query(params);
    async function* tap() {
      for await (const message of stream) {
        const init = mapSdkMessage(message).init;
        if (init) inits.push(init);
        yield message;
      }
    }
    return Object.assign(tap(), { close: () => stream.close() });
  };
}

describe.skipIf(!enabled)("real Agent SDK, repertoire ideas", () => {
  const root = mkdtempSync(join(tmpdir(), "chess-coach-ideas-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it(
    "writes one idea for one move, with no tool and no API key",
    async () => {
      const db = openDatabase(join(root, "data"));
      const repertoireId = createRepertoireVariation(db, {
        side: "white",
        groupName: "Italian Game",
        variationName: "Classical Variation (4.c3)",
      }).id;
      insertRepertoireOwnMove(db, {
        repertoireId,
        positionKey: "probe-3.Bc4",
        ply: 5,
        line: ["e4", "e5", "Nf3", "Nc6"],
        reach: 1,
        openingName: null,
        uci: "f1c4",
        san: "Bc4",
        share: null,
        source: "engine",
        cpLoss: 0,
        evalCp: 28,
        results: null,
      });
      const inits: SessionInit[] = [];
      const log = new RecordingLog();
      const session = sdkIdeaSession(tappedQuery(inits), { cwd: root });

      const result = await generateRepertoireIdeas(db, session, log);

      expect(result, JSON.stringify(log.events)).toMatchObject({ considered: 1, generated: 1 });
      const stored = db
        .prepare("SELECT idea FROM repertoire_positions WHERE move_san = 'Bc4'")
        .get() as { idea: string | null };
      expect(stored.idea).toBeTruthy();
      expect(ideaRejection(stored.idea ?? "", { san: "Bc4", uci: "f1c4" })).toBeNull();
      expect(inits.length).toBeGreaterThan(0);
      for (const init of inits) {
        expect(init.apiKeySource).toBe("none");
        expect(init.tools).toEqual([]);
      }
      db.close();
    },
    CALL_TIMEOUT_MS * 2,
  );
});
