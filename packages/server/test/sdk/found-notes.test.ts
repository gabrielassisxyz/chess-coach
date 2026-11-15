import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, describe, expect, it } from "vitest";
import { mapSdkMessage, type SessionInit } from "../../src/coach/events.js";
import { getFoundNote, insertFoundPosition } from "../../src/db/found-positions.js";
import { setGrading } from "../../src/db/games.js";
import { openDatabase } from "../../src/db/open.js";
import { importFinishedGame } from "../../src/import/pgn.js";
import { RecordingLog } from "../../src/log.js";
import {
  FOUND_NOTE_SYSTEM_PROMPT,
  foundNoteRejection,
  generateFoundNotes,
} from "../../src/openings/found-notes.js";
import { type IdeaQueryFn, sdkIdeaSession } from "../../src/openings/repertoire-ideas.js";

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

describe.skipIf(!enabled)("real Agent SDK, found notes", () => {
  const root = mkdtempSync(join(tmpdir(), "chess-coach-ideas-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it(
    "writes one note for one position from a game, with no tool and no API key",
    async () => {
      const db = openDatabase(join(root, "data"));
      const gameId = importFinishedGame(db, {
        pgn: '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0',
        playerColor: "white",
        source: "pgn",
        sourceId: "probe",
        opponent: "probe",
        playedAt: "2026-11-01T12:00:00.000Z",
      });
      if (gameId === null) throw new Error("the probe game was not imported");
      setGrading(db, gameId, "done");
      db.prepare(
        "UPDATE moves SET eval_before_cp = 35, classification = 'mistake' WHERE game_id = ? AND ply = 5",
      ).run(gameId);
      const fen = (
        db.prepare("SELECT fen_before FROM moves WHERE game_id = ? AND ply = 5").get(gameId) as {
          fen_before: string;
        }
      ).fen_before;
      insertFoundPosition(db, {
        id: "own:probe",
        fen,
        color: "white",
        phase: "opening",
        fromMistake: true,
        fromRepeat: false,
        fromDeparture: false,
        listed: true,
        acceptedUci: ["f1c4", "d2d4"],
        reachedGames: 1,
        bestGames: 0,
        lastReachedAt: "2026-11-01T12:00:00.000Z",
        gameId,
        ply: 5,
        firstFoundAt: "2026-11-02T12:00:00.000Z",
      });
      const inits: SessionInit[] = [];
      const log = new RecordingLog();
      const session = sdkIdeaSession(tappedQuery(inits), {
        cwd: root,
        systemPrompt: FOUND_NOTE_SYSTEM_PROMPT,
      });

      const result = await generateFoundNotes(db, session, log);

      expect(result, JSON.stringify(log.events)).toMatchObject({ considered: 1, generated: 1 });
      const stored = getFoundNote(db, "own:probe");
      expect(stored).toBeTruthy();
      const accepted = [
        { san: "Bc4", uci: "f1c4" },
        { san: "d4", uci: "d2d4" },
      ];
      expect(foundNoteRejection(stored ?? "", accepted)).toBeNull();
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
