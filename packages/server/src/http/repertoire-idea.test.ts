import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActivityState,
  REPERTOIRE_IDEA_MAX_LENGTH,
  RepertoireImportRefusalSchema,
  SaveRepertoireIdeaResponseSchema,
  type TrainingActivity,
} from "@chess-coach/shared";
import { Chess } from "chess.js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedEngine } from "../../test/fakes/scripted-engine.js";
import { ActivityService } from "../activity/service.js";
import { buildApp } from "../app.js";
import { type Database, openDatabase } from "../db/open.js";
import {
  createRepertoireVariation,
  insertRepertoireOwnMove,
  REPERTOIRE_REBUILD_GROUP_SUFFIX,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { GameService } from "../game/service.js";
import { RecordingLog } from "../log.js";
import { positionKey } from "../openings/from-games.js";
import { ReviewDesk } from "../srs/review.js";
import { DEFAULT_ALLOWED_ORIGINS } from "../ws/origin.js";

const ALLOWED = { origin: "http://localhost:5173", host: "localhost:5173" };

const BAD_HEADERS: Array<[string, Record<string, string>]> = [
  ["a rebinding page", { origin: "http://evil.example:3210", host: "evil.example:3210" }],
  ["a foreign origin", { origin: "http://evil.example", host: "localhost:5173" }],
  ["a foreign host", { origin: "http://localhost:5173", host: "evil.example:3210" }],
  ["no origin", { host: "localhost:5173" }],
];

let tmp: string;
let db: Database;
let log: RecordingLog;
let app: FastifyInstance;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-repertoire-idea-route-"));
  db = openDatabase(tmp);
  log = new RecordingLog();
  app = buildApp({ db, log, allowedOrigins: DEFAULT_ALLOWED_ORIGINS });
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function placeOf(line: readonly string[], san: string) {
  const board = new Chess();
  for (const move of line) board.move(move);
  const key = positionKey(board.fen());
  const played = board.move(san);
  return {
    positionKey: key,
    ply: line.length + 1,
    uci: `${played.from}${played.to}${played.promotion ?? ""}`,
    san: played.san,
  };
}

function addOwnMove(
  repertoireId: number,
  line: readonly string[],
  san: string,
  reach = 1,
  idea: string | null = null,
): number {
  const place = placeOf(line, san);
  insertRepertoireOwnMove(db, {
    repertoireId,
    positionKey: place.positionKey,
    ply: place.ply,
    line: [...line],
    uci: place.uci,
    san: place.san,
    share: null,
    reach,
    openingName: null,
    source: "explorer",
    cpLoss: 0,
    evalCp: 20,
    results: null,
  });
  const row = db
    .prepare(
      "SELECT id FROM repertoire_positions WHERE repertoire_id = ? AND position_key = ? AND kind = 'own'",
    )
    .get(repertoireId, place.positionKey) as { id: number };
  if (idea !== null) {
    db.prepare("UPDATE repertoire_positions SET idea = ? WHERE id = ?").run(idea, row.id);
  }
  return row.id;
}

function addReplyMove(repertoireId: number, line: readonly string[], san: string): number {
  const place = placeOf(line, san);
  upsertRepertoireReply(db, {
    repertoireId,
    positionKey: place.positionKey,
    ply: place.ply,
    line: [...line],
    uci: place.uci,
    san: place.san,
    share: 0.5,
    reach: 1,
    openingName: null,
    source: "explorer",
  });
  return (
    db
      .prepare(
        "SELECT id FROM repertoire_positions WHERE repertoire_id = ? AND position_key = ? AND kind = 'reply'",
      )
      .get(repertoireId, place.positionKey) as { id: number }
  ).id;
}

const ideaOf = (id: number): string | null =>
  (
    db.prepare("SELECT idea FROM repertoire_positions WHERE id = ?").get(id) as {
      idea: string | null;
    }
  ).idea;

const allPositions = () => db.prepare("SELECT * FROM repertoire_positions ORDER BY id").all();

const putIdea = (
  id: number | string,
  payload: unknown,
  headers: Record<string, string> = ALLOWED,
  target: FastifyInstance = app,
) =>
  target.inject({
    method: "PUT",
    url: `/api/repertoires/positions/${id}/idea`,
    headers: { ...headers, "content-type": "application/json" },
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

describe("PUT /api/repertoires/positions/:id/idea", () => {
  it("trims the note, replaces what was stored across every variation sharing the move, leaves rebuild copies alone, and logs without the text", async () => {
    const first = createRepertoireVariation(db, {
      side: "white",
      groupName: "London System",
      variationName: "Main line",
    });
    const second = createRepertoireVariation(db, {
      side: "white",
      groupName: "London System",
      variationName: "Against c5",
    });
    const rebuildCopy = createRepertoireVariation(db, {
      side: "white",
      groupName: `London System${REPERTOIRE_REBUILD_GROUP_SUFFIX}`,
      variationName: "Main line",
    });
    const firstId = addOwnMove(first.id, ["d4", "d5"], "Bf4", 1, "Earlier note.");
    const secondId = addOwnMove(second.id, ["d4", "d5"], "Bf4", 0.5, null);
    const otherMoveId = addOwnMove(first.id, [], "d4", 1, "Untouched move.");
    const copyId = addOwnMove(rebuildCopy.id, ["d4", "d5"], "Bf4", 1, "Rebuild copy note.");

    const note = "Bishop out before e3 shuts it in.";
    const response = await putIdea(firstId, { idea: `  ${note}\n` });

    expect(response.statusCode).toBe(200);
    expect(SaveRepertoireIdeaResponseSchema.parse(response.json())).toEqual({
      rows_updated: 2,
      idea: note,
    });
    expect(ideaOf(firstId)).toBe(note);
    expect(ideaOf(secondId)).toBe(note);
    expect(ideaOf(otherMoveId)).toBe("Untouched move.");
    expect(ideaOf(copyId)).toBe("Rebuild copy note.");

    const savedEvents = log.named("repertoire.idea_saved");
    expect(savedEvents).toHaveLength(1);
    expect(savedEvents[0]?.fields).toEqual({
      position_id: firstId,
      rows_updated: 2,
      length: note.length,
    });
    expect(JSON.stringify(log.events)).not.toContain(note);
  });

  it("accepts a note of exactly 500 characters after trimming", async () => {
    const unit = createRepertoireVariation(db, {
      side: "white",
      groupName: "London System",
      variationName: "Main line",
    });
    const id = addOwnMove(unit.id, [], "d4");
    const exact = "a".repeat(REPERTOIRE_IDEA_MAX_LENGTH);

    const response = await putIdea(id, { idea: `  ${exact}  ` });

    expect(response.statusCode).toBe(200);
    expect(SaveRepertoireIdeaResponseSchema.parse(response.json())).toEqual({
      rows_updated: 1,
      idea: exact,
    });
    expect(ideaOf(id)).toBe(exact);
  });

  it.each(["0", "-1", "1.5", "abc", "01"])(
    "refuses invalid id %s with 400 invalid_request and writes nothing",
    async (badId) => {
      const unit = createRepertoireVariation(db, {
        side: "white",
        groupName: "London System",
        variationName: "Main line",
      });
      addOwnMove(unit.id, [], "d4", 1, "Keep me.");
      const before = allPositions();

      const response = await putIdea(badId, { idea: "New note." });

      expect(response.statusCode).toBe(400);
      expect(RepertoireImportRefusalSchema.parse(response.json()).error).toBe("invalid_request");
      expect(allPositions()).toEqual(before);
      expect(log.named("repertoire.idea_saved")).toHaveLength(0);
    },
  );

  it.each<[string, unknown]>([
    ["an extra key", { idea: "Develop.", extra: true }],
    ["no idea key", {}],
    ["a non-string idea", { idea: 42 }],
    ["an empty idea", { idea: "" }],
    ["a blank idea", { idea: "   \n\t " }],
    ["an idea over 500 characters", { idea: "x".repeat(REPERTOIRE_IDEA_MAX_LENGTH + 1) }],
    ["a null body", null],
    ["an array body", ["Develop."]],
  ])("refuses %s with 400 invalid_request and writes nothing", async (_what, payload) => {
    const unit = createRepertoireVariation(db, {
      side: "white",
      groupName: "London System",
      variationName: "Main line",
    });
    const id = addOwnMove(unit.id, [], "d4", 1, "Keep me.");
    const before = allPositions();

    const response = await putIdea(id, payload);

    expect(response.statusCode).toBe(400);
    expect(RepertoireImportRefusalSchema.parse(response.json()).error).toBe("invalid_request");
    expect(allPositions()).toEqual(before);
    expect(log.named("repertoire.idea_saved")).toHaveLength(0);
  });

  it("refuses a missing id, a reply row id, and a rebuild copy row id with 404 not_found and writes nothing", async () => {
    const unit = createRepertoireVariation(db, {
      side: "white",
      groupName: "London System",
      variationName: "Main line",
    });
    const copy = createRepertoireVariation(db, {
      side: "white",
      groupName: `London System${REPERTOIRE_REBUILD_GROUP_SUFFIX}`,
      variationName: "Main line",
    });
    addOwnMove(unit.id, [], "d4", 1, "Keep me.");
    const replyId = addReplyMove(unit.id, ["d4"], "d5");
    const copyOwnId = addOwnMove(copy.id, [], "d4", 1, "Rebuild copy.");
    const before = allPositions();

    for (const badId of [999999, replyId, copyOwnId]) {
      const response = await putIdea(badId, { idea: "Should not save." });
      expect(response.statusCode).toBe(404);
      expect(RepertoireImportRefusalSchema.parse(response.json()).error).toBe("not_found");
    }
    expect(allPositions()).toEqual(before);
    expect(log.named("repertoire.idea_saved")).toHaveLength(0);
  });

  it.each(BAD_HEADERS)(
    "refuses %s with 403 origin_not_allowed before the body is read and writes nothing",
    async (_what, headers) => {
      const unit = createRepertoireVariation(db, {
        side: "white",
        groupName: "London System",
        variationName: "Main line",
      });
      const id = addOwnMove(unit.id, [], "d4", 1, "Keep me.");
      const before = allPositions();

      // Malformed JSON: if the route read the body before checking headers, Fastify would answer 400.
      const response = await putIdea(id, "{not valid json", headers);

      expect(response.statusCode).toBe(403);
      expect(RepertoireImportRefusalSchema.parse(response.json()).error).toBe("origin_not_allowed");
      expect(allPositions()).toEqual(before);
      expect(log.named("repertoire.idea_saved")).toHaveLength(0);
    },
  );

  it("updates both variations and publishes the new answered.idea on a running drill", async () => {
    const first = createRepertoireVariation(db, {
      side: "white",
      groupName: "London System",
      variationName: "Main line",
    });
    const second = createRepertoireVariation(db, {
      side: "white",
      groupName: "London System",
      variationName: "Second line",
    });
    addOwnMove(first.id, [], "d4", 1);
    addReplyMove(first.id, ["d4"], "d5");
    const firstBf4Id = addOwnMove(first.id, ["d4", "d5"], "Bf4", 1);
    const secondBf4Id = addOwnMove(second.id, ["d4", "d5"], "Bf4", 0.5);

    const activity = new ActivityService({
      db,
      game: new GameService({ db, engine: new ScriptedEngine([]) }),
      training: { desk: new ReviewDesk({ db }) },
    });
    const wiredApp = buildApp({ db, log, allowedOrigins: DEFAULT_ALLOWED_ORIGINS, activity });
    const seen: (ActivityState | null)[] = [];
    activity.onState((state) => seen.push(state));

    try {
      let state = (await activity.startTraining({
        mode: "repertoire",
        repertoireId: first.id,
        scope: "all",
      })) as TrainingActivity;
      state = (await activity.trainingTry("d2d4", state.activity_id)) as TrainingActivity;
      // 2.Bf4 is now shown as a new move, so it is the answered move with idea null.
      expect(state.repertoire?.answered).toEqual({
        position_id: firstBf4Id,
        san: "Bf4",
        idea: null,
        asked: false,
      });

      const note = "Bishop out before e3 shuts it in.";
      const response = await putIdea(firstBf4Id, { idea: note }, ALLOWED, wiredApp);

      expect(response.statusCode).toBe(200);
      expect(SaveRepertoireIdeaResponseSchema.parse(response.json())).toEqual({
        rows_updated: 2,
        idea: note,
      });
      expect(ideaOf(firstBf4Id)).toBe(note);
      expect(ideaOf(secondBf4Id)).toBe(note);

      const latest = activity.current() as TrainingActivity;
      expect(latest.repertoire?.answered).toEqual({
        position_id: firstBf4Id,
        san: "Bf4",
        idea: note,
        asked: false,
      });
      expect(seen.at(-1)).toEqual(latest);
    } finally {
      await wiredApp.close();
    }
  });
});
