import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActivityState,
  type RepertoireDrill,
  RepertoireHintSchema,
  type RepertoireLevel,
  type RepertoireScope,
  ServerEventSchema,
  type TrainingActivity,
} from "@chess-coach/shared";
import { Chess, type Move } from "chess.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeCoach } from "../../test/fakes/fake-coach.js";
import { ScriptedEngine } from "../../test/fakes/scripted-engine.js";
import { buildApp } from "../app.js";
import type { Clock } from "../clock.js";
import { type CoachNotification, renderNotifications } from "../coach/notify.js";
import { appendChatMessage, createCoachSession } from "../db/chat.js";
import { type DrillCardKind, insertDrillReview, repertoireCardKey } from "../db/drill-reviews.js";
import { type Database, openDatabase } from "../db/open.js";
import {
  countRepertoireFirstAttemptsInWindow,
  findDrillRepertoire,
  listRepertoireDrillMoves,
  type RepertoireDrillMove,
} from "../db/repertoire-cards.js";
import {
  createRepertoireVariation,
  insertRepertoireOwnMove,
  REPERTOIRE_REBUILD_GROUP_SUFFIX,
  type RepertoireSide,
  upsertRepertoireReply,
} from "../db/repertoires.js";
import { endRunsLeftOpenAtStart } from "../db/training.js";
import type { Searcher, SearchRequest, SearchResult } from "../engine/uci.js";
import { GameService } from "../game/service.js";
import { importFinishedGame } from "../import/pgn.js";
import { type Log, RecordingLog } from "../log.js";
import { positionKey } from "../openings/from-games.js";
import { NO_OPENING_NAMES, parseOpeningTable } from "../openings/names.js";
import { GRADE, type Grade, review } from "../srs/fsrs.js";
import { ReviewDesk } from "../srs/review.js";
import {
  foundRepertoireIdsOf,
  mergeRepertoireUnitMoves,
  REPERTOIRE_FLAG_BUDGET_MS,
  REPERTOIRE_FLAG_CP,
  REPERTOIRE_MISSED_MIN_MISSES,
  REPERTOIRE_MISSED_SIZE,
  REPERTOIRE_MISSED_WINDOW_DAYS,
  REPERTOIRE_RECOMMENDED_SIZE,
  type RepertoireTryJudge,
  readRepertoireMissCounts,
  repertoireScopeCounts,
  repertoireTryJudge,
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
// Each time the coach was woken, how many notifications it could read by then.
let wakes: number[] = [];

beforeEach(() => {
  now = T0;
  wakes = [];
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

// The student's move sits where the line before it ends on the opponent's: an even length for White,
// an odd one for Black, whose own moves follow White's first.
const isStudentMove = (side: RepertoireSide, lineText: string): boolean =>
  (lineOf(lineText).length % 2 === 0) === (side === "white");

function addVariation(
  name: string,
  rows: FixtureRow[],
  groupName = "Italian Game",
  side: RepertoireSide = "white",
): number {
  const { id } = createRepertoireVariation(db, {
    side,
    groupName,
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
    if (!isStudentMove(side, lineText)) upsertRepertoireReply(db, row);
    else insertRepertoireOwnMove(db, { ...row, cpLoss: 0, evalCp: 30, results: null });
  }
  return id;
}

interface CardOptions {
  intervalHours?: number;
  introducedAt?: string;
}

// A move the student has learned: in the Review state, its stability the interval in days, and the
// difficulty a card gets from a first rating of Good, or of Again when `lastRight` is false. It was
// last reviewed one interval before it is due. An interval of 0 is a move shown and never rated,
// which is a New card.
function addCard(
  lineText: string,
  san: string,
  nextReviewAt: string,
  lastRight = true,
  options: CardOptions = {},
): void {
  const place = placeOf(lineText, san);
  const intervalHours = options.intervalHours ?? 24;
  const rated = intervalHours > 0;
  db.prepare(
    `INSERT INTO repertoire_cards (position_key, move_uci, introduced_at, next_review_at,
       interval_hours, fsrs_state, stability, difficulty, reviews, last_reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
  ).run(
    place.positionKey,
    place.uci,
    options.introducedAt ?? PAST,
    nextReviewAt,
    intervalHours,
    rated ? 2 : 0,
    rated ? intervalHours / 24 : null,
    rated ? (lastRight ? 2.1181 : 6.4133) : null,
    rated ? new Date(Date.parse(nextReviewAt) - intervalHours * HOUR_MS).toISOString() : null,
  );
}

// A card on every move of the student's in the rows, White's unless `side` says Black's, due unless
// `due` says otherwise.
function addCards(
  rows: FixtureRow[],
  due: (lineText: string, san: string) => boolean = () => true,
  lastRight = true,
  side: RepertoireSide = "white",
): void {
  for (const [lineText, san] of rows) {
    if (!isStudentMove(side, lineText)) continue;
    addCard(lineText, san, due(lineText, san) ? PAST : FUTURE, lastRight);
  }
}

// The Italian rows with a card, not due, on every White move but 4.c3: the one move a drill of the
// unit shows with its answer, so a test of that first pass has one move to follow.
function addCardsAllButC3(): void {
  const isC3 = (lineText: string, san: string): boolean =>
    lineText === "e4 e5 Nf3 Nc6 Bc4 Bc5" && san === "c3";
  addCards(
    ITALIAN_ROWS.filter(([lineText, san]) => !isC3(lineText, san)),
    () => false,
  );
}

interface CardRow {
  next_review_at: string;
  interval_hours: number;
  fsrs_state: number;
  stability: number | null;
  difficulty: number | null;
  learning_step: number;
  lapses: number;
  reviews: number;
  last_reviewed_at: string | null;
}

function cardOf(lineText: string, san: string): CardRow | undefined {
  const place = placeOf(lineText, san);
  return db
    .prepare(
      `SELECT next_review_at, interval_hours, fsrs_state, stability, difficulty, learning_step, lapses,
         reviews, last_reviewed_at
       FROM repertoire_cards WHERE position_key = ? AND move_uci = ?`,
    )
    .get(place.positionKey, place.uci) as CardRow | undefined;
}

// The grades the drill logged, one for each rating that moved a card, in the order they were made.
const loggedDrillGrades = (): number[] =>
  (db.prepare("SELECT grade FROM drill_reviews ORDER BY id").all() as { grade: number }[]).map(
    (row) => row.grade,
  );

interface FirstAttemptRow {
  position_key: string;
  move_uci: string;
  repertoire_id: number;
  attempted_at: string;
  correct: number;
}

const firstAttempts = (): FirstAttemptRow[] =>
  db
    .prepare(
      `SELECT position_key, move_uci, repertoire_id, attempted_at, correct
       FROM repertoire_first_attempts ORDER BY id`,
    )
    .all() as FirstAttemptRow[];

// The row a rated move leaves: its card's key, the variation it was served under, the moment it
// was rated and 1 for a first attempt got right.
function attemptOf(
  lineText: string,
  san: string,
  repertoireId: number,
  correct: 0 | 1,
  at: Date = T0,
): FirstAttemptRow {
  const place = placeOf(lineText, san);
  return {
    position_key: place.positionKey,
    move_uci: place.uci,
    repertoire_id: repertoireId,
    attempted_at: at.toISOString(),
    correct,
  };
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

  releaseNext(loss: number): void {
    this.releases.shift()?.(loss);
  }
}

// The same table, with an engine whose every search fails, as a missing or faulted Stockfish does.
class FailingRepertoireJudge extends FakeRepertoireJudge {
  override async cpLoss(fen: string, uci: string): Promise<number> {
    await super.cpLoss(fen, uci);
    throw new Error("the engine stopped answering");
  }
}

// Stands in for the evaluation engine when exercising `repertoireTryJudge`: records every search
// request and answers by position key, carrying `cutByTime` when told.
class RecordingDrillEngine implements Searcher {
  readonly requests: SearchRequest[] = [];
  private readonly answers = new Map<
    string,
    { bestmove: string; score: number; depth?: number; cutByTime?: boolean }
  >();

  write(
    key: string,
    bestmove: string,
    score: number,
    options: { depth?: number; cutByTime?: boolean } = {},
  ): this {
    this.answers.set(key, { bestmove, score, ...options });
    return this;
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    this.requests.push(request);
    const scripted = this.answers.get(positionKey(request.fen));
    if (!scripted) return { fen: request.fen, bestmove: null, lines: [] };
    return {
      fen: request.fen,
      bestmove: scripted.bestmove,
      lines: [{ moves: [scripted.bestmove], score: scripted.score }],
      ...(scripted.depth === undefined ? {} : { depth: scripted.depth }),
      ...(scripted.cutByTime === undefined ? {} : { cutByTime: scripted.cutByTime }),
    };
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

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const notificationCount = (): number =>
  (
    db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE kind = 'notification'").get() as {
      n: number;
    }
  ).n;

const runEnds = (): unknown[] =>
  db.prepare("SELECT ended_reason, ended_at FROM training_runs ORDER BY id").all();

const wholeRun = (): unknown => db.prepare("SELECT * FROM training_runs").get();

// Everything a server boot builds that holds memory: a new call is a restart over the same file,
// and a restart ends the runs the last process left open before it serves anything.
function boot(judge?: RepertoireTryJudge, log?: Log): ActivityService {
  endRunsLeftOpenAtStart(db, clock.now().toISOString());
  const session = createCoachSession(db, { promptVersion: "v" });
  const notifications = { sessionId: () => session.id };
  return new ActivityService({
    db,
    game: new GameService({ db, engine: new ScriptedEngine(["e7e5"]) }),
    training: {
      desk: new ReviewDesk({ db, clock, notifications }),
      notifications,
      clock,
      onNotification: () => wakes.push(notificationCount()),
      ...(judge ? { repertoireJudge: judge } : {}),
    },
    ...(log ? { log } : {}),
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
  pass: (number | undefined)[];
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
    // Every move has a card, and every card is due but 3.Bc4's.
    addCards(WIDE_ROWS, (lineText, san) => !(lineText === "e4 e5 Nf3 Nc6" && san === "Bc4"));
    const moves = listRepertoireDrillMoves(db, id);
    const order = [
      "start e4",
      "e5 Nf3",
      "Nc6 Bc4",
      ...WIDE_REPLIES.map(([reply]) => `${reply} d3`),
    ];

    const served = (scope: RepertoireScope): string[] =>
      selectRepertoireDrillMoves(moves, scope, now).map(label);

    expect(served("all")).toEqual(order);
    const due = order.filter((move) => move !== "Nc6 Bc4");
    expect(served("due")).toEqual(due);
    expect(served("recommended")).toEqual(due.slice(0, REPERTOIRE_RECOMMENDED_SIZE));
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

const BC4_LINE = "e4 e5 Nf3 Nc6 Bc4";
const SETUP_LABELS = ["start e4", "e5 Nf3", "Nc6 Bc4"];

// The setup, then the answers to 3...Bc5 and 3...Nf6: two moves to one position that differ only in
// the reply before them.
const SIBLING_ROWS: FixtureRow[] = [
  ...SETUP_ROWS,
  [BC4_LINE, "Bc5", 0.6],
  [BC4_LINE, "Nf6", 0.4],
  [`${BC4_LINE} Bc5`, "c3", 0.6],
  [`${BC4_LINE} Nf6`, "d3", 0.4],
];

// Black's replies to 3.Bc4, the likeliest first. White answers each with 4.d3, which is legal
// against every one of them.
const FAN_REPLIES = [
  "Bc5",
  "Nf6",
  "Be7",
  "d6",
  "h6",
  "a6",
  "g6",
  "Qe7",
  "Na5",
  "Rb8",
  "Qf6",
  "Qg5",
  "Qh4",
  "Ke7",
  "Bd6",
  "Ba3",
  "Nh6",
  "Nge7",
  "a5",
  "b6",
  "b5",
  "d5",
  "f6",
  "f5",
  "g5",
  "h5",
  "Nb8",
];

// The setup and 4.d3 against the first `replies` of FAN_REPLIES: 3 + `replies` moves of White's, each
// reply less likely than the one before it. The rows are stored the least likely first, so that
// storage order is not line order.
function addFanUnit(replies: number): number {
  const answered = FAN_REPLIES.slice(0, replies).map((reply, index): FixtureRow[] => [
    [BC4_LINE, reply, 0.9 - index * 0.03],
    [`${BC4_LINE} ${reply}`, "d3", 0.9 - index * 0.03],
  ]);
  return addVariation("Fan", [...SETUP_ROWS, ...answered.reverse().flat()]);
}

// What a drill of the fan unit serves, in line order: the setup, then 4.d3 against each reply.
const fanLabels = (replies: number): string[] => [
  ...SETUP_LABELS,
  ...FAN_REPLIES.slice(0, replies).map((reply) => `${reply} d3`),
];

const servedBy = (id: number, scope: RepertoireScope): string[] =>
  selectRepertoireDrillMoves(listRepertoireDrillMoves(db, id), scope, now).map(label);

// What each scope serves and what the menu counts, from literal lists. The counts are the sizes of
// those lists, so a move left out of one and left in the other fails here.
function expectServed(id: number, due: string[], all: string[]): void {
  expect(servedBy(id, "due")).toEqual(due);
  expect(servedBy(id, "recommended")).toEqual(due.slice(0, 10));
  expect(servedBy(id, "all")).toEqual(all);
  expect(repertoireScopeCounts(listRepertoireDrillMoves(db, id), now)).toEqual({
    recommended: Math.min(due.length, 10),
    due: due.length,
    all: all.length,
    missed: 0,
  });
}

// The moves the newest run was drawn with, in the order it holds them, named as `label` names them.
function drawnLabels(id: number): string[] {
  const run = db.prepare("SELECT items_json FROM training_runs ORDER BY id DESC LIMIT 1").get() as {
    items_json: string;
  };
  const labelOfRow = new Map(listRepertoireDrillMoves(db, id).map((m) => [m.rowId, label(m)]));
  return (JSON.parse(run.items_json) as { id: number }[]).map((item) => {
    return labelOfRow.get(item.id) as string;
  });
}

describe("a move with no card is due as soon as it is stored", () => {
  it("serves all thirty moves of a new unit for all and for due, and the likeliest ten for recommended", async () => {
    const id = addFanUnit(27);
    const order = fanLabels(27);
    expect(order).toHaveLength(30);

    expectServed(id, order, order);
    expect(repertoireScopeCounts(listRepertoireDrillMoves(db, id), now)).toEqual({
      recommended: 10,
      due: 30,
      all: 30,
      missed: 0,
    });

    const service = boot();
    for (const [scope, served] of [
      ["all", 30],
      ["due", 30],
      ["recommended", 10],
    ] as const) {
      expect(drillOf(await start(service, id, scope)).moves_left).toBe(served);
      expect(drawnLabels(id)).toEqual(order.slice(0, served));
    }
  });

  it("serves a new move together with the new moves that lead to it", () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    const all = [...SETUP_LABELS, "Bc5 c3", "Nf6 d3", "Nf6 d4"];
    expectServed(id, all, all);
  });

  it("serves two new answers to one position, after two different replies, in one drill of due", async () => {
    const id = addVariation("Siblings", SIBLING_ROWS);
    addCards(SETUP_ROWS, () => false);
    expectServed(id, ["Bc5 c3", "Nf6 d3"], [...SETUP_LABELS, "Bc5 c3", "Nf6 d3"]);

    const service = boot();
    let state = await start(service, id, "due");
    expect(drillOf(state)).toMatchObject({
      first_pass: true,
      answer: { san: "c3" },
      moves_left: 2,
    });
    state = await next(service, await play(service, state, "c3"));
    expect(drillOf(state)).toMatchObject({
      first_pass: true,
      answer: { san: "d3" },
      moves_left: 2,
    });
  });

  it("serves a new answer beside a sibling whose card is short of stable", () => {
    const id = addVariation("Siblings", SIBLING_ROWS);
    addCards(SETUP_ROWS, () => false);
    addCard(`${BC4_LINE} Nf6`, "d3", PAST, true, { intervalHours: 24 });
    expectServed(id, ["Bc5 c3", "Nf6 d3"], [...SETUP_LABELS, "Bc5 c3", "Nf6 d3"]);
  });

  it("serves the new moves of a unit however many cards were shown in the last hour", async () => {
    const id = addFanUnit(15);
    const hourAgo = new Date(T0.getTime() - HOUR_MS).toISOString();
    // The setup and 4.d3 against the nine likeliest replies: twelve cards shown in the last hour,
    // none due, so the six moves left are the only ones a drill of due has.
    const shown: [string, string][] = [
      ["", "e4"],
      ["e4 e5", "Nf3"],
      ["e4 e5 Nf3 Nc6", "Bc4"],
      ...FAN_REPLIES.slice(0, 9).map((reply): [string, string] => [`${BC4_LINE} ${reply}`, "d3"]),
    ];
    for (const [lineText, san] of shown) {
      addCard(lineText, san, FUTURE, true, { introducedAt: hourAgo });
    }
    const shownLastHour = db
      .prepare("SELECT COUNT(*) AS n FROM repertoire_cards WHERE introduced_at > ?")
      .get(new Date(T0.getTime() - 2 * HOUR_MS).toISOString()) as { n: number };
    expect(shownLastHour.n).toBe(12);

    const newMoves = FAN_REPLIES.slice(9, 15).map((reply) => `${reply} d3`);
    expectServed(id, newMoves, fanLabels(15));

    const service = boot();
    expect(drillOf(await start(service, id, "due")).moves_left).toBe(6);
    expect(drawnLabels(id)).toEqual(newMoves);
  });
});

const DAY_MS = 24 * HOUR_MS;
const daysBefore = (days: number, from: Date = T0): Date =>
  new Date(from.getTime() - days * DAY_MS);

// The rows a drill's ratings of one card leave in the log, `times` of them at `at`. A miss is a
// rating of Again, the default.
function logRatings(
  lineText: string,
  san: string,
  times: number,
  at: Date,
  options: { grade?: Grade; cardKind?: DrillCardKind } = {},
): void {
  const cardKey = repertoireCardKey(placeOf(lineText, san));
  for (let index = 0; index < times; index++) {
    insertDrillReview(db, {
      cardKind: options.cardKind ?? "repertoire",
      cardKey,
      reviewedAt: at.toISOString(),
      grade: options.grade ?? GRADE.Again,
    });
  }
}

const drillReviewCount = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM drill_reviews").get() as { n: number }).n;

// What a drill of the `missed` scope serves over one variation, in the order it serves them.
const mostMissedOf = (id: number): string[] =>
  selectRepertoireDrillMoves(
    listRepertoireDrillMoves(db, id),
    "missed",
    now,
    readRepertoireMissCounts(db, now),
  ).map(label);

describe("the most missed moves of a repertoire drill", () => {
  it("names the rule's numbers as constants: two misses, thirty days, ten moves", () => {
    expect([
      REPERTOIRE_MISSED_MIN_MISSES,
      REPERTOIRE_MISSED_WINDOW_DAYS,
      REPERTOIRE_MISSED_SIZE,
    ]).toEqual([2, 30, 10]);
  });

  it("serves the moves missed twice or more in the last 30 days, the most missed first, due or not", () => {
    const id = addVariation("Wide", WIDE_ROWS);
    // Every card is known and not due, but 3.Bc4's.
    addCards(WIDE_ROWS, (lineText, san) => lineText === "e4 e5 Nf3 Nc6" && san === "Bc4");
    const recently = daysBefore(2);
    logRatings("", "e4", 2, recently);
    logRatings("e4 e5", "Nf3", 1, recently);
    logRatings("e4 e5 Nf3 Nc6", "Bc4", 3, recently);
    logRatings("e4 e5 Nf3 Nc6 Bc4 Be7", "d3", 4, recently);
    logRatings("e4 e5 Nf3 Nc6 Bc4 h6", "d3", 2, recently);

    // 1.e4 and 4.d3 against 3...h6 are missed as often and not due, and the line order settles it.
    expect(mostMissedOf(id)).toEqual(["Be7 d3", "Nc6 Bc4", "start e4", "h6 d3"]);
  });

  it("breaks a tie in misses by line order, whatever order the moves are stored in", () => {
    // The fan unit stores its rows the least likely first, so the order of storage is not line order.
    const id = addFanUnit(4);
    for (const reply of ["Be7", "Bc5", "d6"]) {
      logRatings(`${BC4_LINE} ${reply}`, "d3", 2, daysBefore(2));
    }

    expect(mostMissedOf(id)).toEqual(["Bc5 d3", "Be7 d3", "d6 d3"]);
  });

  it("leaves out a move missed twice 31 days ago and never since, and one missed once", () => {
    const id = addVariation("Wide", WIDE_ROWS);
    addCards(WIDE_ROWS);
    logRatings("", "e4", 2, daysBefore(31));
    logRatings("e4 e5", "Nf3", 1, daysBefore(2));
    logRatings("e4 e5 Nf3 Nc6", "Bc4", 2, daysBefore(2));
    // Once long ago and once lately is one miss in the window.
    logRatings("e4 e5 Nf3 Nc6 Bc4 Bc5", "d3", 1, daysBefore(31));
    logRatings("e4 e5 Nf3 Nc6 Bc4 Bc5", "d3", 1, daysBefore(2));

    expect(mostMissedOf(id)).toEqual(["Nc6 Bc4"]);
  });

  it("counts the window from the start: its first instant is out, a millisecond later is in, and so is the start itself", () => {
    const id = addVariation("Wide", WIDE_ROWS);
    addCards(WIDE_ROWS);
    const first = daysBefore(REPERTOIRE_MISSED_WINDOW_DAYS);
    logRatings("e4 e5", "Nf3", 2, first);
    logRatings("e4 e5 Nf3 Nc6", "Bc4", 2, new Date(first.getTime() + 1));
    logRatings("e4 e5 Nf3 Nc6 Bc4 Nf6", "d3", 2, T0);
    // A rating after the start is not one of the 30 days before it.
    logRatings("e4 e5 Nf3 Nc6 Bc4 Be7", "d3", 2, new Date(T0.getTime() + 1));

    expect(mostMissedOf(id)).toEqual(["Nc6 Bc4", "Nf6 d3"]);
  });

  it("counts only misses of repertoire cards: no right rating, no found card's miss, no other move's", () => {
    const id = addVariation("Wide", WIDE_ROWS);
    addCards(WIDE_ROWS);
    const recently = daysBefore(2);
    logRatings("", "e4", 2, recently, { grade: GRADE.Good });
    logRatings("e4 e5", "Nf3", 2, recently, { grade: GRADE.Hard });
    logRatings("e4 e5 Nf3 Nc6", "Bc4", 2, recently, { cardKind: "found" });
    // One miss each of two moves is no move missed twice.
    logRatings("e4 e5 Nf3 Nc6 Bc4 Bc5", "d3", 1, recently);
    logRatings("e4 e5 Nf3 Nc6 Bc4 Nf6", "d3", 1, recently);
    logRatings("e4 e5 Nf3 Nc6 Bc4 Be7", "d3", 2, recently);

    expect(mostMissedOf(id)).toEqual(["Be7 d3"]);
  });

  it("serves at most the ten most missed, cutting by the misses and not by the line", () => {
    const id = addVariation("Wide", WIDE_ROWS);
    addCards(WIDE_ROWS);
    const inLineOrder = [
      "start e4",
      "e5 Nf3",
      "Nc6 Bc4",
      ...WIDE_REPLIES.map(([reply]) => `${reply} d3`),
    ];
    // The later a move comes in the line the more it was missed, from two misses up.
    const moves = listRepertoireDrillMoves(db, id).sort(
      (a, b) => b.reach - a.reach || a.ply - b.ply,
    );
    moves.forEach((move, index) => {
      logRatings(
        move.line.join(" "),
        move.san,
        REPERTOIRE_MISSED_MIN_MISSES + index,
        daysBefore(1),
      );
    });
    expect(moves.map(label)).toEqual(inLineOrder);

    const served = mostMissedOf(id);
    expect(served).toHaveLength(REPERTOIRE_MISSED_SIZE);
    expect(served).toEqual(inLineOrder.slice(2).reverse());
  });

  it("serves a move two variations share once, under the misses of its one card", () => {
    const { classical, pianissimo } = addPartingVariations();
    const recently = daysBefore(3);
    logRatings("", "e4", 2, recently);
    logRatings(`${BC4_LINE} Bc5`, "c3", 2, recently);
    logRatings(`${BC4_LINE} Bc5`, "d3", 3, recently);
    const units = [classical, pianissimo].map((id) => ({
      variation: findDrillRepertoire(db, id) as NonNullable<ReturnType<typeof findDrillRepertoire>>,
      moves: listRepertoireDrillMoves(db, id),
    }));

    const served = selectRepertoireDrillMoves(
      mergeRepertoireUnitMoves(units),
      "missed",
      now,
      readRepertoireMissCounts(db, now),
    );

    expect(served.map(label)).toEqual(["Bc5 d3", "start e4", "Bc5 c3"]);
  });

  it("keeps a right first attempt on a card that is not due off its schedule and the log, and rates a miss Again", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, () => false);
    logRatings("", "e4", 2, daysBefore(2));
    logRatings("e4 e5", "Nf3", 2, daysBefore(3));
    const service = boot();
    let state = await start(service, id, "missed");
    expect(drillOf(state)).toMatchObject({ scope: "missed", moves_left: 2 });
    const e4Before = cardOf("", "e4");
    const loggedBefore = drillReviewCount();

    state = await play(service, state, "e4");
    expect(cardOf("", "e4")).toEqual(e4Before);
    expect(drillReviewCount()).toBe(loggedBefore);
    expect(drillOf(state)).toMatchObject({ moves_right: 1, moves_wrong: 0 });

    state = await play(service, state, "a3");
    expect(cardOf("e4 e5", "Nf3")).toMatchObject({
      interval_hours: 10 / 60,
      fsrs_state: 3,
      lapses: 1,
      reviews: 3,
    });
    expect(drillReviewCount()).toBe(loggedBefore + 1);
    expect(db.prepare("SELECT * FROM drill_reviews ORDER BY id DESC LIMIT 1").get()).toMatchObject({
      card_kind: "repertoire",
      card_key: repertoireCardKey(placeOf("e4 e5", "Nf3")),
      reviewed_at: T0.toISOString(),
      grade: GRADE.Again,
    });
    expect(drillOf(state)).toMatchObject({ moves_right: 1, moves_wrong: 1 });
  });

  it("refuses a most missed drill of a level with no such move with empty_queue, leaving a run in progress as it was", async () => {
    const { classical } = addPartingVariations();
    addVariation(MIESES, SCANDINAVIAN_ROWS, SCANDINAVIAN_GROUP);
    logRatings("", "e4", 1, daysBefore(2));
    logRatings("e4 e5", "Nf3", 2, daysBefore(31));
    const service = boot();
    const running = await start(service, classical, "due");

    for (const level of ["variation", "group", "side"] as const) {
      await expect(startAt(service, classical, "missed", level)).rejects.toMatchObject({
        code: "empty_queue",
        message: `no repertoire move was missed ${REPERTOIRE_MISSED_MIN_MISSES} times or more in the last ${REPERTOIRE_MISSED_WINDOW_DAYS} days`,
      });
    }

    expect(training(service.current()).activity_id).toBe(running.activity_id);
    expect(runEnds()).toEqual([{ ended_reason: null, ended_at: null }]);
  });

  it("counts, at every level, the moves a most missed drill of that level serves, the most missed first", async () => {
    const { classical, pianissimo } = addPartingVariations();
    const scandinavian = addVariation(MIESES, SCANDINAVIAN_ROWS, SCANDINAVIAN_GROUP);
    addCard("e4 d5", "exd5", FUTURE);
    const recently = daysBefore(4);
    logRatings("", "e4", 3, recently);
    logRatings("e4 e5", "Nf3", 2, recently);
    logRatings(`${BC4_LINE} Bc5`, "c3", 4, recently);
    logRatings(`${BC4_LINE} Bc5`, "d3", 1, recently);
    logRatings("e4 d5", "exd5", 5, recently);
    const misses = readRepertoireMissCounts(db, now);
    const countOf = (ids: number[]): number | undefined =>
      repertoireScopeCounts(
        mergeRepertoireUnitMoves(
          ids.map((id) => ({
            variation: findDrillRepertoire(db, id) as NonNullable<
              ReturnType<typeof findDrillRepertoire>
            >,
            moves: listRepertoireDrillMoves(db, id),
          })),
        ),
        now,
        misses,
      ).missed;
    const service = boot();
    const left = async (id: number, level: RepertoireLevel): Promise<number> =>
      drillOf(await startAt(service, id, "missed", level)).moves_left;

    // 4.d3 was missed once, so it is in none of them; 2.exd5 is in the side's alone.
    expect([countOf([classical]), await left(classical, "variation")]).toEqual([3, 3]);
    expect(drawnLabels(classical)).toEqual(["Bc5 c3", "start e4", "e5 Nf3"]);
    expect([countOf([pianissimo]), await left(pianissimo, "variation")]).toEqual([2, 2]);
    expect([countOf([classical, pianissimo]), await left(classical, "group")]).toEqual([3, 3]);
    expect([countOf([classical, pianissimo, scandinavian]), await left(classical, "side")]).toEqual(
      [4, 4],
    );
  });

  it("refuses the missed scope for the drill of the positions from the games, with nothing written", async () => {
    const service = boot();

    expect(await code(service.startTraining({ mode: "found", scope: "missed" }))).toBe(
      "invalid_command",
    );

    expect(runEnds()).toEqual([]);
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
    addCards(ITALIAN_ROWS, () => true, false);
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

    // One review each: the schedule they had, moved once by Good for a pass or Again for a miss.
    const stored = {
      fsrs_state: 2 as const,
      stability: 1,
      difficulty: 6.4133,
      learning_step: 0,
      lapses: 0,
      interval_hours: 24,
      last_reviewed_at: new Date(Date.parse(PAST) - 24 * HOUR_MS).toISOString(),
      next_review_at: PAST,
    };
    const reviewed = (grade: 1 | 3) => {
      const schedule = review(stored, grade, T0);
      return { ...schedule, reviews: 3 };
    };
    expect(cardOf("", "e4")).toEqual(reviewed(3));
    expect(cardOf("e4 e5", "Nf3")).toEqual(reviewed(1));
    expect(cardOf("e4 e5 Nf3 Nc6", "Bc4")).toEqual(reviewed(1));
    // A pass stretches the interval and a miss brings the card back in ten minutes.
    expect(reviewed(3)).toMatchObject({ fsrs_state: 2, lapses: 0 });
    expect(reviewed(3).interval_hours).toBeGreaterThan(24);
    expect(reviewed(1)).toMatchObject({ fsrs_state: 3, lapses: 1, interval_hours: 10 / 60 });
    // One row for each first attempt: e4 right, Nf3 wrong, Bc4 hinted, then c3, d4 and d3 right.
    // The retries of Nf3 and Bc4 and the second pass add none.
    expect(loggedDrillGrades()).toEqual([3, 1, 1, 3, 3, 3]);
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
    const failed = { interval_hours: 10 / 60, fsrs_state: 3, lapses: 1, reviews: 3 };
    expect(cardOf("e4 e5", "Nf3")).toMatchObject(failed);
    expect(cardOf("e4 e5 Nf3 Nc6", "Bc4")).toMatchObject(failed);
    // The right move whose card was not due kept its schedule and left no row; the two misses did.
    expect(loggedDrillGrades()).toEqual([1, 1]);
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
    expect(cardOf("", "e4")).toMatchObject({
      fsrs_state: 2,
      reviews: 3,
      last_reviewed_at: now.toISOString(),
    });
    expect(cardOf("", "e4")?.interval_hours).toBeGreaterThan(24);
    expect(loggedDrillGrades()).toEqual([3]);
  });

  it("shows a new move with its answer on its first pass and rates it only on a later one", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    // Every other move is known and not due, so 4.c3 is the one move a recommended drill takes.
    addCardsAllButC3();
    const afterBc5 = "e4 e5 Nf3 Nc6 Bc4 Bc5";
    const service = boot();
    let state = await start(service, id, "recommended");
    expect(drillOf(state)).toMatchObject({
      first_pass: true,
      answer: { uci: "c2c3", san: "c3" },
    });
    expect(cardOf(afterBc5, "c3")).toMatchObject({
      fsrs_state: 0,
      reviews: 0,
      next_review_at: T0.toISOString(),
    });

    state = await play(service, state, "c3");
    expect(cardOf(afterBc5, "c3")).toMatchObject({ fsrs_state: 0, reviews: 0 });
    expect(loggedDrillGrades()).toEqual([]);

    state = await next(service, state);
    expect(state.item).toMatchObject({ position_in_queue: 2 });
    expect(drillOf(state)).toMatchObject({ first_pass: false, answer: null, moves_left: 1 });
    state = await play(service, state, "c3");
    expect(cardOf(afterBc5, "c3")).toMatchObject({ fsrs_state: 1, learning_step: 1, reviews: 1 });
    expect(loggedDrillGrades()).toEqual([3]);
  });

  it("leaves the position open after wrong tries, raising the hint at the third and fourth, and keeps every try", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCard("", "e4", PAST);
    setIdea("", "e4", "Take the centre and free the bishop.");
    const service = boot();
    let state = await start(service, id, "due");
    const expectedKinds = ["none", "none", "piece", "move", "move", "move"] as const;
    for (const [index, san] of ["a3", "b3", "c3", "d3", "h3", "g3"].entries()) {
      state = await play(service, state, san);
      expect(state.input_enabled).toBe(true);
      expect(state.status).toBe("prompt");
      expect(state.last_try).toMatchObject({ san, correct: false });
      expect(drillOf(state)).toMatchObject({
        answer: null,
        hint: { kind: expectedKinds[index] },
        flagged_opening: null,
        flagged_sound: false,
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

  it("answers the first hint with the piece square and hint_square, then the second with the move", async () => {
    expect(RepertoireHintSchema.safeParse({ kind: "none" }).success).toBe(true);
    expect(RepertoireHintSchema.safeParse({ kind: "piece", square: "e2" }).success).toBe(true);
    expect(RepertoireHintSchema.safeParse({ kind: "move", uci: "e2e4", san: "e4" }).success).toBe(
      true,
    );
    expect(RepertoireHintSchema.safeParse({ kind: "idea", text: "Take the centre." }).success).toBe(
      false,
    );

    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4" || san === "Nf3");
    setIdea("", "e4", "Take the centre and free the bishop.");
    setIdea("e4 e5", "Nf3", "Develop and attack e5.");
    const service = boot();
    let state = await start(service, id, "due");
    expect(state.hint_square).toBeNull();

    state = training(await service.trainingHint(state.activity_id));
    expect(drillOf(state).hint).toEqual({ kind: "piece", square: "e2" });
    expect(state.hint_square).toBe("e2");
    expect(drillOf(state).answered).toBeNull();

    state = training(await service.trainingHint(state.activity_id));
    expect(drillOf(state).hint).toEqual({ kind: "move", uci: "e2e4", san: "e4" });
    expect(state.hint_square).toBeNull();
    expect(drillOf(state).answered).toEqual({
      san: "e4",
      idea: "Take the centre and free the bishop.",
      asked: false,
    });

    state = await play(service, state, "e4");
    expect(state.hint_square).toBeNull();
    expect(drillOf(state).hint).toEqual({ kind: "none" });

    state = training(await service.trainingHint(state.activity_id));
    expect(drillOf(state).hint).toEqual({ kind: "piece", square: "g1" });
    expect(state.hint_square).toBe("g1");
    // Answering directly after a piece hint clears the marked square.
    state = await play(service, state, "Nf3");
    expect(state.hint_square).toBeNull();
    expect(drillOf(state).answered).toEqual({
      san: "Nf3",
      idea: "Develop and attack e5.",
      asked: false,
    });

    expect(cardOf("", "e4")).toMatchObject({ fsrs_state: 3, lapses: 1, interval_hours: 10 / 60 });
    expect(cardOf("e4 e5", "Nf3")).toMatchObject({
      fsrs_state: 3,
      lapses: 1,
      interval_hours: 10 / 60,
    });
  });

  it("raises the hint to piece on the third wrong try and to move on the fourth, recording hinted without re-rating", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    setIdea("", "e4", "Take the centre and free the bishop.");
    const itemHinted = (): number =>
      (
        db.prepare("SELECT hinted FROM training_items ORDER BY id DESC LIMIT 1").get() as {
          hinted: number;
        }
      ).hinted;

    const service = boot();
    let state = await start(service, id, "due");

    state = await play(service, state, "a3");
    expect(drillOf(state).hint).toEqual({ kind: "none" });
    expect(state.hint_square).toBeNull();
    expect(drillOf(state).answered).toBeNull();
    expect(itemHinted()).toBe(0);
    const cardAfterFirstWrong = cardOf("", "e4");
    expect(cardAfterFirstWrong).toMatchObject({
      fsrs_state: 3,
      lapses: 1,
      interval_hours: 10 / 60,
    });
    expect(loggedDrillGrades()).toEqual([1]);
    expect(firstAttempts()).toEqual([attemptOf("", "e4", id, 0)]);

    state = await play(service, state, "b3");
    expect(drillOf(state).hint).toEqual({ kind: "none" });
    expect(state.hint_square).toBeNull();
    expect(drillOf(state).answered).toBeNull();
    expect(itemHinted()).toBe(0);

    state = await play(service, state, "c3");
    expect(drillOf(state).hint).toEqual({ kind: "piece", square: "e2" });
    expect(state.hint_square).toBe("e2");
    expect(drillOf(state).answered).toBeNull();
    expect(itemHinted()).toBe(1);
    expect(cardOf("", "e4")).toEqual(cardAfterFirstWrong);
    expect(loggedDrillGrades()).toEqual([1]);
    expect(firstAttempts()).toEqual([attemptOf("", "e4", id, 0)]);

    state = await play(service, state, "d3");
    expect(drillOf(state).hint).toEqual({ kind: "move", uci: "e2e4", san: "e4" });
    expect(state.hint_square).toBeNull();
    expect(drillOf(state).answered).toEqual({
      san: "e4",
      idea: "Take the centre and free the bishop.",
      asked: false,
    });
    expect(itemHinted()).toBe(1);
    expect(cardOf("", "e4")).toEqual(cardAfterFirstWrong);
    expect(loggedDrillGrades()).toEqual([1]);
    expect(firstAttempts()).toEqual([attemptOf("", "e4", id, 0)]);

    state = await play(service, state, "e4");
    expect(state.status).toBe("failed");
    expect(state.hint_square).toBeNull();
  });

  it("raises a pressed piece hint to move on a single wrong try without changing the rating", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    setIdea("", "e4", "Take the centre.");
    const service = boot();
    let state = await start(service, id, "due");

    state = training(await service.trainingHint(state.activity_id));
    expect(drillOf(state).hint).toEqual({ kind: "piece", square: "e2" });
    expect(state.hint_square).toBe("e2");
    expect(drillOf(state).answered).toBeNull();
    const cardAfterHint = cardOf("", "e4");

    state = await play(service, state, "a3");
    expect(drillOf(state).hint).toEqual({ kind: "move", uci: "e2e4", san: "e4" });
    expect(state.hint_square).toBeNull();
    expect(drillOf(state).answered).toEqual({ san: "e4", idea: "Take the centre.", asked: false });
    expect(cardOf("", "e4")).toEqual(cardAfterHint);
    expect(loggedDrillGrades()).toEqual([1]);
    expect(firstAttempts()).toEqual([attemptOf("", "e4", id, 0)]);
  });

  it("counts wrong tries per asked move, not across earlier moves of the same pass", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4" || san === "Nf3");
    const service = boot();
    let state = await start(service, id, "due");

    // Two wrong tries on 1.e4, then right.
    state = await play(service, state, "a3");
    state = await play(service, state, "b3");
    expect(drillOf(state).hint).toEqual({ kind: "none" });
    state = await play(service, state, "e4");
    expect(lineSan(state)).toEqual(["e4", "e5"]);

    // On 2.Nf3, the count starts from zero: two wrong tries keep hint none, third marks g1.
    state = await play(service, state, "a3");
    expect(drillOf(state).hint).toEqual({ kind: "none" });
    expect(state.hint_square).toBeNull();
    state = await play(service, state, "b3");
    expect(drillOf(state).hint).toEqual({ kind: "none" });
    expect(state.hint_square).toBeNull();
    state = await play(service, state, "c3");
    expect(drillOf(state).hint).toEqual({ kind: "piece", square: "g1" });
    expect(state.hint_square).toBe("g1");
    state = await play(service, state, "d3");
    expect(drillOf(state).hint).toEqual({ kind: "move", uci: "g1f3", san: "Nf3" });
    expect(state.hint_square).toBeNull();
  });

  it("raises no hint on a first showing, whether by wrong tries or by the hint command", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCardsAllButC3();
    const afterBc5 = "e4 e5 Nf3 Nc6 Bc4 Bc5";
    setIdea(afterBc5, "c3", "Prepare d4.");
    const itemHinted = (): number =>
      (
        db.prepare("SELECT hinted FROM training_items ORDER BY id DESC LIMIT 1").get() as {
          hinted: number;
        }
      ).hinted;

    const service = boot();
    let state = await start(service, id, "recommended");
    expect(drillOf(state)).toMatchObject({
      first_pass: true,
      answer: { uci: "c2c3", san: "c3" },
      hint: { kind: "none" },
    });

    // Pressing hint on a first showing does nothing.
    state = training(await service.trainingHint(state.activity_id));
    expect(drillOf(state).hint).toEqual({ kind: "none" });
    expect(state.hint_square).toBeNull();
    expect(itemHinted()).toBe(0);

    // Four wrong tries on a first showing raise no hint and keep first_pass intact.
    for (const san of ["a3", "b3", "d3", "h3"]) {
      state = await play(service, state, san);
      expect(drillOf(state)).toMatchObject({
        first_pass: true,
        answer: { uci: "c2c3", san: "c3" },
        hint: { kind: "none" },
      });
      expect(state.hint_square).toBeNull();
      expect(itemHinted()).toBe(0);
    }
    expect(firstAttempts()).toEqual([]);
    expect(loggedDrillGrades()).toEqual([]);
  });

  it("warns on any sound try, naming another opening when known, and leaves a blunder plain", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "Bc4");
    const judge = new FakeRepertoireJudge(
      {
        [keyAfter("e4 e5 Nf3 Nc6", "Bc4")]: "Italian Game",
        [keyAfter("e4 e5 Nf3 Nc6", "Bb5")]: "Ruy Lopez",
        [keyAfter("e4 e5 Nf3 Nc6", "d4")]: "Scotch Game",
      },
      { f1b5: 12, d2d4: 300, a2a3: 20 },
    );
    const service = boot(judge);
    let state = await start(service, id, "due");
    expect(lineSan(state)).toEqual(["e4", "e5", "Nf3", "Nc6"]);
    expect(drillOf(state).opening_name).toBe("King's Pawn Game");

    state = await play(service, state, "Bb5");
    expect(drillOf(state)).toMatchObject({ flagged_opening: null, flagged_sound: false });
    await flushMicrotasks();
    state = training(service.current());
    expect(drillOf(state)).toMatchObject({ flagged_opening: "Ruy Lopez", flagged_sound: true });
    expect(state.input_enabled).toBe(true);

    state = await play(service, state, "d4");
    expect(drillOf(state)).toMatchObject({ flagged_opening: null, flagged_sound: false });
    await flushMicrotasks();
    state = training(service.current());
    expect(drillOf(state)).toMatchObject({ flagged_opening: null, flagged_sound: false });

    state = await play(service, state, "a3");
    await flushMicrotasks();
    state = training(service.current());
    expect(drillOf(state)).toMatchObject({ flagged_opening: null, flagged_sound: true });

    state = await play(service, state, "h3");
    await flushMicrotasks();
    state = training(service.current());
    expect(drillOf(state)).toMatchObject({ flagged_opening: null, flagged_sound: false });
    expect(judge.searched).toEqual(["f1b5", "d2d4", "a2a3", "h2h3"]);
  });

  it("ends the drill when the board moves on while a wrong try waits on the engine, and the late flag changes nothing", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "Bc4");
    const gameId = addFinishedGame();
    const judge = new GatedRepertoireJudge(RUY_LOPEZ_JUDGE_NAMES(), {});
    const service = boot(judge);
    const state = await start(service, id, "due");

    const tried = training(await service.trainingTry(uciOf(state.fen, "Bb5"), state.activity_id));
    expect(tried.last_try).toMatchObject({ san: "Bb5", correct: false });
    expect(drillOf(tried)).toMatchObject({ flagged_opening: null, flagged_sound: false });
    expect(judge.searched).toEqual(["f1b5"]);

    const board = await service.openGame(gameId);
    const leftRow = wholeRun();
    expect(runEnds()).toEqual([{ ended_reason: "left", ended_at: T0.toISOString() }]);

    now = new Date(T0.getTime() + HOUR_MS);
    judge.release(12);
    await flushMicrotasks();

    expect(service.current()).toBe(board);
    expect(wholeRun()).toEqual(leftRow);
    expect(db.prepare("SELECT uci, correct FROM training_tries").all()).toEqual([
      { uci: "f1b5", correct: 0 },
    ]);
    expect(cardOf("e4 e5 Nf3 Nc6", "Bc4")).toMatchObject({
      fsrs_state: 3,
      lapses: 1,
      interval_hours: 10 / 60,
    });
  });

  it("leaves a board opened in the same tick as a move on the board, with the drill ended as left", async () => {
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
    expect(db.prepare("SELECT solved, ended_reason FROM training_runs").all()).toEqual([
      { solved: 1, ended_reason: "left" },
    ]);
    expect(db.prepare("SELECT uci, correct FROM training_tries").all()).toEqual([
      { uci: "e2e4", correct: 1 },
    ]);
  });

  it("gives up on the warning when the engine is slower than its budget, and keeps the try", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "Bc4");
    const judge = new GatedRepertoireJudge(RUY_LOPEZ_JUDGE_NAMES(), {});
    const service = boot(judge);
    const state = await start(service, id, "due");
    vi.useFakeTimers();
    try {
      const immediate = training(
        await service.trainingTry(uciOf(state.fen, "Bb5"), state.activity_id),
      );
      expect(judge.searched).toEqual(["f1b5"]);
      expect(drillOf(immediate)).toMatchObject({ flagged_opening: null, flagged_sound: false });
      expect(immediate.last_try).toMatchObject({ san: "Bb5", correct: false });
      expect(immediate.input_enabled).toBe(true);

      await vi.advanceTimersByTimeAsync(REPERTOIRE_FLAG_BUDGET_MS);
      judge.release(10);
      await flushMicrotasks();

      const after = training(service.current());
      expect(drillOf(after)).toMatchObject({ flagged_opening: null, flagged_sound: false });
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

  it("refuses a drill with nothing due in its scope, and serves every move for all", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, () => false);
    const service = boot();
    expect(await code(start(service, id, "due"))).toBe("empty_queue");
    expect(await code(start(service, id, "recommended"))).toBe("empty_queue");
    expect((await start(service, id, "all")).repertoire?.moves_left).toBe(6);
  });

  it("ends a repertoire drill as left when the server starts", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS);
    const first = boot();
    let state = await start(first, id, "recommended");
    for (const san of ["e4", "Nf3", "Bc4"]) state = await play(first, state, san);
    expect(runEnds()).toEqual([{ ended_reason: null, ended_at: null }]);

    now = new Date(T0.getTime() + HOUR_MS);
    const second = boot();
    expect(second.current()).toBeNull();
    expect(runEnds()).toEqual([{ ended_reason: "left", ended_at: now.toISOString() }]);
    // What was answered stays rated, and the moves not reached stay due.
    expect(cardOf("", "e4")).toMatchObject({ reviews: 3, last_reviewed_at: T0.toISOString() });
    expect(cardOf("e4 e5 Nf3 Nc6 Bc4 Bc5", "c3")).toMatchObject({
      reviews: 2,
      next_review_at: PAST,
    });

    const fresh = await start(second, id, "all");
    expect(fresh.input_enabled).toBe(true);
    expect(runEnds()).toEqual([
      { ended_reason: "left", ended_at: now.toISOString() },
      { ended_reason: null, ended_at: null },
    ]);
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

describe("rating a repertoire move", () => {
  it("leaves a missed move's card alone on its retries, missed again or right after the fail interval", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    const service = boot();
    let state = await start(service, id, "due");
    state = await play(service, state, "h3");
    state = await play(service, state, "e4");
    const failed = cardOf("", "e4");
    expect(failed).toMatchObject({ interval_hours: 10 / 60, fsrs_state: 3, lapses: 1, reviews: 3 });

    state = await next(service, state);
    state = await play(service, state, "a3");
    expect(cardOf("", "e4")).toEqual(failed);
    state = await play(service, state, "e4");
    // Thirty hours on, the fail's four-hour interval is over and the card is due again.
    now = new Date(T0.getTime() + 30 * HOUR_MS);
    state = await next(service, state);
    state = await play(service, state, "e4");
    expect(cardOf("", "e4")).toEqual(failed);
    state = await next(service, state);
    expect(drillOf(state).result).toEqual({ practised: 1, first_try_right: 0 });
  });

  it("shows the move on show_solution and fails it, so playing it then is not right at the first try", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    const service = boot();
    let state = await start(service, id, "due");
    state = training(await service.trainingShowSolution(state.activity_id));
    expect(drillOf(state).hint).toEqual({ kind: "move", uci: "e2e4", san: "e4" });
    expect(state.input_enabled).toBe(true);
    expect(cardOf("", "e4")).toMatchObject({
      interval_hours: 10 / 60,
      fsrs_state: 3,
      lapses: 1,
      reviews: 3,
    });

    state = await play(service, state, "e4");
    expect(state.status).toBe("failed");
    expect(drillOf(state)).toMatchObject({ moves_left: 1, moves_right: 0, moves_wrong: 1 });
  });
});

describe("recording the first attempts of a repertoire drill", () => {
  it("writes a row for a move got right, one for a wrong try and one for a hint, under the variation in play", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4" || san === "Nf3" || san === "Bc4");
    const service = boot();
    let state = await start(service, id, "due");
    state = await play(service, state, "e4");
    now = new Date(T0.getTime() + HOUR_MS);
    state = await play(service, state, "h3");
    state = await play(service, state, "Nf3");
    now = new Date(T0.getTime() + 2 * HOUR_MS);
    training(await service.trainingHint(state.activity_id));
    state = await play(service, state, "Bc4");

    // Each row is stamped when its move was rated, so the three differ.
    expect(firstAttempts()).toEqual([
      attemptOf("", "e4", id, 1),
      attemptOf("e4 e5", "Nf3", id, 0, new Date(T0.getTime() + HOUR_MS)),
      attemptOf("e4 e5 Nf3 Nc6", "Bc4", id, 0, new Date(T0.getTime() + 2 * HOUR_MS)),
    ]);
  });

  it("writes a miss when the first thing done at a move is a hint or a shown solution", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4" || san === "Nf3");
    const service = boot();
    let state = await start(service, id, "due");
    state = training(await service.trainingShowSolution(state.activity_id));
    state = await play(service, state, "e4");
    state = training(await service.trainingHint(state.activity_id));
    state = await play(service, state, "Nf3");

    expect(firstAttempts()).toEqual([attemptOf("", "e4", id, 0), attemptOf("e4 e5", "Nf3", id, 0)]);
  });

  it("writes one row for a move however many tries it takes, and none for its retries", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    const service = boot();
    let state = await start(service, id, "due");
    for (const san of ["a3", "b3", "h3"]) state = await play(service, state, san);
    training(await service.trainingHint(state.activity_id));
    training(await service.trainingShowSolution(state.activity_id));
    state = await play(service, state, "e4");
    expect(firstAttempts()).toEqual([attemptOf("", "e4", id, 0)]);

    // The missed move comes back on the next pass; getting it right there rates nothing new.
    state = await next(service, state);
    state = await play(service, state, "e4");
    expect(firstAttempts()).toEqual([attemptOf("", "e4", id, 0)]);
  });

  it("writes no row for a move shown with its answer, and one when a later pass rates it", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    // Every other move is known and not due, so 4.c3 is the one move a recommended drill takes.
    addCardsAllButC3();
    const service = boot();
    let state = await start(service, id, "recommended");
    expect(drillOf(state).first_pass).toBe(true);
    state = await play(service, state, "h3");
    state = await play(service, state, "c3");
    expect(firstAttempts()).toEqual([]);

    now = new Date(T0.getTime() + HOUR_MS);
    state = await next(service, state);
    expect(drillOf(state).first_pass).toBe(false);
    state = await play(service, state, "c3");
    expect(firstAttempts()).toEqual([
      attemptOf("e4 e5 Nf3 Nc6 Bc4 Bc5", "c3", id, 1, new Date(T0.getTime() + HOUR_MS)),
    ]);
  });

  it("writes a row for a right move that keeps its schedule because it was not due", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, () => false);
    const stored = cardOf("", "e4");
    const service = boot();
    const state = await start(service, id, "all");
    await play(service, state, "e4");

    expect(cardOf("", "e4")).toEqual(stored);
    expect(firstAttempts()).toEqual([attemptOf("", "e4", id, 1)]);
  });

  it("records each move of a drill widened to an opening under its own variation", async () => {
    const { classical, pianissimo } = addPartingVariations();
    const service = boot();
    let state = await startAt(service, classical, "due", "group");
    for (const san of ["e4", "Nf3", "Bc4", "c3"]) state = await play(service, state, san);
    // The second variation's move is asked on the next pass, where c3 is the other one's answer.
    state = await next(service, state);
    expect(variationOf(state)?.id).toBe(pianissimo);
    state = await play(service, state, "c3");
    state = await play(service, state, "d3");

    const parted = "e4 e5 Nf3 Nc6 Bc4 Bc5";
    expect(firstAttempts()).toEqual([
      attemptOf("", "e4", classical, 1),
      attemptOf("e4 e5", "Nf3", classical, 1),
      attemptOf("e4 e5 Nf3 Nc6", "Bc4", classical, 1),
      attemptOf(parted, "c3", classical, 1),
      attemptOf(parted, "d3", pianissimo, 0),
    ]);
  });

  it("returns the count of the moves a drill rated and how many were right first time", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, () => true, false);
    const service = boot();
    let state = await start(service, id, "due");
    state = await play(service, state, "e4");
    state = await play(service, state, "h3");
    state = await play(service, state, "Nf3");
    training(await service.trainingHint(state.activity_id));
    state = await play(service, state, "Bc4");
    for (const san of ["c3", "d4"]) state = await play(service, state, san);
    state = await next(service, state);
    state = await play(service, state, "d3");
    state = await next(service, state);
    for (const san of ["Nf3", "Bc4"]) state = await play(service, state, san);

    // Six moves were rated: e4, c3, d4 and d3 right first time, Nf3 and Bc4 not; the retries add none.
    expect(firstAttempts()).toHaveLength(6);
    expect(countRepertoireFirstAttemptsInWindow(db, id, now)).toEqual({ attempts: 6, right: 4 });
  });

  describe("beside the card's schedule", () => {
    it("rolls the card back when the attempt cannot be written", async () => {
      const id = addVariation("Classical", ITALIAN_ROWS);
      addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
      const service = boot();
      const state = await start(service, id, "due");
      const stored = cardOf("", "e4");
      db.exec(
        `CREATE TRIGGER refuse_first_attempt BEFORE INSERT ON repertoire_first_attempts
         BEGIN SELECT RAISE(ABORT, 'first attempt refused'); END`,
      );

      await expect(play(service, state, "e4")).rejects.toThrow("first attempt refused");
      expect(cardOf("", "e4")).toEqual(stored);
    });

    it("writes no attempt when the card cannot be moved", async () => {
      const id = addVariation("Classical", ITALIAN_ROWS);
      addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
      const service = boot();
      const state = await start(service, id, "due");
      db.exec(
        `CREATE TRIGGER refuse_card_review BEFORE UPDATE ON repertoire_cards
         BEGIN SELECT RAISE(ABORT, 'card review refused'); END`,
      );

      await expect(play(service, state, "e4")).rejects.toThrow("card review refused");
      expect(firstAttempts()).toEqual([]);
    });
  });
});

describe("flagging a repertoire try", () => {
  it("warns without naming an opening when a sound try reaches the expected line's own opening", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "c3" || san === "d4");
    // A table that gives 4.c3 and 4.d3 one name, and none to 5.d4, which the line calls the
    // Italian Game.
    const judge = new FakeRepertoireJudge(
      {
        [keyAfter("e4 e5 Nf3 Nc6 Bc4 Bc5", "c3")]: "Giuoco Piano",
        [keyAfter("e4 e5 Nf3 Nc6 Bc4 Bc5", "d3")]: "Giuoco Piano",
        [keyAfter("e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6", "d3")]: "Italian Game",
      },
      { d2d3: 10, a2a3: 1000 },
    );
    const service = boot(judge);
    let state = await start(service, id, "due");
    expect(lineSan(state)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);

    state = await play(service, state, "d3");
    await flushMicrotasks();
    state = training(service.current());
    expect(drillOf(state)).toMatchObject({ flagged_opening: null, flagged_sound: true });

    state = await play(service, state, "c3");
    expect(lineSan(state)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6"]);
    state = await play(service, state, "d3");
    await flushMicrotasks();
    state = training(service.current());
    expect(drillOf(state)).toMatchObject({ flagged_opening: null, flagged_sound: true });

    state = await play(service, state, "a3");
    await flushMicrotasks();
    state = training(service.current());
    expect(drillOf(state)).toMatchObject({ flagged_opening: null, flagged_sound: false });
    expect(judge.searched).toEqual(["d2d3", "d2d3", "a2a3"]);
  });

  it("warns on a try that loses exactly the margin, and not one that loses a centipawn more", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "Bc4");
    const judge = new FakeRepertoireJudge(
      { ...RUY_LOPEZ_JUDGE_NAMES(), [keyAfter("e4 e5 Nf3 Nc6", "d4")]: "Scotch Game" },
      {
        f1b5: REPERTOIRE_FLAG_CP,
        d2d4: REPERTOIRE_FLAG_CP + 1,
        a2a3: REPERTOIRE_FLAG_CP,
        h2h3: REPERTOIRE_FLAG_CP + 1,
      },
    );
    const service = boot(judge);
    let state = await start(service, id, "due");

    state = await play(service, state, "Bb5");
    await flushMicrotasks();
    expect(drillOf(training(service.current()))).toMatchObject({
      flagged_opening: "Ruy Lopez",
      flagged_sound: true,
    });

    state = await play(service, state, "d4");
    await flushMicrotasks();
    expect(drillOf(training(service.current()))).toMatchObject({
      flagged_opening: null,
      flagged_sound: false,
    });

    state = await play(service, state, "a3");
    await flushMicrotasks();
    expect(drillOf(training(service.current()))).toMatchObject({
      flagged_opening: null,
      flagged_sound: true,
    });

    state = await play(service, state, "h3");
    await flushMicrotasks();
    expect(drillOf(training(service.current()))).toMatchObject({
      flagged_opening: null,
      flagged_sound: false,
    });
    expect(judge.searched).toEqual(["f1b5", "d2d4", "a2a3", "h2h3"]);
  });

  it("publishes the wrong try before the engine finishes, then delivers the sound-move warning later", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "Bc4");
    const judge = new GatedRepertoireJudge({}, {});
    const service = boot(judge);
    const published: TrainingActivity[] = [];
    service.onState((s) => {
      if (s?.kind === "training") published.push(s);
    });
    const state = await start(service, id, "due");
    published.length = 0;

    const immediate = training(
      await service.trainingTry(uciOf(state.fen, "a3"), state.activity_id),
    );
    expect(judge.searched).toEqual(["a2a3"]);
    expect(published).toHaveLength(1);
    expect(immediate).toBe(published[0]);
    expect(immediate.last_try).toEqual({ uci: "a2a3", san: "a3", correct: false });
    expect(immediate.tries).toBe(1);
    expect(drillOf(immediate)).toMatchObject({ flagged_opening: null, flagged_sound: false });

    judge.release(15);
    await settle(() => published.length === 2);
    expect(published).toHaveLength(2);
    const warned = published[1] as TrainingActivity;
    expect(warned.last_try).toEqual({ uci: "a2a3", san: "a3", correct: false });
    expect(warned.tries).toBe(1);
    expect(drillOf(warned)).toMatchObject({ flagged_opening: null, flagged_sound: true });
    expect(service.current()).toBe(warned);
  });

  it("ignores a late engine answer once another try or the right move follows", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "Bc4" || san === "c3");
    const judge = new GatedRepertoireJudge({}, {});
    const service = boot(judge);
    const state = await start(service, id, "due");

    await play(service, state, "a3");
    await play(service, state, "h3");
    expect(judge.searched).toEqual(["a2a3", "h2h3"]);

    judge.releaseNext(10);
    await flushMicrotasks();
    expect(drillOf(training(service.current()))).toMatchObject({
      flagged_opening: null,
      flagged_sound: false,
    });

    judge.releaseNext(1000);
    await flushMicrotasks();
    expect(drillOf(training(service.current()))).toMatchObject({
      flagged_opening: null,
      flagged_sound: false,
    });

    await play(service, training(service.current()), "a3");
    const afterRight = await play(service, training(service.current()), "Bc4");
    judge.releaseNext(10);
    await flushMicrotasks();
    expect(drillOf(training(service.current()))).toMatchObject({
      flagged_opening: null,
      flagged_sound: false,
    });
    expect(afterRight.last_try).toMatchObject({ san: "Bc4", correct: true });
  });

  it("rates a sound unnamed wrong try as a miss and brings the move back on a later pass", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "Bc4");
    const judge = new FakeRepertoireJudge({}, { a2a3: 15 });
    const service = boot(judge);
    let state = await start(service, id, "due");

    state = await play(service, state, "a3");
    await flushMicrotasks();
    state = training(service.current());
    expect(drillOf(state)).toMatchObject({
      flagged_opening: null,
      flagged_sound: true,
      moves_wrong: 1,
      moves_left: 1,
    });
    expect(cardOf("e4 e5 Nf3 Nc6", "Bc4")).toMatchObject({
      fsrs_state: 3,
      lapses: 1,
      interval_hours: 10 / 60,
    });
    expect(firstAttempts()).toEqual([attemptOf("e4 e5 Nf3 Nc6", "Bc4", id, 0)]);

    state = await play(service, state, "Bc4");
    expect(cardOf("e4 e5 Nf3 Nc6", "Bc4")).toMatchObject({
      fsrs_state: 3,
      lapses: 1,
      interval_hours: 10 / 60,
    });

    state = await next(service, state);
    expect(state.item).toMatchObject({ position_in_queue: 2 });
    expect(drillOf(state)).toMatchObject({ first_pass: false, answer: null, moves_left: 1 });
    state = await play(service, state, "Bc4");
    expect(drillOf(state)).toMatchObject({ moves_left: 0 });
    expect(cardOf("e4 e5 Nf3 Nc6", "Bc4")).toMatchObject({
      fsrs_state: 3,
      lapses: 1,
      reviews: 3,
    });
    state = await next(service, state);
    expect(drillOf(state).result).toEqual({ practised: 1, first_try_right: 0 });
    expect(firstAttempts()).toEqual([attemptOf("e4 e5 Nf3 Nc6", "Bc4", id, 0)]);
  });

  it("leaves a try unflagged when the engine search fails, and still answers with the drill", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "Bc4");
    const judge = new FailingRepertoireJudge(RUY_LOPEZ_JUDGE_NAMES(), {});
    const service = boot(judge);
    let state = await start(service, id, "due");
    state = await play(service, state, "Bb5");
    await flushMicrotasks();
    expect(judge.searched).toEqual(["f1b5"]);
    expect(state.last_try).toMatchObject({ san: "Bb5", correct: false });
    expect(drillOf(training(service.current()))).toMatchObject({
      flagged_opening: null,
      flagged_sound: false,
    });
    expect(state.input_enabled).toBe(true);
    expect(service.current()).toBe(state);
  });

  it("caps both searches of the real judge at 2000 ms", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "Bc4");
    const engine = new RecordingDrillEngine();
    const service = boot(repertoireTryJudge(NO_OPENING_NAMES, engine));
    const state = await start(service, id, "due");
    engine.write(positionKey(state.fen), "f1c4", 30);
    engine.write(keyAfter("e4 e5 Nf3 Nc6", "a3"), "a7a6", -15);

    await play(service, state, "a3");
    await flushMicrotasks();

    expect(engine.requests).toHaveLength(2);
    expect(engine.requests.map((request) => request.capMs)).toEqual([2000, 2000]);
  });

  it("flags a sound try and leaves a blunder plain when the engine's answers are cut by time", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "Bc4");
    const names = parseOpeningTable(
      [
        "eco\tname\tpgn\tuci\tepd",
        `C50\tItalian Game\t-\t-\t${keyAfter("e4 e5 Nf3 Nc6", "Bc4")}`,
        `C60\tRuy Lopez\t-\t-\t${keyAfter("e4 e5 Nf3 Nc6", "Bb5")}`,
        `C44\tScotch Game\t-\t-\t${keyAfter("e4 e5 Nf3 Nc6", "d4")}`,
      ].join("\n"),
    );
    const engine = new RecordingDrillEngine();
    const service = boot(repertoireTryJudge(names, engine));
    let state = await start(service, id, "due");
    engine.write(positionKey(state.fen), "f1c4", 30, { depth: 8, cutByTime: true });
    engine.write(keyAfter("e4 e5 Nf3 Nc6", "Bb5"), "a7a6", -10, { depth: 8, cutByTime: true });
    engine.write(keyAfter("e4 e5 Nf3 Nc6", "d4"), "e5d4", 70, { depth: 8, cutByTime: true });

    state = await play(service, state, "Bb5");
    await flushMicrotasks();
    expect(drillOf(training(service.current()))).toMatchObject({
      flagged_opening: "Ruy Lopez",
      flagged_sound: true,
    });

    state = await play(service, training(service.current()), "d4");
    await flushMicrotasks();
    expect(drillOf(training(service.current()))).toMatchObject({
      flagged_opening: null,
      flagged_sound: false,
    });
    expect(engine.requests.map((request) => request.capMs)).toEqual([2000, 2000, 2000, 2000]);
  });
});

describe("the run of a repertoire drill", () => {
  it("closes its run when it finishes, and wakes the coach once the summary is written", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    const service = boot();
    let state = await start(service, id, "due");
    state = await play(service, state, "e4");
    expect(wakes).toEqual([]);
    state = await next(service, state);
    expect(drillOf(state).result).toEqual({ practised: 1, first_try_right: 1 });
    expect(wakes).toEqual([1]);
    expect(runEnds()).toEqual([{ ended_reason: "finished", ended_at: T0.toISOString() }]);
  });

  it("ends its run on end_training", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS);
    const service = boot();
    const state = await play(service, await start(service, id, "due"), "e4");
    expect(await service.endTraining(state.activity_id)).toBeNull();
    expect(runEnds()).toEqual([{ ended_reason: "ended", ended_at: T0.toISOString() }]);
  });

  it("ends the drill on the board as replaced when a new one starts, and never rewrites that reason", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS);
    const service = boot();
    await play(service, await start(service, id, "due"), "e4");

    await start(service, id, "all");
    expect(runEnds()).toEqual([
      { ended_reason: "replaced", ended_at: T0.toISOString() },
      { ended_reason: null, ended_at: null },
    ]);
    await service.openGame(addFinishedGame());
    expect(runEnds()).toEqual([
      { ended_reason: "replaced", ended_at: T0.toISOString() },
      { ended_reason: "left", ended_at: T0.toISOString() },
    ]);
  });
});

describe("refusing a repertoire command", () => {
  it("refuses a drill without a repertoire or a scope, or of an unknown repertoire, while moves are due", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS);
    const service = boot();
    const unchosen = {
      code: "empty_queue",
      message: expect.stringContaining("choose a repertoire and a scope"),
    };
    await expect(service.startTraining({ mode: "repertoire", scope: "due" })).rejects.toMatchObject(
      unchosen,
    );
    await expect(
      service.startTraining({ mode: "repertoire", repertoireId: id }),
    ).rejects.toMatchObject(unchosen);
    await expect(start(service, id + 1, "due")).rejects.toMatchObject({
      code: "empty_queue",
      message: `repertoire ${id + 1} does not exist`,
    });
    expect(service.current()).toBeNull();
    expect(runEnds()).toEqual([]);
  });

  it("refuses an illegal try and keeps no row of it", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    const service = boot();
    const state = await start(service, id, "due");
    expect(await code(service.trainingTry("e2e5", state.activity_id))).toBe("illegal_move");
    expect(db.prepare("SELECT COUNT(*) AS n FROM training_tries").get()).toEqual({ n: 0 });
    expect(training(service.current())).toMatchObject({ tries: 0, input_enabled: true });
  });

  it("refuses a scratch move, a rating, and every step taken out of turn", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    const service = boot();
    let state = await start(service, id, "due");
    const at = state.activity_id;
    expect(await code(service.trainingExplore({ kind: "move", uci: "e2e4" }, at))).toBe(
      "not_exploring",
    );
    expect(await code(service.rateCard("repertoire", 4, at))).toBe("exposure_unknown");
    expect(await code(service.nextTrainingItem(at))).toBe("item_unfinished");

    state = await play(service, state, "e4");
    expect(state.input_enabled).toBe(false);
    expect(await code(service.trainingTry("e7e5", at))).toBe("item_finished");
    expect(await code(service.trainingHint(at))).toBe("item_finished");
    expect(await code(service.trainingShowSolution(at))).toBe("item_finished");

    state = await next(service, state);
    expect(drillOf(state).result).toEqual({ practised: 1, first_try_right: 1 });
    expect(await code(service.nextTrainingItem(at))).toBe("item_finished");
  });

  it("ties a chat line to the open pass, and none to the pass once it is over", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    const service = boot();
    const session = createCoachSession(db, { promptVersion: "v" });
    const say = (text: string): number => {
      const row = appendChatMessage(
        db,
        session.id,
        { role: "user", kind: "text", contentJson: JSON.stringify({ text }) },
        clock,
      );
      service.linkUserMessage(row.id);
      return row.id;
    };
    const state = await start(service, id, "due");
    const during = say("why not d4 first?");
    await play(service, state, "e4");
    say("that one I knew");
    expect(db.prepare("SELECT message_id FROM item_messages").all()).toEqual([
      { message_id: during },
    ]);
  });
});

// Two Italian variations that part at 3...Bc5, 4.c3 in one and 4.d3 in the other, and a unit of
// another opening: three White moves the Italians share, one of their own each, and two moves of
// the Scandinavian, whose 1.e4 is the same move as theirs.
const partingRows = (answer: string): FixtureRow[] => [
  ...SETUP_ROWS,
  ["e4 e5 Nf3 Nc6 Bc4", "Bc5", 0.6],
  ["e4 e5 Nf3 Nc6 Bc4 Bc5", answer, 0.6],
];
const CLASSICAL_ROWS = partingRows("c3");
const PIANISSIMO_ROWS = partingRows("d3");
const SCANDINAVIAN_ROWS: FixtureRow[] = [
  ["", "e4", 1],
  ["e4", "d5", 1],
  ["e4 d5", "exd5", 1],
];
const CLASSICAL = "Classical Variation (4.c3)";
const PIANISSIMO = "Giuoco Pianissimo (4.d3)";
const MIESES = "Mieses-Kotroc Variation (2.exd5)";

function addPartingVariations(): { classical: number; pianissimo: number } {
  const classical = addVariation(CLASSICAL, CLASSICAL_ROWS);
  const pianissimo = addVariation(PIANISSIMO, PIANISSIMO_ROWS);
  addCards(CLASSICAL_ROWS);
  addCard("e4 e5 Nf3 Nc6 Bc4 Bc5", "d3", PAST);
  return { classical, pianissimo };
}

async function startAt(
  service: ActivityService,
  repertoireId: number,
  scope: RepertoireScope,
  level: RepertoireLevel,
): Promise<TrainingActivity> {
  return training(await service.startTraining({ mode: "repertoire", repertoireId, scope, level }));
}

// The variation the board names for the move in play, on the item and on the drill.
const variationOf = (state: TrainingActivity) =>
  state.item.kind === "repertoire"
    ? {
        id: state.item.repertoire_id,
        name: state.item.variation_name,
        drill: drillOf(state).repertoire_id,
      }
    : null;

describe("merging the moves of several variations", () => {
  it("keeps a shared move under the variation where it is likelier, the older one at equal reach", () => {
    const at = (reach: number): FixtureRow[] => [
      ...SETUP_ROWS,
      ["e4 e5 Nf3 Nc6 Bc4", "Bc5", reach],
      ["e4 e5 Nf3 Nc6 Bc4 Bc5", "c3", reach],
    ];
    const units = [addVariation("Older", at(0.3)), addVariation("Newer", at(0.5))].map((id) => ({
      variation: findDrillRepertoire(db, id) as NonNullable<ReturnType<typeof findDrillRepertoire>>,
      moves: listRepertoireDrillMoves(db, id),
    }));
    expect(
      mergeRepertoireUnitMoves(units).map((move) => [label(move), move.variation.variation_name]),
    ).toEqual([
      ["start e4", "Older"],
      ["e5 Nf3", "Older"],
      ["Nc6 Bc4", "Older"],
      ["Bc5 c3", "Newer"],
    ]);
  });

  // Where two variations answer one position differently, a drill over both serves both answers and
  // a drill over one serves its own.
  it("serves the new answers of two variations to one position together where a drill covers both", () => {
    const classical = addVariation(CLASSICAL, CLASSICAL_ROWS);
    const pianissimo = addVariation(PIANISSIMO, PIANISSIMO_ROWS);
    addCards(SETUP_ROWS, () => false);
    const units = [classical, pianissimo].map((id) => ({
      variation: findDrillRepertoire(db, id) as NonNullable<ReturnType<typeof findDrillRepertoire>>,
      moves: listRepertoireDrillMoves(db, id),
    }));

    expect(
      selectRepertoireDrillMoves(mergeRepertoireUnitMoves(units), "due", now).map((move) => [
        label(move),
        move.variation.variation_name,
      ]),
    ).toEqual([
      ["Bc5 c3", CLASSICAL],
      ["Bc5 d3", PIANISSIMO],
    ]);
    expect(servedBy(classical, "due")).toEqual(["Bc5 c3"]);
    expect(servedBy(pianissimo, "due")).toEqual(["Bc5 d3"]);
  });
});

describe("a drill over a group or a side", () => {
  it("drills both variations of a group, each move under its own variation and a shared move once", async () => {
    const { classical, pianissimo } = addPartingVariations();
    const service = boot();
    let state = await startAt(service, classical, "due", "group");
    expect(drillOf(state)).toMatchObject({ level: "group", moves_left: 5 });
    expect(variationOf(state)).toEqual({ id: classical, name: CLASSICAL, drill: classical });

    for (const san of ["e4", "Nf3", "Bc4"]) state = await play(service, state, san);
    expect(lineSan(state)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
    state = await play(service, state, "c3");
    expect(state.status).toBe("solved");

    // The next pass plays the shared moves itself and stops on the other variation's move there.
    state = await next(service, state);
    expect(lineSan(state)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
    expect(whoPlayed(state).every((by) => by === "reply")).toBe(true);
    expect(variationOf(state)).toEqual({ id: pianissimo, name: PIANISSIMO, drill: pianissimo });
    expect(drillOf(state).moves_left).toBe(1);

    // The first variation's move is wrong where the board names the second.
    state = await play(service, state, "c3");
    expect(state.input_enabled).toBe(true);
    expect(state.last_try).toMatchObject({ san: "c3", correct: false });
    state = await play(service, state, "d3");
    state = await next(service, state);
    state = await play(service, state, "d3");
    state = await next(service, state);
    expect(drillOf(state).result).toEqual({ practised: 5, first_try_right: 4 });
  });

  it("serves one variation, its group or its whole side, whichever level the drill starts at", async () => {
    const { classical } = addPartingVariations();
    const scandinavian = addVariation(MIESES, SCANDINAVIAN_ROWS, "Scandinavian Defense");
    addCard("e4 d5", "exd5", PAST);
    const service = boot();
    const left = async (id: number, level: RepertoireLevel): Promise<number> =>
      drillOf(await startAt(service, id, "due", level)).moves_left;

    expect(await left(classical, "variation")).toBe(4);
    expect(await left(classical, "group")).toBe(5);
    expect(await left(scandinavian, "group")).toBe(2);
    expect(await left(scandinavian, "side")).toBe(6);
    expect(await left(classical, "side")).toBe(6);
  });

  it("names another opening's variation on a pass along its line in a drill of the side", async () => {
    const { classical } = addPartingVariations();
    const scandinavian = addVariation(MIESES, SCANDINAVIAN_ROWS, "Scandinavian Defense");
    addCard("e4 d5", "exd5", PAST);
    const service = boot();
    let state = await startAt(service, classical, "due", "side");
    // 1.e4 is likeliest in every unit, so the oldest keeps it.
    expect(variationOf(state)).toEqual({ id: classical, name: CLASSICAL, drill: classical });
    state = await play(service, state, "e4");
    expect(lineSan(state)).toEqual(["e4", "d5"]);
    expect(variationOf(state)).toEqual({ id: scandinavian, name: MIESES, drill: scandinavian });
    state = await play(service, state, "exd5");
    expect(state.status).toBe("solved");
    expect(variationOf(state)?.name).toBe(MIESES);
  });

  it("starts a group drill from the start_training command's level, in a frame the page accepts", async () => {
    const { classical } = addPartingVariations();
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
          repertoire_id: classical,
          scope: "due",
          level: "group",
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
      expect(drillOf(state)).toMatchObject({ level: "group", moves_left: 5 });
      expect(state.item).toMatchObject({ kind: "repertoire", variation_name: CLASSICAL });
      socket.terminate();
    } finally {
      await app.close();
    }
  });
});

describe("a rebuild's copy of a unit", () => {
  const AFTER_BC5_TEXT = "e4 e5 Nf3 Nc6 Bc4 Bc5";

  // The unit answers 3...Bc5 with 4.c3 and every card is due; the copy a rebuild is walking already
  // answers 4.d3, which has no card.
  function addUnitAndCopy(): { classical: number; copy: number } {
    const classical = addVariation(CLASSICAL, CLASSICAL_ROWS);
    addCards(CLASSICAL_ROWS);
    const copy = addVariation(
      PIANISSIMO,
      PIANISSIMO_ROWS,
      `Italian Game${REPERTOIRE_REBUILD_GROUP_SUFFIX}`,
    );
    return { classical, copy };
  }

  const servedRows = (): number[] => {
    const run = db
      .prepare("SELECT items_json FROM training_runs ORDER BY id DESC LIMIT 1")
      .get() as {
      items_json: string;
    };
    return (JSON.parse(run.items_json) as Array<{ id: number }>).map((item) => item.id);
  };
  const unitOfRow = (rowId: number): number =>
    (
      db.prepare("SELECT repertoire_id FROM repertoire_positions WHERE id = ?").get(rowId) as {
        repertoire_id: number;
      }
    ).repertoire_id;

  it("refuses a drill of the copy at every level as a repertoire that does not exist", async () => {
    const { copy } = addUnitAndCopy();
    const service = boot();
    for (const level of ["variation", "group", "side"] as const) {
      await expect(startAt(service, copy, "all", level)).rejects.toMatchObject({
        code: "empty_queue",
        message: `repertoire ${copy} does not exist`,
      });
    }
    await expect(startAt(service, copy + 1, "all", "variation")).rejects.toMatchObject({
      code: "empty_queue",
      message: `repertoire ${copy + 1} does not exist`,
    });
    expect(service.current()).toBeNull();
    expect(runEnds()).toEqual([]);
  });

  it("serves no move of the copy in a drill of the unit's group or of its side", async () => {
    const { classical } = addUnitAndCopy();
    const service = boot();
    for (const level of ["group", "side"] as const) {
      const state = await startAt(service, classical, "all", level);
      // 1.e4, 2.Nf3, 3.Bc4 and 4.c3: the unit's four moves and not the copy's 4.d3.
      expect(drillOf(state).moves_left).toBe(4);
      expect(servedRows().map(unitOfRow)).toEqual([classical, classical, classical, classical]);
    }
  });

  it("makes no card from a move only the copy stores", async () => {
    const { classical, copy } = addUnitAndCopy();
    // Nothing of the unit is due: the copy's new 4.d3 would be the one move a side drill serves.
    db.prepare("UPDATE repertoire_cards SET next_review_at = ?").run(FUTURE);
    const cardsBefore = db.prepare("SELECT COUNT(*) AS n FROM repertoire_cards").get();
    const service = boot();
    expect(await code(startAt(service, classical, "due", "side"))).toBe("empty_queue");
    expect(await code(startAt(service, copy, "all", "variation"))).toBe("empty_queue");
    expect(cardOf(AFTER_BC5_TEXT, "d3")).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM repertoire_cards").get()).toEqual(cardsBefore);
  });
});

const SCANDINAVIAN_GROUP = "Scandinavian Defense";
const ALEKHINE_GROUP = "Alekhine Defense";
const ALEKHINE_MODERN = "Modern Variation (2.e5)";
const ALEKHINE_ROWS: FixtureRow[] = [
  ["", "e4", 1],
  ["e4", "Nf6", 1],
  ["e4 Nf6", "e5", 1],
];

// A unit built from a root that leaves the Italian stores the root's moves as setup rows, and the
// last of them is Black's: that is what a met opening names the unit by.
function addFoundUnit(
  name: string,
  rows: FixtureRow[],
  groupName: string,
  rootPlies: number,
): number {
  const id = addVariation(name, rows, groupName);
  db.prepare(
    "UPDATE repertoire_positions SET source = 'setup' WHERE repertoire_id = ? AND ply <= ?",
  ).run(id, rootPlies);
  return id;
}

let metGames = 0;
// A game reviewed against `repertoireId` that left the line on Black's move `leftPly`: the row
// that makes its root an opening met in the student's games.
function addMetGame(line: string[], leftPly: number, repertoireId: number): void {
  metGames += 1;
  const pgn = line
    .map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}. ${san}` : san))
    .join(" ");
  const gameId = importFinishedGame(db, {
    pgn: `[Result "1-0"]\n\n${pgn} 1-0`,
    playerColor: "white",
    source: "pgn",
    sourceId: `found-${metGames}`,
  }) as number;
  const board = new Chess();
  let from = "";
  let left: Move | null = null;
  for (const [index, san] of line.entries()) {
    if (index + 1 === leftPly) from = positionKey(board.fen());
    const played = board.move(san);
    if (index + 1 === leftPly) left = played;
  }
  db.prepare(
    `INSERT INTO repertoire_game_reviews
       (game_id, repertoire_id, reviewed_at, outcome, followed_plies, passed_moves, left_ply,
        left_position_key, left_san, left_uci, opening_name)
     VALUES (?, ?, ?, 'not_reached', 0, 0, ?, ?, ?, ?, NULL)`,
  ).run(
    gameId,
    repertoireId,
    T0.toISOString(),
    leftPly,
    from,
    left?.san ?? null,
    left ? `${left.from}${left.to}` : null,
  );
}

// The opening and the variation the board names for the move in play.
const openingOf = (state: TrainingActivity): string | null =>
  state.item.kind === "repertoire" ? (state.item.group_name ?? null) : null;

describe("a drill over the units found in games", () => {
  let italian: number;
  let scandinavian: number;
  let alekhine: number;

  // The Italian is a chosen unit. The other two were built from openings the games met, so the
  // met openings name them; 1.e4 is the first move of all three and has one card.
  beforeEach(() => {
    metGames = 0;
    italian = addVariation(CLASSICAL, CLASSICAL_ROWS);
    scandinavian = addFoundUnit(MIESES, SCANDINAVIAN_ROWS, SCANDINAVIAN_GROUP, 2);
    alekhine = addFoundUnit(ALEKHINE_MODERN, ALEKHINE_ROWS, ALEKHINE_GROUP, 2);
    addMetGame(["e4", "d5", "exd5"], 2, italian);
    addMetGame(["e4", "Nf6", "e5"], 2, italian);
    // 1.e4 and 2.exd5 are known and due, and 2.e5 has no card, so it is new and due too.
    addCard("", "e4", PAST);
    addCard("e4 d5", "exd5", PAST);
  });

  const foundLeft = async (service: ActivityService, scope: RepertoireScope): Promise<number> =>
    drillOf(await startAt(service, scandinavian, scope, "found")).moves_left;

  it("names the units whose id a met opening carries, and no other", () => {
    expect(foundRepertoireIdsOf([])).toEqual(new Set());
    expect(
      foundRepertoireIdsOf([{ repertoireId: null }, { repertoireId: 4 }, { repertoireId: 4 }]),
    ).toEqual(new Set([4]));
  });

  it("drills the moves of every found unit, a shared move once and none of the Italian's", async () => {
    const service = boot();
    let state = await startAt(service, scandinavian, "all", "found");
    // 1.e4, 2.exd5 and 2.e5; the Italian's 2.Nf3, 3.Bc4 and 4.c3 are not in this drill.
    expect(drillOf(state)).toMatchObject({ level: "found", moves_left: 3 });
    expect(state.queue_outcomes).toHaveLength(2);

    expect(variationOf(state)).toEqual({ id: scandinavian, name: MIESES, drill: scandinavian });
    expect(openingOf(state)).toBe(SCANDINAVIAN_GROUP);
    state = await play(service, state, "e4");
    expect(lineSan(state)).toEqual(["e4", "Nf6"]);
    expect(whoPlayed(state)).toEqual(["student", "reply"]);
    expect(variationOf(state)).toEqual({ id: alekhine, name: ALEKHINE_MODERN, drill: alekhine });
    expect(openingOf(state)).toBe(ALEKHINE_GROUP);
    expect(drillOf(state)).toMatchObject({ first_pass: true, answer: { san: "e5" } });
    state = await play(service, state, "e5");
    expect(state.status).toBe("solved");

    // The next pass plays 1.e4 and Black's reply itself, then asks the other unit's move.
    state = await next(service, state);
    expect(lineSan(state)).toEqual(["e4", "d5"]);
    expect(whoPlayed(state)).toEqual(["reply", "reply"]);
    expect(variationOf(state)).toEqual({ id: scandinavian, name: MIESES, drill: scandinavian });
    expect(openingOf(state)).toBe(SCANDINAVIAN_GROUP);
    expect(drillOf(state).moves_left).toBe(2);
  });

  it("expects each unit's own move: another unit's move is wrong where the board names this one", async () => {
    const service = boot();
    let state = await startAt(service, scandinavian, "all", "found");
    state = await play(service, state, "e4");
    // Against 1...Nf6 the board names the Alekhine's 2.e5, and 2.d4 is nobody's move here.
    state = await play(service, state, "d4");
    expect(state.last_try).toMatchObject({ san: "d4", correct: false });
    expect(state.input_enabled).toBe(true);
    state = await play(service, state, "e5");
    expect(state.last_try).toMatchObject({ san: "e5", correct: true });
    state = await next(service, state);
    // Against 1...d5 the same 2.e5 is legal and wrong: only 2.exd5 is the Scandinavian's move.
    expect(openingOf(state)).toBe(SCANDINAVIAN_GROUP);
    state = await play(service, state, "e5");
    expect(state.last_try).toMatchObject({ san: "e5", correct: false });
    expect(state.input_enabled).toBe(true);
    state = await play(service, state, "exd5");
    expect(state.last_try).toMatchObject({ san: "exd5", correct: true });
    expect(state.status).toBe("failed");
    expect(openingOf(state)).toBe(SCANDINAVIAN_GROUP);
  });

  it("serves exactly the moves the counts offered for its scope, whichever unit it starts from", async () => {
    addCard("e4 Nf6", "e5", FUTURE);
    const service = boot();
    const units = [scandinavian, alekhine].map((id) => ({
      variation: findDrillRepertoire(db, id) as NonNullable<ReturnType<typeof findDrillRepertoire>>,
      moves: listRepertoireDrillMoves(db, id),
    }));
    const offered = repertoireScopeCounts(mergeRepertoireUnitMoves(units), now);
    // 2.e5 is known and not due, so it is in all and not in due.
    expect(offered).toEqual({ recommended: 2, due: 2, all: 3, missed: 0 });
    for (const scope of ["recommended", "due", "all"] as const) {
      expect(await foundLeft(service, scope)).toBe(offered[scope]);
    }
    expect(drillOf(await startAt(service, alekhine, "all", "found")).moves_left).toBe(3);
  });

  it("refuses a found drill started from a unit that is not found in games", async () => {
    const service = boot();
    expect(await code(startAt(service, italian, "all", "found"))).toBe("empty_queue");
    // The Italian's own level still serves its moves: 1.e4, 2.Nf3, 3.Bc4 and 4.c3.
    expect(drillOf(await startAt(service, italian, "all", "variation")).moves_left).toBe(4);
  });

  it("serves nothing for a found drill while no unit was built from a met opening", async () => {
    db.prepare("DELETE FROM repertoire_game_reviews").run();
    const service = boot();
    expect(await code(startAt(service, scandinavian, "all", "found"))).toBe("empty_queue");
    // The side's drill still covers the three units: 1.e4, 2.Nf3, 3.Bc4, 4.c3, 2.exd5 and 2.e5.
    expect(drillOf(await startAt(service, scandinavian, "all", "side")).moves_left).toBe(6);
  });

  it("starts from the start_training command's found level, in a frame the page accepts", async () => {
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
          repertoire_id: scandinavian,
          scope: "due",
          level: "found",
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
      expect(drillOf(state)).toMatchObject({ level: "found", moves_left: 3 });
      expect(state.item).toMatchObject({
        kind: "repertoire",
        variation_name: MIESES,
        group_name: SCANDINAVIAN_GROUP,
      });
      socket.terminate();
    } finally {
      await app.close();
    }
  });
});

describe("pinning the line drill rules that stayed green under mutation", () => {
  it("keeps a new move's answer and first pass flag after a wrong try on its first pass", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCardsAllButC3();
    const service = boot();
    let state = await start(service, id, "recommended");
    expect(drillOf(state)).toMatchObject({ first_pass: true, answer: { san: "c3" } });

    state = await play(service, state, "d3");
    expect(state.input_enabled).toBe(true);
    expect(state.last_try).toMatchObject({ san: "d3", correct: false });
    expect(drillOf(state)).toMatchObject({ first_pass: true, answer: { san: "c3" } });

    state = await play(service, state, "c3");
    expect(state.input_enabled).toBe(false);
    expect(state.status).toBe("failed");
    expect(drillOf(state)).toMatchObject({ first_pass: false, answer: null });

    state = await next(service, state);
    expect(drillOf(state)).toMatchObject({ first_pass: false, answer: null });
  });

  it("reports the scope the drill was started with for recommended, due and all", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS);
    const service = boot();
    for (const scope of ["recommended", "due", "all"] as const) {
      expect(drillOf(await start(service, id, scope)).scope).toBe(scope);
    }
  });

  it("names the opening of the move asked now across two moves with different names", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(
      ITALIAN_ROWS,
      (lineText, san) => san === "e4" || (lineText === "e4 e5 Nf3 Nc6 Bc4 Bc5" && san === "c3"),
    );
    const service = boot();
    let state = await start(service, id, "due");
    expect(drillOf(state).opening_name).toBe("King's Pawn Game");

    state = await play(service, state, "e4");
    expect(lineSan(state)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"]);
    expect(drillOf(state).opening_name).toBe("Italian Game");
  });

  it("asks the move the pass's line plays where two variations part in one position", async () => {
    const d4Rows: FixtureRow[] = [
      ...SETUP_ROWS,
      [BC4_LINE, "Bc5", 0.6],
      [`${BC4_LINE} Bc5`, "c3", 0.6],
      [`${BC4_LINE} Bc5 c3`, "Nf6", 0.3],
      [`${BC4_LINE} Bc5 c3 Nf6`, "d4", 0.5],
    ];
    const d3Rows: FixtureRow[] = [
      ...SETUP_ROWS,
      [BC4_LINE, "Bc5", 0.6],
      [`${BC4_LINE} Bc5`, "d3", 0.4],
    ];
    const classical = addVariation("ClassicalD4", d4Rows);
    addVariation("PianissimoD3", d3Rows);
    addCards(SETUP_ROWS, () => false);
    addCard(`${BC4_LINE} Bc5`, "c3", FUTURE);
    addCard(`${BC4_LINE} Bc5 c3 Nf6`, "d4", PAST);
    addCard(`${BC4_LINE} Bc5`, "d3", PAST);

    const service = boot();
    let state = await startAt(service, classical, "due", "group");
    expect(lineSan(state)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6"]);
    expect(drillOf(state).moves_left).toBe(2);

    state = await play(service, state, "d3");
    expect(state.last_try).toMatchObject({ san: "d3", correct: false });
    expect(state.input_enabled).toBe(true);
    state = await play(service, state, "d4");
    expect(state.last_try).toMatchObject({ san: "d4", correct: true });
  });

  it("refuses retry_item during a drill with invalid_state and leaves the pass as it was", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    const service = boot();
    const state = await start(service, id, "due");
    const passes = () => db.prepare("SELECT COUNT(*) AS n FROM training_items").get();
    const before = passes();
    expect(await code(service.retryTrainingItem(state.activity_id))).toBe("invalid_state");
    expect(service.current()).toEqual(state);
    expect(passes()).toEqual(before);
  });

  it("refuses ask_coach_about_item during a drill with not_in_training and no puzzle result", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    const service = boot();
    const state = await start(service, id, "due");
    expect(await code(service.trainingAskCoach(state.activity_id))).toBe("not_in_training");
    const notes = (
      db.prepare("SELECT content_json FROM chat_messages WHERE kind = 'notification'").all() as {
        content_json: string;
      }[]
    ).map((row) => JSON.parse(row.content_json));
    expect(notes.filter((note) => note.type === "puzzle_result")).toHaveLength(0);
  });
});

describe("showing a line drill move's stored idea after the answer", () => {
  it("carries the answered move's SAN and stored idea after a right first try", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4" || san === "Nf3");
    setIdea("", "e4", "Take the centre and free the bishop.");
    setIdea("e4 e5", "Nf3", "Develop and attack e5.");
    const service = boot();
    let state = await start(service, id, "due");
    expect(drillOf(state).answered).toBeNull();

    state = await play(service, state, "e4");
    expect(drillOf(state).answered).toEqual({
      san: "e4",
      idea: "Take the centre and free the bishop.",
      asked: false,
    });
    expect(drillOf(state).hint).toEqual({ kind: "none" });
    expect(cardOf("", "e4")).toMatchObject({ reviews: 3, last_reviewed_at: T0.toISOString() });
    expect(firstAttempts()).toEqual([attemptOf("", "e4", id, 1)]);
  });

  it("carries the idea after a wrong try then the right move, with the same fail rating", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    setIdea("", "e4", "Take the centre and free the bishop.");
    const service = boot();
    let state = await start(service, id, "due");
    state = await play(service, state, "h3");
    expect(drillOf(state).answered).toBeNull();
    state = await play(service, state, "e4");
    expect(drillOf(state).answered).toEqual({
      san: "e4",
      idea: "Take the centre and free the bishop.",
      asked: false,
    });
    expect(cardOf("", "e4")).toMatchObject({ fsrs_state: 3, lapses: 1, interval_hours: 10 / 60 });
    expect(firstAttempts()).toEqual([attemptOf("", "e4", id, 0)]);
  });

  it("carries the idea after the move is shown by the hint's last step, with the same fail rating", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    setIdea("", "e4", "Take the centre and free the bishop.");
    const service = boot();
    let state = await start(service, id, "due");
    state = training(await service.trainingHint(state.activity_id));
    expect(drillOf(state).answered).toBeNull();
    state = training(await service.trainingHint(state.activity_id));
    expect(drillOf(state).answered).toEqual({
      san: "e4",
      idea: "Take the centre and free the bishop.",
      asked: false,
    });
    state = await play(service, state, "e4");
    expect(drillOf(state).answered).toEqual({
      san: "e4",
      idea: "Take the centre and free the bishop.",
      asked: false,
    });
    expect(cardOf("", "e4")).toMatchObject({ fsrs_state: 3, lapses: 1, interval_hours: 10 / 60 });
    expect(firstAttempts()).toEqual([attemptOf("", "e4", id, 0)]);
  });

  it("carries the idea after show_solution, with the same fail rating", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    setIdea("", "e4", "Take the centre and free the bishop.");
    const service = boot();
    let state = await start(service, id, "due");
    state = training(await service.trainingShowSolution(state.activity_id));
    expect(drillOf(state).answered).toEqual({
      san: "e4",
      idea: "Take the centre and free the bishop.",
      asked: false,
    });
    state = await play(service, state, "e4");
    expect(state.status).toBe("failed");
    expect(drillOf(state).answered).toEqual({
      san: "e4",
      idea: "Take the centre and free the bishop.",
      asked: false,
    });
    expect(cardOf("", "e4")).toMatchObject({ fsrs_state: 3, lapses: 1, interval_hours: 10 / 60 });
  });

  it("keeps the answered move while the server plays on, replaces it, and starts the next pass null", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4" || san === "Nf3");
    setIdea("", "e4", "Take the centre.");
    setIdea("e4 e5", "Nf3", "Develop.");
    const service = boot();
    let state = await start(service, id, "due");
    state = await play(service, state, "e4");
    expect(lineSan(state)).toEqual(["e4", "e5"]);
    expect(drillOf(state).answered).toEqual({ san: "e4", idea: "Take the centre.", asked: false });

    state = await play(service, state, "h3");
    expect(drillOf(state).answered).toEqual({ san: "e4", idea: "Take the centre.", asked: false });
    state = await play(service, state, "Nf3");
    expect(drillOf(state).answered).toEqual({ san: "Nf3", idea: "Develop.", asked: false });
    expect(state.status).toBe("failed");

    state = await next(service, state);
    expect(drillOf(state).answered).toBeNull();
    state = await play(service, state, "Nf3");
    expect(drillOf(state).answered).toEqual({ san: "Nf3", idea: "Develop.", asked: false });
  });

  it("gives answered.idea null when none is stored, never the placeholder", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    const service = boot();
    let state = await start(service, id, "due");
    state = await play(service, state, "e4");
    expect(drillOf(state).answered).toEqual({ san: "e4", idea: null, asked: false });
    expect(drillOf(state).hint).toEqual({ kind: "none" });
  });

  it("carries the new move's idea when it is shown with its answer", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCardsAllButC3();
    const afterBc5 = "e4 e5 Nf3 Nc6 Bc4 Bc5";
    setIdea(afterBc5, "c3", "Prepare d4.");
    const service = boot();
    let state = await start(service, id, "recommended");
    expect(drillOf(state)).toMatchObject({ first_pass: true, answer: { san: "c3" } });
    expect(drillOf(state).answered).toEqual({ san: "c3", idea: "Prepare d4.", asked: false });

    state = await play(service, state, "c3");
    expect(drillOf(state).answered).toEqual({ san: "c3", idea: "Prepare d4.", asked: false });
    expect(firstAttempts()).toEqual([]);
  });
});

describe("asking the coach for the idea of an answered line drill move", () => {
  const LONDON_ROWS: FixtureRow[] = [
    ["", "d4", 1],
    ["d4", "d5", 1],
    ["d4 d5", "Bf4", 1],
    ["d4 d5 Bf4", "Nf6", 1],
    ["d4 d5 Bf4 Nf6", "e3", 1],
  ];

  const notifications = (): CoachNotification[] =>
    (
      db
        .prepare("SELECT content_json FROM chat_messages WHERE kind = 'notification' ORDER BY id")
        .all() as { content_json: string }[]
    ).map((row) => JSON.parse(row.content_json) as CoachNotification);

  it("writes a repertoire_idea_request with both names, numbered line and FEN before the move, wakes the coach and leaves cards alone", async () => {
    const id = addVariation("Main lines", LONDON_ROWS, "London System");
    addCards(LONDON_ROWS);
    setIdea("d4 d5", "Bf4", "Develop outside the pawn chain.");
    const service = boot();
    let state = await start(service, id, "all");
    state = await play(service, state, "d4");
    state = await play(service, state, "Bf4");
    expect(drillOf(state).answered).toEqual({
      san: "Bf4",
      idea: "Develop outside the pawn chain.",
      asked: false,
    });

    const reviewsBefore = drillReviewCount();
    const cardBefore = cardOf("d4 d5", "Bf4");
    const attemptsBefore = firstAttempts();

    state = training(await service.trainingAskCoach(state.activity_id));
    expect(drillOf(state).answered).toEqual({
      san: "Bf4",
      idea: "Develop outside the pawn chain.",
      asked: true,
    });
    expect(wakes).toEqual([1]);
    expect(drillReviewCount()).toBe(reviewsBefore);
    expect(cardOf("d4 d5", "Bf4")).toEqual(cardBefore);
    expect(firstAttempts()).toEqual(attemptsBefore);

    const beforeBf4 = new Chess();
    beforeBf4.move("d4");
    beforeBf4.move("d5");
    const expectedFenBefore = beforeBf4.fen();

    const notes = notifications();
    expect(notes).toEqual([
      {
        type: "repertoire_idea_request",
        group: "London System",
        variation: "Main lines",
        side: "white",
        line: ["d4", "d5", "Bf4"],
        fen_before: expectedFenBefore,
        san: "Bf4",
        idea: "Develop outside the pawn chain.",
        first_try_right: true,
      },
    ]);
    const rendered = renderNotifications(notes);
    expect(rendered).toContain("London System");
    expect(rendered).toContain("Main lines");
    expect(rendered).toContain("1.d4 d5 2.Bf4");
    expect(rendered).toContain(expectedFenBefore);
  });

  it("works after the move is shown by the second hint and keeps asked when the move is then played", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4");
    const service = boot();
    let state = await start(service, id, "due");
    state = training(await service.trainingHint(state.activity_id));
    expect(await code(service.trainingAskCoach(state.activity_id))).toBe("not_in_training");

    state = training(await service.trainingHint(state.activity_id));
    expect(drillOf(state).answered).toEqual({ san: "e4", idea: null, asked: false });

    const reviewsBefore = drillReviewCount();
    const cardBefore = cardOf("", "e4");
    state = training(await service.trainingAskCoach(state.activity_id));
    expect(drillOf(state).answered).toEqual({ san: "e4", idea: null, asked: true });
    expect(wakes).toEqual([1]);
    expect(drillReviewCount()).toBe(reviewsBefore);
    expect(cardOf("", "e4")).toEqual(cardBefore);
    expect(notifications()).toEqual([
      expect.objectContaining({
        type: "repertoire_idea_request",
        san: "e4",
        idea: null,
        first_try_right: false,
      }),
    ]);

    state = await play(service, state, "e4");
    expect(drillOf(state).answered).toEqual({ san: "e4", idea: null, asked: true });
    expect(await code(service.trainingAskCoach(state.activity_id))).toBe("already_requested");
  });

  it("works on a first showing before or after playing the move, and never changes cards", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCardsAllButC3();
    const service = boot();
    let state = await start(service, id, "recommended");
    expect(drillOf(state)).toMatchObject({
      first_pass: true,
      answer: { san: "c3" },
      answered: { san: "c3", idea: null, asked: false },
    });

    const reviewsBefore = drillReviewCount();
    const cardBefore = cardOf("e4 e5 Nf3 Nc6 Bc4 Bc5", "c3");
    state = training(await service.trainingAskCoach(state.activity_id));
    expect(drillOf(state).answered).toEqual({ san: "c3", idea: null, asked: true });
    expect(wakes).toEqual([1]);
    expect(drillReviewCount()).toBe(reviewsBefore);
    expect(cardOf("e4 e5 Nf3 Nc6 Bc4 Bc5", "c3")).toEqual(cardBefore);
    expect(notifications()).toEqual([
      expect.objectContaining({
        type: "repertoire_idea_request",
        group: "Italian Game",
        variation: "Classical",
        san: "c3",
        idea: null,
        first_try_right: false,
      }),
    ]);

    state = await play(service, state, "c3");
    expect(drillOf(state).answered).toEqual({ san: "c3", idea: null, asked: true });
    expect(await code(service.trainingAskCoach(state.activity_id))).toBe("already_requested");
  });

  it("refuses with not_in_training while answered is null, already_requested on repeat, and stale_activity on a stale id, and resets asked on the next answered move", async () => {
    const id = addVariation("Classical", ITALIAN_ROWS);
    addCards(ITALIAN_ROWS, (_lineText, san) => san === "e4" || san === "Nf3");
    const service = boot();
    let state = await start(service, id, "due");
    expect(drillOf(state).answered).toBeNull();
    expect(await code(service.trainingAskCoach(state.activity_id))).toBe("not_in_training");
    expect(wakes).toEqual([]);

    state = await play(service, state, "e4");
    expect(await code(service.trainingAskCoach(state.activity_id + 1))).toBe("stale_activity");
    expect(drillOf(state).answered).toEqual({ san: "e4", idea: null, asked: false });

    state = training(await service.trainingAskCoach(state.activity_id));
    expect(drillOf(state).answered).toEqual({ san: "e4", idea: null, asked: true });
    expect(await code(service.trainingAskCoach(state.activity_id))).toBe("already_requested");
    expect(wakes).toEqual([1]);

    // Answering the next move replaces `answered` with `asked: false`, allowing a request for it.
    state = await play(service, state, "Nf3");
    expect(drillOf(state).answered).toEqual({ san: "Nf3", idea: null, asked: false });
    state = training(await service.trainingAskCoach(state.activity_id));
    expect(drillOf(state).answered).toEqual({ san: "Nf3", idea: null, asked: true });
    expect(wakes).toEqual([1, 2]);
    expect(notifications().map((note) => note.type)).toEqual([
      "repertoire_idea_request",
      "repertoire_idea_request",
    ]);
  });
});

// A Black unit answers two first moves of White's, each continued: the Caro-Kann against 1.e4 and the
// Slav against 1.d4. White's moves are the ones the drill plays for the student, Black's the ones it
// asks, so a student's move sits where the line before it has an odd length.
const BLACK_ROWS: FixtureRow[] = [
  ["", "e4", 0.6],
  ["e4", "c6", 0.6],
  ["e4 c6", "d4", 0.6],
  ["e4 c6 d4", "d5", 0.6],
  ["", "d4", 0.4],
  ["d4", "d5", 0.4],
  ["d4 d5", "c4", 0.4],
  ["d4 d5 c4", "c6", 0.4],
];

// 1...d5 against 1.d4 and 2...d5 against 1.e4 c6 2.d4 end on the same two plies, so a move is named
// by the whole line that reaches it.
const BLACK_MOVE_LINES = ["e4 c6", "e4 c6 d4 d5", "d4 d5", "d4 d5 c4 c6"];

const addBlackUnit = (rows: FixtureRow[] = BLACK_ROWS): number =>
  addVariation("Caro-Kann and Slav", rows, "Black repertoire", "black");

const addBlackCards = (rows: FixtureRow[] = BLACK_ROWS): void =>
  addCards(rows, () => true, true, "black");

const pathLabel = (move: RepertoireDrillMove): string => [...move.line, move.san].join(" ");

const servedLines = (id: number, scope: RepertoireScope): string[] =>
  selectRepertoireDrillMoves(listRepertoireDrillMoves(db, id), scope, now).map(pathLabel);

function fenAfter(sans: string[]): string {
  const board = new Chess();
  for (const san of sans) board.move(san);
  return board.fen();
}

describe("a repertoire drill of a Black unit", () => {
  it("starts with White's first move on the board and Black's first move to find, the board turned to Black", async () => {
    const id = addBlackUnit();
    const service = boot();
    const state = await start(service, id, "all");

    expect(state.orientation).toBe("black");
    expect(state.turn).toBe("black");
    expect(state.fen).toBe(fenAfter(["e4"]));
    expect(lineSan(state)).toEqual(["e4"]);
    expect(whoPlayed(state)).toEqual(["reply"]);
    expect(state.last_move).toEqual({ from: "e2", to: "e4" });
    expect(state.status).toBe("prompt");
    expect(state.input_enabled).toBe(true);
    expect(state.item).toMatchObject({
      kind: "repertoire",
      repertoire_id: id,
      position_in_queue: 1,
    });
    // A new move is shown with its answer: the move asked is Black's first, 1...c6 against 1.e4,
    // and not 1...d5, which answers the other first move of the unit and has less reach.
    expect(drillOf(state)).toMatchObject({
      first_pass: true,
      answer: { uci: "c7c6", san: "c6" },
      moves_left: 4,
    });
    const run = db.prepare("SELECT color FROM training_runs").get();
    expect(run).toEqual({ color: "black" });
  });

  it("answers in a frame the page accepts, as a Black drill started by start_training", async () => {
    const id = addBlackUnit();
    addBlackCards();
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
          scope: "all",
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
      expect(state.orientation).toBe("black");
      expect(state.item).toMatchObject({ kind: "repertoire", repertoire_id: id });
      expect(lineSan(state)).toEqual(["e4"]);
      expect(drillOf(state)).toMatchObject({ scope: "all", moves_left: 4 });
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("plays White's move between two asked moves, then starts the next pass from move 1 with the other first move", async () => {
    const id = addBlackUnit();
    addBlackCards();
    const service = boot();
    let state = await start(service, id, "all");
    expect(drillOf(state)).toMatchObject({ first_pass: false, answer: null, moves_left: 4 });

    state = await play(service, state, "c6");
    // The server played White's 2.d4 for the student's opponent and stopped on 2...d5.
    expect(lineSan(state)).toEqual(["e4", "c6", "d4"]);
    expect(whoPlayed(state)).toEqual(["reply", "student", "reply"]);
    expect(state.fen).toBe(fenAfter(["e4", "c6", "d4"]));
    expect(state.last_move).toEqual({ from: "d2", to: "d4" });
    expect(state.turn).toBe("black");
    expect(state.status).toBe("in_progress");
    expect(state.input_enabled).toBe(true);

    state = await play(service, state, "d5");
    expect(lineSan(state)).toEqual(["e4", "c6", "d4", "d5"]);
    expect(state.status).toBe("solved");
    expect(state.input_enabled).toBe(false);
    expect(progressOf(state)).toEqual({
      pass: [1, 2],
      outcomes: ["solved", "pending"],
      left: 2,
      right: 2,
      wrong: 0,
    });

    // The first line is done: the next pass starts from the starting position, the server plays the
    // other White first move and Black is asked again.
    state = await next(service, state);
    expect(state.item).toMatchObject({ position_in_queue: 2 });
    expect(lineSan(state)).toEqual(["d4"]);
    expect(whoPlayed(state)).toEqual(["reply"]);
    expect(state.fen).toBe(fenAfter(["d4"]));
    expect(state.orientation).toBe("black");
    expect(state.status).toBe("prompt");

    state = await play(service, state, "d5");
    expect(lineSan(state)).toEqual(["d4", "d5", "c4"]);
    expect(whoPlayed(state)).toEqual(["reply", "student", "reply"]);
    state = await play(service, state, "c6");
    expect(state.status).toBe("solved");
    state = await next(service, state);
    expect(drillOf(state).result).toEqual({ practised: 4, first_try_right: 4 });
  });

  it("keeps the position open on a wrong try at a Black move, and brings the missed move back from move 1", async () => {
    const id = addBlackUnit();
    addBlackCards();
    const service = boot();
    let state = await start(service, id, "all");
    state = await play(service, state, "Nf6");
    expect(state.input_enabled).toBe(true);
    expect(state.fen).toBe(fenAfter(["e4"]));
    expect(state.last_try).toMatchObject({ san: "Nf6", correct: false });
    expect(state.wrong_tries).toEqual([{ ply: 1, uci: "g8f6", san: "Nf6" }]);
    state = await play(service, state, "c6");
    state = await play(service, state, "d5");
    expect(state.status).toBe("failed");
    state = await next(service, state);
    state = await play(service, state, "d5");
    state = await play(service, state, "c6");
    state = await next(service, state);

    // The round is over; 1...c6 comes back with White's first move played for the student.
    expect(state.item).toMatchObject({ position_in_queue: 3 });
    expect(lineSan(state)).toEqual(["e4"]);
    expect(drillOf(state)).toMatchObject({ moves_left: 1, moves_wrong: 1 });
    state = await play(service, state, "c6");
    // Only the missed move is asked again, so the pass ends on it.
    expect(lineSan(state)).toEqual(["e4", "c6"]);
    expect(state.status).toBe("solved");
    state = await next(service, state);
    expect(drillOf(state).result).toEqual({ practised: 4, first_try_right: 3 });
  });

  describe("rating the first move of the line", () => {
    const stored = {
      fsrs_state: 2 as const,
      stability: 1,
      difficulty: 2.1181,
      learning_step: 0,
      lapses: 0,
      interval_hours: 24,
      last_reviewed_at: new Date(Date.parse(PAST) - 24 * HOUR_MS).toISOString(),
      next_review_at: PAST,
    };
    // One review: the schedule the card had, moved once by the grade, as a White move's is.
    const reviewed = (grade: 1 | 3) => ({ ...review(stored, grade, T0), reviews: 3 });

    // What the student does first at 1...c6; the miss is then played out with the right move, which
    // rates nothing more.
    it.each([
      {
        how: "a wrong try",
        grade: 1 as const,
        first: async (service: ActivityService, state: TrainingActivity) =>
          play(service, state, "Nf6"),
        playsRightAfter: true,
      },
      {
        how: "a hint",
        grade: 1 as const,
        first: async (service: ActivityService, state: TrainingActivity) =>
          training(await service.trainingHint(state.activity_id)),
        playsRightAfter: true,
      },
      {
        how: "a shown solution",
        grade: 1 as const,
        first: async (service: ActivityService, state: TrainingActivity) =>
          training(await service.trainingShowSolution(state.activity_id)),
        playsRightAfter: true,
      },
      {
        how: "a right first attempt",
        grade: 3 as const,
        first: async (service: ActivityService, state: TrainingActivity) =>
          play(service, state, "c6"),
        playsRightAfter: false,
      },
    ])(
      "rates 1...c6 with grade $grade after $how, once, and writes its first attempt",
      async ({ grade, first, playsRightAfter }) => {
        const id = addBlackUnit();
        addBlackCards();
        const service = boot();
        let state = await start(service, id, "all");
        state = await first(service, state);
        if (playsRightAfter) state = await play(service, state, "c6");

        expect(loggedDrillGrades()).toEqual([grade]);
        expect(cardOf("e4", "c6")).toEqual(reviewed(grade));
        expect(firstAttempts()).toEqual([attemptOf("e4", "c6", id, grade === 3 ? 1 : 0)]);
        // Only that first move was rated: the others still hold the card they were given.
        expect(cardOf("e4 c6 d4", "d5")).toMatchObject({ reviews: 2, interval_hours: 24 });
      },
    );

    it("rates a later Black move of the line by its own first attempt, missed or right", async () => {
      const id = addBlackUnit();
      addBlackCards();
      const service = boot();
      let state = await start(service, id, "all");
      state = await play(service, state, "c6");
      state = await play(service, state, "Nf6");
      state = await play(service, state, "d5");
      state = await next(service, state);
      state = await play(service, state, "d5");
      state = await play(service, state, "c6");

      expect(loggedDrillGrades()).toEqual([3, 1, 3, 3]);
      expect(firstAttempts()).toEqual([
        attemptOf("e4", "c6", id, 1),
        attemptOf("e4 c6 d4", "d5", id, 0),
        attemptOf("d4", "d5", id, 1),
        attemptOf("d4 d5 c4", "c6", id, 1),
      ]);
    });
  });

  describe("the moves each scope serves", () => {
    it("serves every move of a unit with no card for all, due and recommended", () => {
      const id = addBlackUnit();
      for (const scope of ["all", "due", "recommended"] as const) {
        expect(servedLines(id, scope)).toEqual(BLACK_MOVE_LINES);
      }
      expect(repertoireScopeCounts(listRepertoireDrillMoves(db, id), now)).toEqual({
        recommended: 4,
        due: 4,
        all: 4,
        missed: 0,
      });
    });

    it("serves every move of the unit for all and due, and for recommended, once every move has a card that is due", () => {
      const id = addBlackUnit();
      addBlackCards();
      expect(servedLines(id, "all")).toEqual(BLACK_MOVE_LINES);
      expect(servedLines(id, "due")).toEqual(BLACK_MOVE_LINES);
      expect(servedLines(id, "recommended")).toEqual(BLACK_MOVE_LINES);
      expect(repertoireScopeCounts(listRepertoireDrillMoves(db, id), now)).toEqual({
        recommended: 4,
        due: 4,
        all: 4,
        missed: 0,
      });
    });

    it("serves a move that is not due for all alone, as it does for a White move", () => {
      const id = addBlackUnit();
      addCards(BLACK_ROWS, (lineText) => lineText !== "d4 d5 c4", true, "black");
      expect(servedLines(id, "all")).toEqual(BLACK_MOVE_LINES);
      expect(servedLines(id, "due")).toEqual(BLACK_MOVE_LINES.slice(0, 3));
      expect(servedLines(id, "recommended")).toEqual(BLACK_MOVE_LINES.slice(0, 3));
      expect(repertoireScopeCounts(listRepertoireDrillMoves(db, id), now)).toEqual({
        recommended: 3,
        due: 3,
        all: 4,
        missed: 0,
      });
    });

    it("serves every move of a wide Black unit for all and due, and the first ten for recommended", () => {
      // 1...c6 against 1.e4, then 2...d5 against eleven second moves of White's: twelve moves of
      // Black's, the likelier second move first.
      const seconds = ["d4", "Nc3", "Nf3", "c4", "Bc4", "g3", "d3", "b3", "Qe2", "f4", "Ne2"];
      const rows: FixtureRow[] = [
        ["", "e4", 1],
        ["e4", "c6", 1],
        ...seconds.flatMap((white, index): FixtureRow[] => [
          ["e4 c6", white, 1 - index * 0.05],
          [`e4 c6 ${white}`, "d5", 1 - index * 0.05],
        ]),
      ];
      const id = addBlackUnit(rows);
      addBlackCards(rows);
      const order = ["e4 c6", ...seconds.map((white) => `e4 c6 ${white} d5`)];

      expect(servedLines(id, "all")).toEqual(order);
      expect(servedLines(id, "due")).toEqual(order);
      // The limit is pinned as the number ten, not as the constant the drill reads it from.
      expect(order).toHaveLength(12);
      expect(servedLines(id, "recommended")).toEqual(order.slice(0, 10));
    });

    it("starts a drill on exactly the moves the counts offered for each scope", async () => {
      const id = addBlackUnit();
      addBlackCards();
      const service = boot();
      for (const scope of ["recommended", "due", "all"] as const) {
        expect(drillOf(await start(service, id, scope)).moves_left).toBe(4);
      }
    });
  });

  describe("at the level of a side", () => {
    it("drills the Black units alone from a Black unit, and the White ones alone from a White unit", async () => {
      const black = addBlackUnit();
      addBlackCards();
      const white = addVariation("Classical", ITALIAN_ROWS);
      addCards(ITALIAN_ROWS);
      const service = boot();

      const blackDrill = await startAt(service, black, "all", "side");
      expect(drillOf(blackDrill)).toMatchObject({ level: "side", moves_left: 4 });
      expect(blackDrill.orientation).toBe("black");
      expect(lineSan(blackDrill)).toEqual(["e4"]);

      const whiteDrill = await startAt(service, white, "all", "side");
      expect(drillOf(whiteDrill)).toMatchObject({ level: "side", moves_left: 6 });
      expect(whiteDrill.orientation).toBe("white");
      expect(lineSan(whiteDrill)).toEqual([]);
    });
  });
});

describe("a repertoire drill of a White unit that starts 1.d4", () => {
  // The London System: 1.d4 d5 2.Bf4 Nf6 3.e3, three moves of White's.
  const LONDON_ROWS: FixtureRow[] = [
    ["", "d4", 1],
    ["d4", "d5", 1],
    ["d4 d5", "Bf4", 1],
    ["d4 d5 Bf4", "Nf6", 1],
    ["d4 d5 Bf4 Nf6", "e3", 1],
  ];
  const addLondon = (): number => addVariation("London System", LONDON_ROWS, "London System");

  it("asks 1.d4 first, at ply 1 from the starting position, with the board turned to White", async () => {
    const id = addLondon();
    const first = listRepertoireDrillMoves(db, id)[0];
    expect(first).toMatchObject({ san: "d4", uci: "d2d4", ply: 1, line: [] });

    const service = boot();
    const state = await start(service, id, "all");
    expect(state.orientation).toBe("white");
    expect(state.turn).toBe("white");
    expect(state.fen).toBe(new Chess().fen());
    expect(state.moves).toEqual([]);
    expect(state.last_move).toBeNull();
    expect(state.status).toBe("prompt");
    expect(state.input_enabled).toBe(true);
    expect(drillOf(state)).toMatchObject({ first_pass: true, answer: { uci: "d2d4", san: "d4" } });
    const run = db.prepare("SELECT color FROM training_runs").get();
    expect(run).toEqual({ color: "white" });
  });

  it("plays Black's replies between the asked moves of the line and solves it", async () => {
    const id = addLondon();
    addCards(LONDON_ROWS);
    const service = boot();
    let state = await start(service, id, "all");
    expect(drillOf(state)).toMatchObject({ first_pass: false, moves_left: 3 });

    state = await play(service, state, "d4");
    expect(lineSan(state)).toEqual(["d4", "d5"]);
    state = await play(service, state, "Bf4");
    expect(lineSan(state)).toEqual(["d4", "d5", "Bf4", "Nf6"]);
    state = await play(service, state, "e3");
    expect(lineSan(state)).toEqual(["d4", "d5", "Bf4", "Nf6", "e3"]);
    expect(whoPlayed(state)).toEqual(["student", "reply", "student", "reply", "student"]);
    expect(state.status).toBe("solved");
    state = await next(service, state);
    expect(drillOf(state).result).toEqual({ practised: 3, first_try_right: 3 });
  });

  it("rates 1.d4 on its first attempt, Good when right and Again after a wrong try", async () => {
    const id = addLondon();
    addCards(LONDON_ROWS);
    const service = boot();
    let state = await start(service, id, "all");
    state = await play(service, state, "e4");
    state = await play(service, state, "d4");
    expect(loggedDrillGrades()).toEqual([1]);
    expect(firstAttempts()).toEqual([attemptOf("", "d4", id, 0)]);
    expect(cardOf("", "d4")).toMatchObject({ fsrs_state: 3, lapses: 1, reviews: 3 });
  });
});

describe("skipping first showings of a line drill", () => {
  // Five White moves on one line: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.c3 Nf6 5.d4.
  const FIVE_MOVE_ROWS: FixtureRow[] = [
    ...SETUP_ROWS,
    ["e4 e5 Nf3 Nc6 Bc4", "Bc5", 1],
    ["e4 e5 Nf3 Nc6 Bc4 Bc5", "c3", 1],
    ["e4 e5 Nf3 Nc6 Bc4 Bc5 c3", "Nf6", 1],
    ["e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6", "d4", 1],
  ];

  const totalCards = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM repertoire_cards").get() as { n: number }).n;

  it("leaves the served first showing alone and serves the other four moves directly and rated", async () => {
    const id = addVariation("Five moves", FIVE_MOVE_ROWS);
    const log = new RecordingLog();
    const service = boot(undefined, log);

    let state = await start(service, id, "due");
    expect(drillOf(state)).toMatchObject({
      first_pass: true,
      answer: { uci: "e2e4", san: "e4" },
      new_moves: 4,
      moves_left: 5,
    });

    // Advance the clock slightly before skipping so card timestamps are distinguishable from start.
    const skipAt = new Date(T0.getTime() + 10_000);
    now = skipAt;
    state = training(await service.trainingSkipFirstShowings(state.activity_id));

    expect(drillOf(state)).toMatchObject({
      first_pass: true,
      answer: { uci: "e2e4", san: "e4" },
      new_moves: 0,
      moves_left: 5,
    });
    expect(totalCards()).toBe(5);
    for (const [lineText, san] of [
      ["e4 e5", "Nf3"],
      ["e4 e5 Nf3 Nc6", "Bc4"],
      ["e4 e5 Nf3 Nc6 Bc4 Bc5", "c3"],
      ["e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6", "d4"],
    ] as const) {
      expect(cardOf(lineText, san)).toMatchObject({
        next_review_at: skipAt.toISOString(),
        reviews: 0,
      });
    }
    expect(log.named("training.first_showings_skipped")).toEqual([
      expect.objectContaining({
        fields: {
          activity_id: state.activity_id,
          level: "variation",
          cards_created: 4,
          moves_flipped: 4,
        },
      }),
    ]);

    // Playing the served first showing rates nothing, and the next four moves are asked directly.
    now = new Date(skipAt.getTime() + 1000);
    state = await play(service, state, "e4");
    expect(loggedDrillGrades()).toEqual([]);
    expect(drillOf(state)).toMatchObject({ first_pass: false, answer: null, new_moves: 0 });

    // Move 2 answered right on first attempt: grade 3 (Good).
    state = await play(service, state, "Nf3");
    expect(loggedDrillGrades()).toEqual([3]);
    expect(drillOf(state)).toMatchObject({ first_pass: false, answer: null, moves_right: 1 });

    // Move 3 answered wrong then right: one grade 1 (Again) row.
    state = await play(service, state, "Bb5");
    expect(loggedDrillGrades()).toEqual([3, 1]);
    state = await play(service, state, "Bc4");
    expect(loggedDrillGrades()).toEqual([3, 1]);
    expect(drillOf(state)).toMatchObject({ first_pass: false, answer: null, moves_wrong: 1 });

    // Move 4 answered right: grade 3.
    state = await play(service, state, "c3");
    expect(loggedDrillGrades()).toEqual([3, 1, 3]);
    expect(drillOf(state)).toMatchObject({ first_pass: false, answer: null });

    // Move 5 answered right: grade 3.
    state = await play(service, state, "d4");
    expect(loggedDrillGrades()).toEqual([3, 1, 3, 3]);
    expect(state.status).toBe("failed");
  });

  it("creates cards for every move of the drill's level, not just the queue, and leaves other levels alone", async () => {
    // 12 moves in the variation; `recommended` holds 10 of them.
    const wideId = addVariation("Wide", WIDE_ROWS, "Italian Game");
    const otherId = addVariation(
      "London",
      [
        ["", "d4", 1],
        ["d4", "d5", 1],
        ["d4 d5", "Bf4", 1],
      ],
      "London System",
    );
    const log = new RecordingLog();
    const service = boot(undefined, log);

    let state = await start(service, wideId, "recommended");
    // Move 1 (1.e4) already got its card when served; the other 11 moves of the variation have none.
    expect(drillOf(state)).toMatchObject({ moves_left: 10, new_moves: 11, first_pass: true });

    state = training(await service.trainingSkipFirstShowings(state.activity_id));
    expect(drillOf(state).new_moves).toBe(0);
    // All 12 moves of Wide have cards; none of London's moves got a card.
    expect(totalCards()).toBe(12);
    expect(cardOf("", "d4")).toBeUndefined();
    expect(cardOf("d4 d5", "Bf4")).toBeUndefined();
    // 11 cards created for the level, 9 moves flipped in the 10-move queue (1 served stayed intro).
    expect(log.named("training.first_showings_skipped")[0]?.fields).toEqual({
      activity_id: state.activity_id,
      level: "variation",
      cards_created: 11,
      moves_flipped: 9,
    });
    expect(listRepertoireDrillMoves(db, otherId).every((m) => m.card === null)).toBe(true);
  });

  it("covers every variation of the group or side when widened, and leaves the other colour alone", async () => {
    const italianA = addVariation("Classical", ITALIAN_ROWS, "Italian Game", "white");
    const italianB = addVariation(
      "Pianissimo",
      [...SETUP_ROWS, ["e4 e5 Nf3 Nc6 Bc4", "Bc5", 1], ["e4 e5 Nf3 Nc6 Bc4 Bc5", "b4", 1]],
      "Italian Game",
      "white",
    );
    const london = addVariation(
      "London",
      [
        ["", "d4", 1],
        ["d4", "d5", 1],
        ["d4 d5", "Bf4", 1],
      ],
      "London System",
      "white",
    );
    const sicilian = addVariation(
      "Sicilian",
      [
        ["", "e4", 1],
        ["e4", "c5", 1],
      ],
      "Sicilian Defense",
      "black",
    );
    const log = new RecordingLog();
    const service = boot(undefined, log);

    // Group level covers Italian A (6 moves) + Italian B's unique 4.b4 (1 move) = 7 unique moves.
    let state = await startAt(service, italianA, "due", "group");
    expect(drillOf(state).new_moves).toBe(6);
    state = training(await service.trainingSkipFirstShowings(state.activity_id));
    expect(drillOf(state).new_moves).toBe(0);
    expect(cardOf("e4 e5 Nf3 Nc6 Bc4 Bc5", "b4")).toBeDefined();
    expect(cardOf("", "d4")).toBeUndefined();
    expect(cardOf("e4", "c5")).toBeUndefined();
    expect(log.named("training.first_showings_skipped")[0]?.fields).toEqual({
      activity_id: state.activity_id,
      level: "group",
      cards_created: 6,
      moves_flipped: 6,
    });

    // Side level on White serves 1.e4 (already carded) first, so both of London's moves (1.d4 and
    // 2.Bf4) have no card yet; skipping creates both while still leaving Black's Sicilian untouched.
    state = await startAt(service, london, "due", "side");
    expect(drillOf(state).new_moves).toBe(2);
    state = training(await service.trainingSkipFirstShowings(state.activity_id));
    expect(drillOf(state).new_moves).toBe(0);
    expect(cardOf("", "d4")).toBeDefined();
    expect(cardOf("d4 d5", "Bf4")).toBeDefined();
    expect(cardOf("e4", "c5")).toBeUndefined();
    expect(log.named("training.first_showings_skipped")[1]?.fields).toEqual({
      activity_id: state.activity_id,
      level: "side",
      cards_created: 2,
      moves_flipped: 2,
    });
    expect(listRepertoireDrillMoves(db, italianB).every((m) => m.card !== null)).toBe(true);
    expect(listRepertoireDrillMoves(db, sicilian).every((m) => m.card === null)).toBe(true);
  });

  it("is idempotent when sent twice", async () => {
    const id = addVariation("Five moves", FIVE_MOVE_ROWS);
    const log = new RecordingLog();
    const service = boot(undefined, log);

    let state = await start(service, id, "due");
    state = training(await service.trainingSkipFirstShowings(state.activity_id));
    const cardsAfterFirst = db
      .prepare(
        "SELECT position_key, move_uci, introduced_at, next_review_at FROM repertoire_cards ORDER BY id",
      )
      .all();

    now = new Date(T0.getTime() + 60_000);
    state = training(await service.trainingSkipFirstShowings(state.activity_id));
    const cardsAfterSecond = db
      .prepare(
        "SELECT position_key, move_uci, introduced_at, next_review_at FROM repertoire_cards ORDER BY id",
      )
      .all();

    expect(cardsAfterSecond).toEqual(cardsAfterFirst);
    expect(drillOf(state)).toMatchObject({
      first_pass: true,
      answer: { uci: "e2e4", san: "e4" },
      new_moves: 0,
    });
    expect(log.named("training.first_showings_skipped")[1]?.fields).toEqual({
      activity_id: state.activity_id,
      level: "variation",
      cards_created: 0,
      moves_flipped: 0,
    });
  });

  it("starts a later run with no intro move, while a move stored afterwards is still shown first", async () => {
    const id = addVariation("Five moves", FIVE_MOVE_ROWS);
    const service = boot();

    let state = await start(service, id, "due");
    await service.trainingSkipFirstShowings(state.activity_id);
    await service.endTraining(state.activity_id);

    // A later run on the same variation serves every move directly with first_pass false.
    state = await start(service, id, "all");
    expect(drillOf(state)).toMatchObject({ first_pass: false, answer: null, new_moves: 0 });
    for (const san of ["e4", "Nf3", "Bc4", "c3", "d4"]) {
      expect(drillOf(state)).toMatchObject({ first_pass: false, answer: null });
      state = await play(service, state, san);
    }
    await service.endTraining(state.activity_id);

    // A move stored afterwards has no card and is still shown with first_pass true.
    const afterLine = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6", "d4"];
    const replyPlace = placeOf(afterLine.join(" "), "exd4");
    upsertRepertoireReply(db, {
      repertoireId: id,
      positionKey: replyPlace.positionKey,
      ply: 10,
      line: afterLine,
      reach: 1,
      openingName: "Italian Game",
      uci: replyPlace.uci,
      san: "exd4",
      share: null,
      source: "explorer",
    });
    const ownLine = [...afterLine, "exd4"];
    const ownPlace = placeOf(ownLine.join(" "), "cxd4");
    insertRepertoireOwnMove(db, {
      repertoireId: id,
      positionKey: ownPlace.positionKey,
      ply: 11,
      line: ownLine,
      reach: 1,
      openingName: "Italian Game",
      uci: ownPlace.uci,
      san: "cxd4",
      share: null,
      source: "explorer",
      cpLoss: 0,
      evalCp: 30,
      results: null,
    });

    state = await start(service, id, "due");
    expect(drillOf(state)).toMatchObject({
      first_pass: true,
      answer: { san: "cxd4" },
      new_moves: 0,
    });
  });

  it("refuses with invalid_state on a non-repertoire run", async () => {
    db.prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
       VALUES ('p1', 'test', 'fork', 'easy', '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', '["a1a8"]', '["Ra8#"]', 'why')`,
    ).run();
    const service = boot();
    const state = training(await service.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(await code(service.trainingSkipFirstShowings(state.activity_id))).toBe("invalid_state");
  });
});
