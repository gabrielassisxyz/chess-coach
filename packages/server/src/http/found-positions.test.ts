import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FoundPositionsQuery,
  type FoundPositionsResponse,
  FoundPositionsResponseSchema,
  type RepertoireScope,
} from "@chess-coach/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrainingRun } from "../activity/training.js";
import { buildApp } from "../app.js";
import type { Clock } from "../clock.js";
import { insertFoundPosition } from "../db/found-positions.js";
import { setGrading } from "../db/games.js";
import { type Database, openDatabase } from "../db/open.js";
import { insertGeneratedPuzzle } from "../db/puzzles.js";
import { importFinishedGame } from "../import/pgn.js";
import { ReviewDesk } from "../srs/review.js";
import { registerFoundPositionRoutes } from "./found-positions.js";

const T0 = new Date("2026-11-15T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const hoursFromT0 = (hours: number): string =>
  new Date(T0.getTime() + hours * HOUR_MS).toISOString();
const clock: Clock = { now: () => T0 };

// 42 plies, so ply 41 is White's 21st move, 21. Bb1, well past the opening.
const LONG_WHITE =
  '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Na5 10. Bc2 c5 11. d4 Qc7 12. Nbd2 cxd4 13. cxd4 Nc6 14. Nb3 a5 15. Be3 a4 16. Nbd2 Bd7 17. Rc1 Qb7 18. Qe2 Rfe8 19. Bd3 Rac8 20. a3 Bf8 21. Bb1 h6 1-0';
const SHORT_WHITE = '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0';
const LONG_PLAYED_AT = "2026-10-20T12:00:00.000Z";

let tmp: string;
let db: Database;
let app: FastifyInstance;
let longGame: number;
let shortGame: number;

function importGame(pgn: string, sourceId: string, opponent: string, playedAt: string): number {
  const gameId = importFinishedGame(db, {
    pgn,
    playerColor: "white",
    source: "pgn",
    sourceId,
    opponent,
    playedAt,
  });
  if (gameId === null) throw new Error("fixture game was not imported");
  setGrading(db, gameId, "done");
  return gameId;
}

const fenBefore = (gameId: number, ply: number): string =>
  (
    db.prepare("SELECT fen_before FROM moves WHERE game_id = ? AND ply = ?").get(gameId, ply) as {
      fen_before: string;
    }
  ).fen_before;

interface FoundFixture {
  gameId?: number;
  ply?: number;
  color?: "white" | "black";
  phase?: "opening" | "middlegame" | "endgame";
  fromRepeat?: boolean;
  fromDeparture?: boolean;
  listed?: boolean;
  // Left out after a run had listed it, so its puzzle row stays.
  keptPuzzle?: boolean;
  accepted?: string[];
  foundAt?: string;
  openingName?: string | null;
  card?: string;
}

// A position as the generator stores it, its puzzle once listed, and the card a drill left on it,
// due at `card`.
function addFound(id: string, fixture: FoundFixture = {}): void {
  const gameId = fixture.gameId ?? longGame;
  const ply = fixture.ply ?? 41;
  const fen = fenBefore(gameId, ply);
  const accepted = fixture.accepted ?? ["d3b1"];
  const phase = fixture.phase ?? "middlegame";
  insertFoundPosition(db, {
    id,
    fen,
    color: fixture.color ?? "white",
    phase,
    fromMistake: !fixture.fromRepeat,
    fromRepeat: fixture.fromRepeat ?? false,
    fromDeparture: fixture.fromDeparture ?? false,
    listed: fixture.listed ?? true,
    acceptedUci: accepted,
    reachedGames: fixture.fromRepeat ? 2 : 1,
    bestGames: 0,
    lastReachedAt: LONG_PLAYED_AT,
    gameId,
    ply,
    firstFoundAt: fixture.foundAt ?? hoursFromT0(-100),
  });
  if (fixture.listed !== false || fixture.keptPuzzle) {
    insertGeneratedPuzzle(db, {
      id,
      source: "own-games",
      motif: `${phase}-${fixture.color ?? "white"}`,
      difficulty: "beginner",
      fen,
      solutionUci: [accepted[0] as string],
      solutionSan: ["Bb1"],
      explanation: "From your games. Best: Bb1.",
      openingName: fixture.openingName ?? null,
    });
  }
  if (fixture.card !== undefined) {
    db.prepare(
      `INSERT INTO found_cards (position_id, interval_hours, ease_factor, repetitions,
         next_review_at, introduced_at, reviews, last_reviewed_at)
       VALUES (?, 24, 2.5, 2, ?, ?, 2, ?)`,
    ).run(id, fixture.card, hoursFromT0(-48), hoursFromT0(-24));
  }
}

async function list(query = ""): Promise<FoundPositionsResponse> {
  const response = await app.inject({ method: "GET", url: `/api/found-positions${query}` });
  expect(response.statusCode).toBe(200);
  return FoundPositionsResponseSchema.parse(response.json());
}

const ids = (answer: FoundPositionsResponse): string[] => answer.positions.map((p) => p.id);

// The queue a drill would start now: the ids of its run, or none when it is refused as empty.
function drillQueue(scope: RepertoireScope, filter: FoundPositionsQuery): string[] {
  const deps = { db, desk: new ReviewDesk({ db, clock }), clock };
  try {
    TrainingRun.begin(deps, { mode: "found", scope, ...filter });
  } catch (error) {
    if ((error as { code?: string }).code === "empty_queue") return [];
    throw error;
  }
  const row = db
    .prepare("SELECT items_json FROM training_runs WHERE ended_at IS NULL ORDER BY id DESC")
    .get() as { items_json: string };
  return (JSON.parse(row.items_json) as { id: string }[]).map((item) => item.id);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cc-found-route-"));
  db = openDatabase(tmp);
  longGame = importGame(LONG_WHITE, "long", "rival", LONG_PLAYED_AT);
  shortGame = importGame(SHORT_WHITE, "short", "neighbour", "2026-10-25T09:30:00.000Z");
  app = Fastify();
  registerFoundPositionRoutes(app, db, clock);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/found-positions", () => {
  it("lists a position with everything its card on the page shows", async () => {
    addFound("own:long", { openingName: "Ruy Lopez: Closed", card: hoursFromT0(-1) });
    const answer = await list();
    expect(answer.positions).toEqual([
      {
        id: "own:long",
        fen: fenBefore(longGame, 41),
        color: "white",
        phase: "middlegame",
        section: "mistakes",
        from_mistake: true,
        from_departure: false,
        opening_name: "Ruy Lopez: Closed",
        line: { first_ply: 37, san: ["Bd3", "Rac8", "a3", "Bf8"] },
        reached_games: 1,
        best_games: 0,
        last_reached_at: LONG_PLAYED_AT,
        game: { id: longGame, ply: 41, opponent: "rival", played_at: LONG_PLAYED_AT },
        state: "due",
        next_review_at: hoursFromT0(-1),
      },
    ]);
  });

  it("holds the four plies before a position at ply 41, and the two moves before one at ply 3", async () => {
    addFound("own:long");
    addFound("own:early", { gameId: shortGame, ply: 3, phase: "opening", accepted: ["g1f3"] });
    addFound("own:nine", { gameId: longGame, ply: 9, phase: "opening", accepted: ["e1g1"] });
    addFound("own:eight", { gameId: longGame, ply: 8, phase: "opening", accepted: ["g8f6"] });
    const lines = new Map((await list()).positions.map((p) => [p.id, p.line]));
    expect(lines.get("own:long")).toEqual({ first_ply: 37, san: ["Bd3", "Rac8", "a3", "Bf8"] });
    expect(lines.get("own:early")).toEqual({ first_ply: 1, san: ["e4", "e5"] });
    expect(lines.get("own:nine")).toEqual({ first_ply: 5, san: ["Bb5", "a6", "Ba4", "Nf6"] });
    expect(lines.get("own:eight")).toEqual({
      first_ply: 1,
      san: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4"],
    });
  });

  it("names the game and ply stored on the row, with that game's opponent and date", async () => {
    addFound("own:long");
    addFound("own:early", { gameId: shortGame, ply: 3, phase: "opening", accepted: ["g1f3"] });
    // The date the game was played wins over when it ended.
    db.prepare("UPDATE games SET finished_at = ? WHERE id = ?").run(
      "2026-10-25T10:45:00.000Z",
      shortGame,
    );
    const games = new Map((await list()).positions.map((p) => [p.id, p.game]));
    expect(games.get("own:long")).toEqual({
      id: longGame,
      ply: 41,
      opponent: "rival",
      played_at: LONG_PLAYED_AT,
    });
    expect(games.get("own:early")).toEqual({
      id: shortGame,
      ply: 3,
      opponent: "neighbour",
      played_at: "2026-10-25T09:30:00.000Z",
    });
  });

  it("dates a game with no date of its own by its end, and shows a game that is gone as such", async () => {
    addFound("own:long");
    db.prepare("UPDATE games SET played_at = NULL, finished_at = ? WHERE id = ?").run(
      "2026-10-21T08:00:00.000Z",
      longGame,
    );
    addFound("own:gone", { accepted: ["d3b1"] });
    db.prepare("UPDATE found_positions SET game_id = 9999, ply = 12 WHERE id = 'own:gone'").run();
    const byId = new Map((await list()).positions.map((p) => [p.id, p]));
    expect(byId.get("own:long")?.game.played_at).toBe("2026-10-21T08:00:00.000Z");
    expect(byId.get("own:gone")).toMatchObject({
      game: { id: 9999, ply: 12, opponent: null, played_at: null },
      line: { first_ply: 8, san: [] },
    });
  });

  it("puts the reached section first, and inside each section due, new, then the rest by next review", async () => {
    addFound("m-later", { card: hoursFromT0(30) });
    addFound("m-due", { card: hoursFromT0(-2) });
    addFound("m-new", { foundAt: hoursFromT0(-90) });
    addFound("r-later", { fromRepeat: true, card: hoursFromT0(10) });
    addFound("r-new", { fromRepeat: true });
    addFound("r-due", { fromRepeat: true, card: hoursFromT0(-1) });
    addFound("m-due-older", { card: hoursFromT0(-5) });
    addFound("m-new-newer", { foundAt: hoursFromT0(-80) });
    addFound("m-later-sooner", { card: hoursFromT0(20) });
    const answer = await list();
    expect(ids(answer)).toEqual([
      "r-due",
      "r-new",
      "r-later",
      "m-due-older",
      "m-due",
      "m-new-newer",
      "m-new",
      "m-later-sooner",
      "m-later",
    ]);
    expect(answer.positions.map((p) => [p.section, p.state, p.next_review_at])).toEqual([
      ["reached", "due", hoursFromT0(-1)],
      ["reached", "new", null],
      ["reached", "scheduled", hoursFromT0(10)],
      ["mistakes", "due", hoursFromT0(-5)],
      ["mistakes", "due", hoursFromT0(-2)],
      ["mistakes", "new", null],
      ["mistakes", "new", null],
      ["mistakes", "scheduled", hoursFromT0(20)],
      ["mistakes", "scheduled", hoursFromT0(30)],
    ]);
  });

  it("keeps a position with listed = 0 out of the list and counts it in left_out", async () => {
    addFound("listed");
    addFound("left-out-white", { listed: false, keptPuzzle: true });
    addFound("left-out-black", { listed: false, color: "black", phase: "endgame" });
    const answer = await list();
    expect(ids(answer)).toEqual(["listed"]);
    expect(answer.counts).toMatchObject({ total: 1, all: 1, left_out: 2 });
    expect((await list("?color=black")).counts.left_out).toBe(1);
    expect((await list("?phase=middlegame")).counts.left_out).toBe(1);
    expect((await list("?color=white&phase=endgame")).counts.left_out).toBe(0);
  });

  describe("counts", () => {
    function fillTwenty(): void {
      for (let i = 0; i < 6; i++) {
        addFound(`wo-new-${i}`, {
          phase: "opening",
          fromRepeat: i < 2,
          foundAt: hoursFromT0(-50 + i),
        });
      }
      addFound("wo-due", { phase: "opening", card: hoursFromT0(-3) });
      addFound("wo-later", { phase: "opening", card: hoursFromT0(5) });
      addFound("we-new-0", { phase: "endgame" });
      addFound("we-new-1", { phase: "endgame", foundAt: hoursFromT0(-10) });
      addFound("we-due-0", { phase: "endgame", card: hoursFromT0(-1) });
      addFound("we-due-1", { phase: "endgame", card: hoursFromT0(-7) });
      for (let i = 0; i < 5; i++) {
        addFound(`bm-new-${i}`, { color: "black", foundAt: hoursFromT0(-30 - i) });
      }
      addFound("bm-due", { color: "black", card: hoursFromT0(-2) });
      addFound("bm-later", { color: "black", card: hoursFromT0(48) });
      addFound("bo-later", { color: "black", phase: "opening", card: hoursFromT0(12) });
      addFound("bo-out-0", { color: "black", phase: "opening", listed: false, keptPuzzle: true });
      addFound("bo-out-1", { color: "black", phase: "opening", listed: false });
    }

    it.each<[string, FoundPositionsQuery, string]>([
      ["no filter", {}, ""],
      ["one colour", { color: "white" }, "?color=white"],
      ["one phase", { phase: "opening" }, "?phase=opening"],
      [
        "a colour and a phase",
        { color: "black", phase: "middlegame" },
        "?color=black&phase=middlegame",
      ],
      [
        "filters nothing matches",
        { color: "black", phase: "endgame" },
        "?color=black&phase=endgame",
      ],
    ])("match the queues each scope would serve now, with %s", async (_name, filter, query) => {
      fillTwenty();
      const { counts } = await list(query);
      expect({
        recommended: counts.recommended,
        due: counts.due,
        all: counts.all,
      }).toEqual({
        recommended: drillQueue("recommended", filter).length,
        due: drillQueue("due", filter).length,
        all: drillQueue("all", filter).length,
      });
    });

    it("count what the page shows: totals for both filters, phases and sections for the colour", async () => {
      fillTwenty();
      expect((await list()).counts).toEqual({
        total: 20,
        due: 4,
        new: 13,
        recommended: 10,
        all: 20,
        by_phase: { opening: 9, middlegame: 7, endgame: 4 },
        by_section: { reached: 2, mistakes: 18 },
        left_out: 2,
      });
      expect((await list("?color=white&phase=opening")).counts).toEqual({
        total: 8,
        due: 1,
        new: 6,
        recommended: 7,
        all: 8,
        by_phase: { opening: 8, middlegame: 0, endgame: 4 },
        by_section: { reached: 2, mistakes: 10 },
        left_out: 0,
      });
    });
  });

  it("lists with phase=endgame the positions the all drill serves, each section in the drill's order", async () => {
    // Inside each section the ids sort against the drill's order, so an order by id shows.
    addFound("e-rep-a-new", { phase: "endgame", fromRepeat: true, color: "black" });
    addFound("e-due", { phase: "endgame", card: hoursFromT0(-3) });
    addFound("e-rep-due", {
      phase: "endgame",
      fromRepeat: true,
      color: "black",
      card: hoursFromT0(-1),
    });
    addFound("e-a-later", { phase: "endgame", card: hoursFromT0(24) });
    addFound("m-due", { phase: "middlegame", card: hoursFromT0(-9) });
    addFound("o-new", { phase: "opening" });

    const listed = ids(await list("?phase=endgame"));
    const queue = drillQueue("all", { phase: "endgame" });
    const reached = new Set(["e-rep-a-new", "e-rep-due"]);
    expect(queue).toEqual(["e-due", "e-rep-due", "e-rep-a-new", "e-a-later"]);
    expect([...listed].sort()).toEqual([...queue].sort());
    expect(listed).toEqual([
      ...queue.filter((id) => reached.has(id)),
      ...queue.filter((id) => !reached.has(id)),
    ]);
    // With one section left, the list and the drill read in one order.
    const white = ids(await list("?phase=endgame&color=white"));
    expect(white).toEqual(["e-due", "e-a-later"]);
    expect(white).toEqual(drillQueue("all", { phase: "endgame", color: "white" }));
  });

  it("never sends the accepted moves or the solution", async () => {
    addFound("own:long", { accepted: ["d3b1", "c1g5", "h3h4"] });
    const response = await app.inject({ method: "GET", url: "/api/found-positions" });
    const text = response.body;
    for (const hidden of ["d3b1", "c1g5", "h3h4", "Bb1", "accepted", "solution", "Best:"]) {
      expect(text).not.toContain(hidden);
    }
    expect(
      Object.keys((response.json() as FoundPositionsResponse).positions[0] ?? {}).sort(),
    ).toEqual([
      "best_games",
      "color",
      "fen",
      "from_departure",
      "from_mistake",
      "game",
      "id",
      "last_reached_at",
      "line",
      "next_review_at",
      "opening_name",
      "phase",
      "reached_games",
      "section",
      "state",
    ]);
  });

  it.each(["?color=green", "?phase=late", "?color=White", "?color=white&color=black", "?phase="])(
    "answers 400 to %s and reads nothing",
    async (query) => {
      addFound("own:long");
      const prepare = vi.spyOn(db, "prepare");
      const response = await app.inject({ method: "GET", url: `/api/found-positions${query}` });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_filter" });
      expect(prepare).not.toHaveBeenCalled();
      prepare.mockRestore();
    },
  );

  it("is served by the app", async () => {
    addFound("own:long");
    const served = buildApp({ db });
    const response = await served.inject({ method: "GET", url: "/api/found-positions" });
    await served.close();
    expect(response.statusCode).toBe(200);
    expect(ids(FoundPositionsResponseSchema.parse(response.json()))).toEqual(["own:long"]);
  });
});

describe("GET /api/found-positions narrowed to one opening", () => {
  function fillThree(): void {
    addFound("own:two-knights", {
      openingName: "Italian Game: Two Knights Defense",
      color: "white",
      phase: "opening",
    });
    addFound("own:giuoco", {
      openingName: "Italian Game: Giuoco Pianissimo",
      color: "white",
      phase: "middlegame",
    });
    addFound("own:scandi", {
      openingName: "Scandinavian Defense",
      color: "black",
      phase: "opening",
    });
  }

  it("serves a family under its name and one variation under its full name", async () => {
    fillThree();
    expect(ids(await list("?opening=Italian%20Game"))).toEqual(["own:giuoco", "own:two-knights"]);
    const full = await list("?opening=Italian%20Game%3A%20Two%20Knights%20Defense");
    expect(ids(full)).toEqual(["own:two-knights"]);
    expect((await list("?opening=Scandinavian%20Defense")).positions).toHaveLength(1);
  });

  it("narrows every count the same way the list narrows", async () => {
    fillThree();
    const family = await list("?opening=Italian%20Game");
    expect(family.counts).toMatchObject({ total: 2, all: 2, left_out: 0 });
    expect(family.counts.by_phase).toEqual({ opening: 1, middlegame: 1, endgame: 0 });
    expect({
      recommended: family.counts.recommended,
      due: family.counts.due,
      all: family.counts.all,
    }).toEqual({
      recommended: drillQueue("recommended", { opening: "Italian Game" }).length,
      due: drillQueue("due", { opening: "Italian Game" }).length,
      all: drillQueue("all", { opening: "Italian Game" }).length,
    });
  });

  it("combines the opening with the colour and the phase", async () => {
    fillThree();
    expect(ids(await list("?opening=Italian%20Game&color=white"))).toEqual([
      "own:giuoco",
      "own:two-knights",
    ]);
    expect(ids(await list("?opening=Italian%20Game&color=black"))).toEqual([]);
    expect(ids(await list("?opening=Italian%20Game&phase=opening"))).toEqual(["own:two-knights"]);
  });

  it("answers no position and zero counts for an opening nothing carries", async () => {
    fillThree();
    const answer = await list("?opening=French%20Defense");
    expect(answer.positions).toEqual([]);
    expect(answer.counts).toMatchObject({
      total: 0,
      due: 0,
      new: 0,
      recommended: 0,
      all: 0,
      left_out: 0,
    });
    expect(answer.counts.by_phase).toEqual({ opening: 0, middlegame: 0, endgame: 0 });
    expect(answer.counts.by_section).toEqual({ reached: 0, mistakes: 0 });
    expect(drillQueue("all", { opening: "French Defense" })).toEqual([]);
  });

  it("lists nothing for a prefix of a family that is not the family", async () => {
    fillThree();
    const answer = await list("?opening=Italian");
    expect(answer.positions).toEqual([]);
    expect(answer.counts).toMatchObject({ total: 0, all: 0 });
  });

  it("counts a left-out position in left_out only when its name matches the filter", async () => {
    fillThree();
    addFound("own:out-italian", {
      openingName: "Italian Game: Evans Gambit",
      listed: false,
      keptPuzzle: true,
    });
    addFound("own:out-scandi", {
      openingName: "Scandinavian Defense",
      listed: false,
      keptPuzzle: true,
    });
    expect((await list("?opening=Italian%20Game")).counts.left_out).toBe(1);
    expect((await list("?opening=Italian%20Game%3A%20Evans%20Gambit")).counts.left_out).toBe(1);
    expect(
      (await list("?opening=Italian%20Game%3A%20Two%20Knights%20Defense")).counts.left_out,
    ).toBe(0);
    expect((await list("?opening=French%20Defense")).counts.left_out).toBe(0);
    expect((await list()).counts.left_out).toBe(2);
  });

  it("treats an opening with a quote as a literal value, not as SQL", async () => {
    fillThree();
    const answer = await list("?opening=%27%20OR%20%271%27%3D%271");
    expect(answer.positions).toEqual([]);
    expect(answer.counts.total).toBe(0);
  });

  it.each(["?opening=", `?opening=${"x".repeat(121)}`])(
    "answers 400 to %s and reads nothing",
    async (query) => {
      addFound("own:long");
      const prepare = vi.spyOn(db, "prepare");
      const response = await app.inject({ method: "GET", url: `/api/found-positions${query}` });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "invalid_filter" });
      expect(prepare).not.toHaveBeenCalled();
      prepare.mockRestore();
    },
  );
});
