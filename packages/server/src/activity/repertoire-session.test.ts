import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActivityState,
  type RepertoireDrill,
  type RepertoireScope,
  ServerEventSchema,
  type TrainingActivity,
} from "@chess-coach/shared";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeCoach } from "../../test/fakes/fake-coach.js";
import { ScriptedEngine } from "../../test/fakes/scripted-engine.js";
import { buildApp } from "../app.js";
import type { Clock } from "../clock.js";
import { createCoachSession } from "../db/chat.js";
import { type Database, openDatabase } from "../db/open.js";
import { listRepertoireDrillMoves, type RepertoireDrillMove } from "../db/repertoire-cards.js";
import {
  createRepertoireVariation,
  insertRepertoireOwnMove,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { GameService } from "../game/service.js";
import { positionKey } from "../openings/from-games.js";
import { ReviewDesk } from "../srs/review.js";
import { review } from "../srs/sm2.js";
import {
  REPERTOIRE_FLAG_BUDGET_MS,
  REPERTOIRE_NO_IDEA,
  REPERTOIRE_RECOMMENDED_SIZE,
  type RepertoireTryJudge,
  selectRepertoireDrillMoves,
} from "./repertoire-session.js";
import { ActivityService } from "./service.js";

const T0 = new Date("2026-11-01T12:00:00.000Z");
const PAST = "2026-10-01T00:00:00.000Z";
const FUTURE = "2026-12-01T00:00:00.000Z";
const HOUR_MS = 3_600_000;
let now = T0;
const clock: Clock = { now: () => now };

let tmp: string;
let db: Database;

beforeEach(() => {
  now = T0;
  tmp = mkdtempSync(join(tmpdir(), "cc-repertoire-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// [the line before the move, the move, its reach]: White's move when the line has an even length.
type FixtureRow = [string, string, number];

const SETUP_ROWS: FixtureRow[] = [
  ["", "e4", 1],
  ["e4", "e5", 1],
  ["e4 e5", "Nf3", 1],
  ["e4 e5 Nf3", "Nc6", 1],
  ["e4 e5 Nf3 Nc6", "Bc4", 1],
];

// Six White moves: 3...Bc5 4.c3 Nf6 5.d4 is the likeliest line, 3...Nf6 4.d3 the other one.
const ITALIAN_ROWS: FixtureRow[] = [
  ...SETUP_ROWS,
  ["e4 e5 Nf3 Nc6 Bc4", "Bc5", 0.6],
  ["e4 e5 Nf3 Nc6 Bc4", "Nf6", 0.4],
  ["e4 e5 Nf3 Nc6 Bc4 Bc5", "c3", 0.6],
  ["e4 e5 Nf3 Nc6 Bc4 Nf6", "d3", 0.4],
  ["e4 e5 Nf3 Nc6 Bc4 Bc5 c3", "Nf6", 0.3],
  ["e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6", "d4", 0.3],
];

const WIDE_REPLIES: [string, number][] = [
  ["Bc5", 0.25],
  ["Nf6", 0.2],
  ["Be7", 0.1],
  ["d6", 0.09],
  ["h6", 0.08],
  ["a6", 0.07],
  ["g6", 0.06],
  ["Qe7", 0.05],
  ["Na5", 0.04],
];

// Twelve White moves: the three of the setup, then 4.d3 against nine replies to 3.Bc4.
const WIDE_ROWS: FixtureRow[] = [
  ...SETUP_ROWS,
  ...WIDE_REPLIES.flatMap(([reply, reach]): FixtureRow[] => [
    ["e4 e5 Nf3 Nc6 Bc4", reply, reach],
    [`e4 e5 Nf3 Nc6 Bc4 ${reply}`, "d3", reach],
  ]),
];

const lineOf = (text: string): string[] => (text === "" ? [] : text.split(" "));

function placeOf(lineText: string, san: string): { positionKey: string; uci: string } {
  const board = new Chess();
  for (const played of lineOf(lineText)) board.move(played);
  const key = positionKey(board.fen());
  const move = board.move(san);
  return { positionKey: key, uci: `${move.from}${move.to}${move.promotion ?? ""}` };
}

function keyAfter(lineText: string, san: string): string {
  const board = new Chess();
  for (const played of [...lineOf(lineText), san]) board.move(played);
  return positionKey(board.fen());
}

function addVariation(name: string, rows: FixtureRow[]): number {
  const { id } = createRepertoireVariation(db, {
    side: "white",
    groupName: "Italian Game",
    variationName: name,
  });
  for (const [lineText, san, reach] of rows) {
    const line = lineOf(lineText);
    const place = placeOf(lineText, san);
    const row = {
      repertoireId: id,
      positionKey: place.positionKey,
      ply: line.length + 1,
      line,
      reach,
      openingName: line.length >= 5 ? "Italian Game" : "King's Pawn Game",
      uci: place.uci,
      san,
      share: null,
      source: "explorer" as const,
    };
    if (line.length % 2 === 1) upsertRepertoireReply(db, row);
    else insertRepertoireOwnMove(db, { ...row, cpLoss: 0, evalCp: 30, results: null });
  }
  return id;
}

function addCard(lineText: string, san: string, nextReviewAt: string, repetitions = 2): void {
  const place = placeOf(lineText, san);
  db.prepare(
    `INSERT INTO repertoire_cards (position_key, move_uci, introduced_at, next_review_at,
       interval_hours, ease_factor, repetitions, reviews)
     VALUES (?, ?, ?, ?, 24, 2.5, ?, 2)`,
  ).run(place.positionKey, place.uci, PAST, nextReviewAt, repetitions);
}

// A card on every White move of the rows, due unless `due` says otherwise.
function addCards(
  rows: FixtureRow[],
  due: (lineText: string, san: string) => boolean = () => true,
  repetitions = 2,
): void {
  for (const [lineText, san] of rows) {
    if (lineOf(lineText).length % 2 === 1) continue;
    addCard(lineText, san, due(lineText, san) ? PAST : FUTURE, repetitions);
  }
}

interface CardRow {
  next_review_at: string;
  interval_hours: number;
  ease_factor: number;
  repetitions: number;
  reviews: number;
}

function cardOf(lineText: string, san: string): CardRow | undefined {
  const place = placeOf(lineText, san);
  return db
    .prepare(
      `SELECT next_review_at, interval_hours, ease_factor, repetitions, reviews
       FROM repertoire_cards WHERE position_key = ? AND move_uci = ?`,
    )
    .get(place.positionKey, place.uci) as CardRow | undefined;
}

function setIdea(lineText: string, san: string, idea: string): void {
  const place = placeOf(lineText, san);
  db.prepare(
    "UPDATE repertoire_positions SET idea = ? WHERE position_key = ? AND move_uci = ? AND kind = 'own'",
  ).run(idea, place.positionKey, place.uci);
}

// Stands in for the opening table and the engine: names by position, losses by move.
class FakeRepertoireJudge implements RepertoireTryJudge {
  readonly searched: string[] = [];

  constructor(
    private readonly names: Record<string, string>,
    private readonly losses: Record<string, number>,
  ) {}

  openingOf(fen: string): string | null {
    return this.names[positionKey(fen)] ?? null;
  }

  async cpLoss(_fen: string, uci: string): Promise<number> {
    this.searched.push(uci);
    return this.losses[uci] ?? 1000;
  }
}

// The same table, with an engine that answers only when the test releases it.
class GatedRepertoireJudge extends FakeRepertoireJudge {
  private releases: ((loss: number) => void)[] = [];

  override cpLoss(fen: string, uci: string): Promise<number> {
    void super.cpLoss(fen, uci);
    return new Promise((resolve) => this.releases.push(resolve));
  }

  release(loss: number): void {
    for (const resolve of this.releases.splice(0)) resolve(loss);
  }
}

const RUY_LOPEZ_JUDGE_NAMES = (): Record<string, string> => ({
  [keyAfter("e4 e5 Nf3 Nc6", "Bc4")]: "Italian Game",
  [keyAfter("e4 e5 Nf3 Nc6", "Bb5")]: "Ruy Lopez",
});

function addFinishedGame(): number {
  return Number(
    db
      .prepare(
        `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase,
           result)
         VALUES (?, ?, 'white', 1200, ?, 'finished', '1-0')`,
      )
      .run(T0.toISOString(), T0.toISOString(), new Chess().fen()).lastInsertRowid,
  );
}

const settle = async (until: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !until(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

// Everything a server boot builds that holds memory: a new call is a restart over the same file.
function boot(judge?: RepertoireTryJudge): ActivityService {
  const session = createCoachSession(db, { promptVersion: "v" });
  const notifications = { sessionId: () => session.id };
  return new ActivityService({
    db,
    game: new GameService({ db, engine: new ScriptedEngine(["e7e5"]) }),
    training: {
      desk: new ReviewDesk({ db, clock, notifications }),
      notifications,
      clock,
      ...(judge ? { repertoireJudge: judge } : {}),
    },
  });
}

const training = (state: ActivityState | null): TrainingActivity => {
  if (state?.kind !== "training") throw new Error(`expected training, got ${state?.kind}`);
  return state;
};

const drillOf = (state: TrainingActivity): RepertoireDrill => {
  if (!state.repertoire) throw new Error("expected a repertoire drill");
  return state.repertoire;
};

const lineSan = (state: TrainingActivity): string[] => (state.moves ?? []).map((m) => m.san);
const whoPlayed = (state: TrainingActivity): string[] => (state.moves ?? []).map((m) => m.by);

function uciOf(fen: string, san: string): string {
  const move = new Chess(fen).move(san);
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

async function start(
  service: ActivityService,
  repertoireId: number,
  scope: RepertoireScope,
): Promise<TrainingActivity> {
  return training(await service.startTraining({ mode: "repertoire", repertoireId, scope }));
}

async function play(
  service: ActivityService,
  state: TrainingActivity,
  san: string,
): Promise<TrainingActivity> {
  return training(await service.trainingTry(uciOf(state.fen, san), state.activity_id));
}

async function next(service: ActivityService, state: TrainingActivity): Promise<TrainingActivity> {
  return training(await service.nextTrainingItem(state.activity_id));
}

const code = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return "no error";
};

const label = (move: RepertoireDrillMove): string => `${move.line.at(-1) ?? "start"} ${move.san}`;

// White's move in the wide fixture, by the number of moves played before it.
const WIDE_ANSWERS: Record<number, string> = { 0: "e4", 2: "Nf3", 4: "Bc4", 6: "d3" };

// Plays the open pass to its end, missing once each move `misses` names, and returns the moves the
// student played in it, named as `label` names them.
async function playWidePass(
  service: ActivityService,
  opened: TrainingActivity,
  misses: Set<string>,
): Promise<{ state: TrainingActivity; asked: string[] }> {
  let state = opened;
  for (let i = 0; i < 10 && state.input_enabled; i++) {
    const line = lineSan(state);
    const san = WIDE_ANSWERS[line.length] as string;
    if (misses.delete(`${line.at(-1) ?? "start"} ${san}`)) state = await play(service, state, "h3");
    state = await play(service, state, san);
  }
  const moves = state.moves ?? [];
  const asked = moves
    .filter((move) => move.by === "student")
    .map((move) => `${moves[move.ply - 1]?.san ?? "start"} ${move.san}`);
  return { state, asked };
}

interface DrillProgress {
  pass: number[];
  outcomes: TrainingActivity["queue_outcomes"];
  left: number;
  right: number;
  wrong: number;
}

// What the page shows of a drill's progress: the pass of how many, one outcome per pass, and the
// moves left, right first time and missed first time.
function progressOf(state: TrainingActivity): DrillProgress {
  const drill = drillOf(state);
  return {
    pass: [state.item.position_in_queue, state.item.queue_length],
    outcomes: state.queue_outcomes,
    left: drill.moves_left,
    right: drill.moves_right,
    wrong: drill.moves_wrong,
  };
}

describe("choosing the moves of a repertoire drill", () => {
  it("serves every move for all, every due move for due and at most ten for recommended, in line order", () => {
    const id = addVariation("Wide", WIDE_ROWS);
    addCard("e4 e5 Nf3 Nc6", "Bc4", FUTURE);
    addCard("e4 e5 Nf3 Nc6 Bc4 Be7", "d3", PAST);
    const moves = listRepertoireDrillMoves(db, id);
    const order = [
      "start e4",
      "e5 Nf3",
      "Nc6 Bc4",
      ...WIDE_REPLIES.map(([reply]) => `${reply} d3`),
    ];

    expect(selectRepertoireDrillMoves(moves, "all", now).map(label)).toEqual(order);
    const due = order.filter((move) => move !== "Nc6 Bc4");
    expect(selectRepertoireDrillMoves(moves, "due", now).map(label)).toEqual(due);
    expect(selectRepertoireDrillMoves(moves, "recommended", now).map(label)).toEqual(
      due.slice(0, REPERTOIRE_RECOMMENDED_SIZE),
    );
    expect(due).toHaveLength(REPERTOIRE_RECOMMENDED_SIZE + 1);
  });

  it("reads each variation's own card where two variations play different moves in one position", () => {
    const parting = (san: string): FixtureRow[] => [
      ...SETUP_ROWS,
      ["e4 e5 Nf3 Nc6 Bc4", "Bc5", 1],
      ["e4 e5 Nf3 Nc6 Bc4 Bc5", san, 1],
    ];
    const classical = addVariation("Classical", parting("c3"));
    const pianissimo = addVariation("Pianissimo", parting("d3"));
    addCard("e4 e5 Nf3 Nc6 Bc4 Bc5", "c3", PAST);
    addCard("e4 e5 Nf3 Nc6 Bc4 Bc5", "d3", FUTURE);
    const afterBc5 = (repertoireId: number) =>
      listRepertoireDrillMoves(db, repertoireId)
        .filter((move) => move.line.at(-1) === "Bc5")
        .map((move) => ({ san: move.san, due: move.card?.next_review_at }));

    expect(afterBc5(classical)).toEqual([{ san: "c3", due: PAST }]);
    expect(afterBc5(pianissimo)).toEqual([{ san: "d3", due: FUTURE }]);
  });
});

describe("a repertoire drill", () => {
  it("plays each pass from move 1, answering Black and the moves that are not due", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (lineText) => lineText !== "e4 e5 Nf3 Nc6");
    const service = boot();
    let state = await start(service, id, "due");
    expect(state.mode).toBe("repertoire");
    expect(state.item).toMatchObject({ kind: "repertoire", position_in_queue: 1 });
    expect(state.status).toBe("prompt");
    expect(lineSan(state)).toEqual([]);

    state = await play(service, state, "e4");
    expect(lineSan(state)).toEqual(["e4", "e5"]);
    expect(state.status).toBe("in_progress");
    state = await play(service, state, "Nf3");
    // 3.Bc4 is not due, so the server plays it with Black's moves.
    expect(lineSan(state)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
    expect(whoPlayed(state)).toEqual(["student", "reply", "student", "reply", "reply", "reply"]);
    state = await play(service, state, "c3");
    state = await play(service, state, "d4");
    expect(state.status).toBe("solved");
    expect(state.input_enabled).toBe(false);

    state = await next(service, state);
    expect(state.item).toMatchObject({ kind: "repertoire", position_in_queue: 2 });
    expect(lineSan(state)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6"]);
    expect(whoPlayed(state).every((by) => by === "reply")).toBe(true);
    state = await play(service, state, "d3");
    expect(state.status).toBe("solved");
    state = await next(service, state);
    expect(drillOf(state).result).toEqual({ practised: 5, first_try_right: 5 });
  });

  it("brings a missed move back on a later pass, from move 1, until it is right first time", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS);
    const service = boot();
    let state = await start(service, id, "due");
    for (const san of ["e4", "Nf3", "Bc4", "c3"]) state = await play(service, state, san);
    state = await play(service, state, "h3");
    state = await play(service, state, "d4");
    expect(state.status).toBe("failed");
    state = await next(service, state);
    state = await play(service, state, "d3");
    state = await next(service, state);

    // The round is over; 5.d4 comes back with its whole line played for the student.
    expect(state.item).toMatchObject({ position_in_queue: 3 });
    expect(lineSan(state)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6"]);
    state = await play(service, state, "Qb3");
    state = await play(service, state, "d4");
    state = await next(service, state);
    expect(state.item).toMatchObject({ position_in_queue: 4 });
    expect(drillOf(state).moves_left).toBe(1);
    state = await play(service, state, "d4");
    expect(state.status).toBe("solved");
    state = await next(service, state);
    expect(drillOf(state).result).toEqual({ practised: 6, first_try_right: 5 });
    expect(state.summary).toEqual({ solved: 5, failed: 1 });
  });

  it("rates the first attempt only: right passes, a wrong try or a hint fails, retries add no review", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, () => true, 0);
    const service = boot();
    let state = await start(service, id, "due");
    state = await play(service, state, "e4");
    state = await play(service, state, "h3");
    state = await play(service, state, "a3");
    state = await play(service, state, "Nf3");
    training(await service.trainingHint(state.activity_id));
    state = await play(service, state, "Bc4");
    for (const san of ["c3", "d4"]) state = await play(service, state, san);
    state = await next(service, state);
    state = await play(service, state, "d3");
    state = await next(service, state);
    for (const san of ["Nf3", "Bc4"]) state = await play(service, state, san);

    // One review each: the schedule they had, moved once by a pass (4) or a fail (2).
    const stored = { interval_hours: 24, ease_factor: 2.5, repetitions: 0 };
    const reviewed = (quality: 2 | 4) => {
      const schedule = review(stored, quality);
      const due = new Date(T0.getTime() + schedule.interval_hours * HOUR_MS).toISOString();
      return { ...schedule, next_review_at: due, reviews: 3 };
    };
    expect(cardOf("", "e4")).toEqual(reviewed(4));
    expect(cardOf("e4 e5", "Nf3")).toEqual(reviewed(2));
    expect(cardOf("e4 e5 Nf3 Nc6", "Bc4")).toEqual(reviewed(2));
    expect(reviewed(4).repetitions).toBe(1);
    expect(reviewed(2).repetitions).toBe(0);
  });

  it("keeps the schedule of a move not due that an all drill gets right, and fails one missed or hinted", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, () => false);
    const before = cardOf("", "e4");
    const service = boot();
    let state = await start(service, id, "all");
    state = await play(service, state, "e4");
    state = await play(service, state, "d4");
    state = await play(service, state, "Nf3");
    training(await service.trainingHint(state.activity_id));

    expect(cardOf("", "e4")).toEqual(before);
    const failed = { interval_hours: 4, repetitions: 0, reviews: 3 };
    expect(cardOf("e4 e5", "Nf3")).toMatchObject(failed);
    expect(cardOf("e4 e5 Nf3 Nc6", "Bc4")).toMatchObject(failed);
  });

  it("reschedules a move that fell due while the drill was open, once it is right", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, () => false);
    db.prepare("UPDATE repertoire_cards SET next_review_at = ?").run(
      new Date(T0.getTime() + HOUR_MS).toISOString(),
    );
    const service = boot();
    const state = await start(service, id, "all");
    now = new Date(T0.getTime() + 2 * HOUR_MS);
    await play(service, state, "e4");
    expect(cardOf("", "e4")).toMatchObject({ repetitions: 3, reviews: 3 });
  });

  it("shows a new move with its answer on its first pass and rates it only on a later one", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    const service = boot();
    let state = await start(service, id, "recommended");
    expect(drillOf(state)).toMatchObject({
      first_pass: true,
      answer: { uci: "e2e4", san: "e4" },
    });
    expect(cardOf("", "e4")).toMatchObject({
      repetitions: 0,
      reviews: 0,
      next_review_at: T0.toISOString(),
    });

    for (const san of ["e4", "Nf3", "Bc4", "c3", "d4"]) state = await play(service, state, san);
    state = await next(service, state);
    state = await play(service, state, "d3");
    expect(cardOf("", "e4")).toMatchObject({ repetitions: 0, reviews: 0 });

    state = await next(service, state);
    expect(state.item).toMatchObject({ position_in_queue: 3 });
    expect(drillOf(state)).toMatchObject({ first_pass: false, answer: null, moves_left: 6 });
    state = await play(service, state, "e4");
    expect(cardOf("", "e4")).toMatchObject({ repetitions: 1, reviews: 1 });
  });

  it("leaves the position open after a wrong try, with no text and no limit, and keeps every try", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCard("", "e4", PAST);
    const service = boot();
    let state = await start(service, id, "due");
    for (const san of ["a3", "b3", "c3", "d3", "h3", "g3"]) {
      state = await play(service, state, san);
      expect(state.input_enabled).toBe(true);
      expect(state.status).toBe("prompt");
      expect(state.last_try).toMatchObject({ san, correct: false });
      expect(drillOf(state)).toMatchObject({
        answer: null,
        hint: { kind: "none" },
        flagged_opening: null,
      });
      expect(state.expected).toBeNull();
    }
    expect(state.tries).toBe(6);
    state = await play(service, state, "e4");
    const tries = db.prepare("SELECT ply, uci, correct FROM training_tries ORDER BY seq").all();
    expect(tries).toHaveLength(7);
    expect(tries.at(0)).toEqual({ ply: 0, uci: "a2a3", correct: 0 });
    expect(tries.at(-1)).toEqual({ ply: 0, uci: "e2e4", correct: 1 });
  });

  it("answers the first hint with the stored idea or a fixed sentence, the second with the move", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCard("", "e4", PAST);
    addCard("e4 e5", "Nf3", PAST);
    setIdea("", "e4", "Take the centre and free the bishop.");
    const service = boot();
    let state = await start(service, id, "due");
    state = training(await service.trainingHint(state.activity_id));
    expect(drillOf(state).hint).toEqual({
      kind: "idea",
      text: "Take the centre and free the bishop.",
    });
    state = training(await service.trainingHint(state.activity_id));
    expect(drillOf(state).hint).toEqual({ kind: "move", uci: "e2e4", san: "e4" });
    state = await play(service, state, "e4");
    state = training(await service.trainingHint(state.activity_id));
    expect(drillOf(state).hint).toEqual({ kind: "idea", text: REPERTOIRE_NO_IDEA });
    expect(cardOf("", "e4")).toMatchObject({ repetitions: 0, interval_hours: 4 });
    expect(cardOf("e4 e5", "Nf3")).toMatchObject({ repetitions: 0, interval_hours: 4 });
  });

  it("flags a good try that reaches another named opening, but not a blunder or an unnamed position", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "Bc4");
    const judge = new FakeRepertoireJudge(
      {
        [keyAfter("e4 e5 Nf3 Nc6", "Bc4")]: "Italian Game",
        [keyAfter("e4 e5 Nf3 Nc6", "Bb5")]: "Ruy Lopez",
        [keyAfter("e4 e5 Nf3 Nc6", "d4")]: "Scotch Game",
      },
      { f1b5: 12, d2d4: 300 },
    );
    const service = boot(judge);
    let state = await start(service, id, "due");
    expect(lineSan(state)).toEqual(["e4", "e5", "Nf3", "Nc6"]);
    expect(drillOf(state).opening_name).toBe("King's Pawn Game");

    state = await play(service, state, "Bb5");
    expect(drillOf(state).flagged_opening).toBe("Ruy Lopez");
    expect(state.input_enabled).toBe(true);
    state = await play(service, state, "d4");
    expect(drillOf(state).flagged_opening).toBeNull();
    state = await play(service, state, "h3");
    expect(drillOf(state).flagged_opening).toBeNull();
    expect(judge.searched).toEqual(["f1b5", "d2d4"]);
  });

  it("keeps a wrong try that waits on the engine when the board moves on meanwhile", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "Bc4");
    const gameId = addFinishedGame();
    const judge = new GatedRepertoireJudge(RUY_LOPEZ_JUDGE_NAMES(), {});
    const service = boot(judge);
    const state = await start(service, id, "due");

    const tried = service.trainingTry(uciOf(state.fen, "Bb5"), state.activity_id);
    await settle(() => judge.searched.length > 0);
    await service.openGame(gameId);
    judge.release(12);
    await tried;

    expect(service.current()?.kind).toBe("review");
    expect(db.prepare("SELECT uci, correct FROM training_tries").all()).toEqual([
      { uci: "f1b5", correct: 0 },
    ]);
    expect(cardOf("e4 e5 Nf3 Nc6", "Bc4")).toMatchObject({ repetitions: 0, interval_hours: 4 });
    const resumed = training(await service.resumeTraining());
    expect(resumed.last_try).toMatchObject({ san: "Bb5", correct: false });
    expect(drillOf(resumed)).toMatchObject({ flagged_opening: "Ruy Lopez", moves_wrong: 1 });
  });

  it("leaves a board opened in the same tick as a move on the board, with the drill paused", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS);
    const gameId = addFinishedGame();
    const service = boot();
    const state = await start(service, id, "due");

    await Promise.all([
      service.trainingTry(uciOf(state.fen, "e4"), state.activity_id),
      service.openGame(gameId),
    ]);

    expect(service.current()?.kind).toBe("review");
    expect(service.pausedTraining()).toMatchObject({ mode: "repertoire", solved: 1 });
    expect(db.prepare("SELECT uci, correct FROM training_tries").all()).toEqual([
      { uci: "e2e4", correct: 1 },
    ]);
  });

  it("gives up on the flag when the engine is slower than its budget, and keeps the try", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "Bc4");
    const judge = new GatedRepertoireJudge(RUY_LOPEZ_JUDGE_NAMES(), {});
    const service = boot(judge);
    const state = await start(service, id, "due");
    vi.useFakeTimers();
    try {
      const tried = service.trainingTry(uciOf(state.fen, "Bb5"), state.activity_id);
      await vi.advanceTimersByTimeAsync(REPERTOIRE_FLAG_BUDGET_MS);
      const after = training(await tried);
      expect(judge.searched).toEqual(["f1b5"]);
      expect(drillOf(after).flagged_opening).toBeNull();
      expect(after.last_try).toMatchObject({ san: "Bb5", correct: false });
      expect(after.input_enabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the scope, the counts and, at the end, the moves practised and the first-try rights", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => ["c3", "d3", "d4"].includes(san));
    const service = boot();
    let state = await start(service, id, "due");
    expect(drillOf(state)).toMatchObject({
      repertoire_id: id,
      scope: "due",
      opening_name: "Italian Game",
      moves_left: 3,
      moves_right: 0,
      moves_wrong: 0,
      result: null,
    });
    state = await play(service, state, "c3");
    state = await play(service, state, "d4");
    state = await next(service, state);
    state = await play(service, state, "Be2");
    expect(drillOf(state)).toMatchObject({ moves_left: 1, moves_right: 2, moves_wrong: 1 });
    state = await play(service, state, "d3");
    state = await next(service, state);
    state = await play(service, state, "d3");
    state = await next(service, state);

    expect(drillOf(state).result).toEqual({ practised: 3, first_try_right: 2 });
    const summary = db
      .prepare("SELECT content_json FROM chat_messages WHERE kind = 'notification'")
      .all() as { content_json: string }[];
    expect(summary.map((row) => JSON.parse(row.content_json))).toEqual([
      { type: "training_summary", mode: "repertoire", solved: 2, failed: 1 },
    ]);
  });

  it("starts from the start_training command with a repertoire and a scope, in a frame the page accepts", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "c3");
    const app = buildApp({
      hub: {
        coach: new FakeCoach(db),
        activity: boot(),
        db,
        allowedOrigins: ["http://localhost:5173"],
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const frames: { type: string; state?: unknown }[] = [];
      const socket = await app.injectWS(
        "/api/ws",
        { headers: { origin: "http://localhost:5173", host: "localhost:5173" } },
        { onInit: (ws) => ws.on("message", (data) => frames.push(JSON.parse(data.toString()))) },
      );
      socket.send(
        JSON.stringify({
          type: "start_training",
          command_id: "c1",
          mode: "repertoire",
          repertoire_id: id,
          scope: "due",
        }),
      );
      let frame: unknown;
      for (let i = 0; i < 200 && frame === undefined; i++) {
        frame = frames.find((event) => event.type === "activity" && event.state);
        if (frame === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const event = ServerEventSchema.parse(frame);
      if (event.type !== "activity") throw new Error(`expected activity, got ${event.type}`);
      const state = training(event.state);
      expect(state.item).toMatchObject({ kind: "repertoire", repertoire_id: id });
      expect(drillOf(state)).toMatchObject({ scope: "due", moves_left: 1 });
      expect(lineSan(state)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("refuses a drill without a repertoire or a scope, of an unknown repertoire, or with nothing due", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, () => false);
    const service = boot();
    expect(await code(service.startTraining({ mode: "repertoire", scope: "due" }))).toBe(
      "empty_queue",
    );
    expect(await code(service.startTraining({ mode: "repertoire", repertoireId: id }))).toBe(
      "empty_queue",
    );
    expect(await code(start(service, id + 1, "all"))).toBe("empty_queue");
    expect(await code(start(service, id, "due"))).toBe("empty_queue");
    expect(await code(start(service, id, "recommended"))).toBe("empty_queue");
    expect((await start(service, id, "all")).repertoire?.moves_left).toBe(6);
  });

  it("pauses a repertoire drill on restart and resumes it on the same move with its progress", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS);
    const first = boot();
    let state = await start(first, id, "recommended");
    for (const san of ["e4", "Nf3", "Bc4", "c3", "d4"]) state = await play(first, state, san);
    state = await next(first, state);
    state = await play(first, state, "h3");
    const before = { ...state, activity_id: 0, served_at: "" };

    const second = boot();
    expect(second.current()).toBeNull();
    expect(second.pausedTraining()).toMatchObject({
      mode: "repertoire",
      repertoire_id: id,
      scope: "recommended",
      color: "white",
      size: 6,
      position: 5,
      solved: 5,
      failed: 1,
    });
    let resumed = training(await second.resumeTraining());
    expect({ ...resumed, activity_id: 0, served_at: "" }).toEqual(before);
    expect(resumed.wrong_tries).toEqual([{ ply: 6, uci: "h2h3", san: "h3" }]);

    resumed = await play(second, resumed, "d3");
    resumed = await next(second, resumed);
    expect(lineSan(resumed)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6"]);
    resumed = await play(second, resumed, "d3");
    resumed = await next(second, resumed);
    expect(drillOf(resumed).result).toEqual({ practised: 6, first_try_right: 5 });
    expect(second.pausedTraining()).toBeNull();
  });
});

describe("the passes of a repertoire drill", () => {
  it("asks every move of a branching variation, a line per pass in reach order, then the missed ones again", async () => {
    const id = addVariation("Wide", WIDE_ROWS);
    addCards(WIDE_ROWS);
    const service = boot();
    const misses = new Set(["Nc6 Bc4", "Nf6 d3"]);
    let state = await start(service, id, "due");
    const passes: string[][] = [];
    for (let i = 0; i < 20 && drillOf(state).result === null; i++) {
      const pass = await playWidePass(service, state, misses);
      passes.push(pass.asked);
      state = await next(service, pass.state);
    }

    expect(passes).toEqual([
      ["start e4", "e5 Nf3", "Nc6 Bc4", "Bc5 d3"],
      ...WIDE_REPLIES.slice(1).map(([reply]) => [`${reply} d3`]),
      // Both misses lie on the line through 3...Nf6, so one pass of the next round asks them both.
      ["Nc6 Bc4", "Nf6 d3"],
    ]);
    expect(drillOf(state).result).toEqual({ practised: 12, first_try_right: 10 });
  });

  it("counts the passes, one outcome per pass, and the moves right and wrong at the first try", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS);
    const service = boot();
    let state = await start(service, id, "due");
    expect(progressOf(state)).toEqual({
      pass: [1, 2],
      outcomes: ["current", "pending"],
      left: 6,
      right: 0,
      wrong: 0,
    });
    for (const san of ["e4", "Nf3", "Bc4", "h3", "c3", "d4"])
      state = await play(service, state, san);
    expect(progressOf(state)).toEqual({
      pass: [1, 2],
      outcomes: ["failed", "pending"],
      left: 2,
      right: 4,
      wrong: 1,
    });
    state = await next(service, state);
    expect(progressOf(state)).toEqual({
      pass: [2, 2],
      outcomes: ["failed", "current"],
      left: 2,
      right: 4,
      wrong: 1,
    });
    state = await play(service, state, "d3");
    expect(progressOf(state)).toEqual({
      pass: [2, 2],
      outcomes: ["failed", "solved"],
      left: 1,
      right: 5,
      wrong: 1,
    });

    // The missed 4.c3 brings its line back, one pass more than the drill first had.
    state = await next(service, state);
    expect(progressOf(state)).toEqual({
      pass: [3, 3],
      outcomes: ["failed", "solved", "current"],
      left: 1,
      right: 5,
      wrong: 1,
    });
    // Right on its retry, 4.c3 is done but still counts as wrong at the first try.
    state = await play(service, state, "c3");
    expect(progressOf(state)).toEqual({
      pass: [3, 3],
      outcomes: ["failed", "solved", "solved"],
      left: 0,
      right: 5,
      wrong: 1,
    });
    state = await next(service, state);
    expect(drillOf(state).result).toEqual({ practised: 6, first_try_right: 5 });
    expect(db.prepare("SELECT outcomes_json FROM training_runs").get()).toEqual({
      outcomes_json: JSON.stringify(["failed", "solved", "solved"]),
    });
  });
});
