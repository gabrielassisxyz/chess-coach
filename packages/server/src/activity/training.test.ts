import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActivityState,
  isFixedPracticeMotif,
  LICHESS_PRACTICE_MOTIFS,
  MIX_PRACTICE_MOTIF,
  type TrainingActivity,
  TrainingActivitySchema,
  UNNAMED_OPENING,
} from "@chess-coach/shared";
import { Chess } from "chess.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { makeWorld } from "../../test/fakes/fake-world.js";
import { ScriptedEngine } from "../../test/fakes/scripted-engine.js";
import { insertGradedGame, START_FEN } from "../../test/fixture-game.js";
import type { Clock } from "../clock.js";
import { type CoachNotification, renderNotifications } from "../coach/notify.js";
import { buildSrsTools } from "../coach/srs-tools.js";
import { appendChatMessage, createCoachSession, listChatTail } from "../db/chat.js";
import { insertFoundPosition, setFoundNote } from "../db/found-positions.js";
import { type Database, openDatabase } from "../db/open.js";
import { listPuzzles, recordPuzzleAttempt } from "../db/puzzles.js";
import { getCard, insertCard, setExplanation, updateSchedule } from "../db/srs.js";
import { endRunsLeftOpenAtStart } from "../db/training.js";
import { GameService } from "../game/service.js";
import { type Log, RecordingLog, silentLog } from "../log.js";
import { positionKey, puzzleId } from "../openings/from-games.js";
import { computeThemeStats } from "../progress/theme-stats.js";
import { FILLER_PUZZLE_EXPLANATION, importLichessPuzzles } from "../puzzles/lichess-import.js";
import { currentPuzzleRating, setPuzzleRating } from "../puzzles/rating.js";
import { createCardsFromGame } from "../srs/cards.js";
import { ReviewDesk } from "../srs/review.js";
import { ActivityService } from "./service.js";

const T0 = new Date("2026-03-01T00:00:00.000Z");
const BACK_RANK = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";
const FORK = "r2qk2r/pQp1ppbp/6p1/1N3P2/2p2B2/8/PPn2P1P/R4K1R w kq - 2 14";
// What a finished item leaves on the board: 1.d4 from the start for the card, the fork puzzle once
// its last move a1c1 is played.
const FEN_AFTER_D4_FROM_START = "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1";
const FORK_PUZZLE_SOLVED_FEN = "r2q1k1r/pQN1ppbp/6p1/5P2/2p2B2/8/PPn2P1P/2R2K1R b - - 2 15";
const FORK_LINE = ["b5c7", "e8f8", "a1c1"];
// The fork puzzle once the student played b5c7 and the reply e8f8 came back.
const FORK_PUZZLE_AFTER_REPLY_FEN = "r2q1k1r/pQN1ppbp/6p1/5P2/2p2B2/8/PPn2P1P/R4K1R w - - 1 15";
// A Lichess puzzle of five plies (Bxd6 Bxd6 Ne4+ Ke1 Nxd6): the shape of a card that came back
// asking its first move alone.
const LICHESS_FORK = "r3kb1r/pp1b1ppp/n2Npn2/8/2P2B2/4PN2/PP1K1PPP/R4B1R b kq - 1 16";
const LICHESS_FORK_LINE = ["f8d6", "f4d6", "f6e4", "d2e1", "e4d6"];
const LICHESS_FORK_AFTER_FIRST_REPLY =
  "r3k2r/pp1b1ppp/n2Bpn2/8/2P5/4PN2/PP1K1PPP/R4B1R b kq - 0 17";
const LICHESS_FORK_AFTER_SECOND_REPLY =
  "r3k2r/pp1b1ppp/n2Bp3/8/2P1n3/4PN2/PP3PPP/R3KB1R b kq - 2 18";
const LICHESS_FORK_SOLVED = "r3k2r/pp1b1ppp/n2np3/8/2P5/4PN2/PP3PPP/R3KB1R w kq - 0 19";
// A quiet move, a quiet reply and then a back-rank mate that either rook delivers.
const TWO_MATES = "6k1/5ppp/8/8/4n3/8/5PPP/RR4K1 w - - 0 1";
const TWO_MATES_LINE = ["h2h3", "e4c5", "a1a8"];
const TWO_MATES_BY_B_ROOK = "1R4k1/5ppp/8/2n5/8/7P/5PP1/R5K1 b - - 2 2";
const TWO_ROOK_BACK_RANK = "6k1/5ppp/8/8/8/8/5PPP/RR4K1 w - - 0 1";

let tmp: string;
let db: Database;
const fixedClock: Clock = { now: () => T0 };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-training-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function addPuzzle(
  id: string,
  motif: string,
  fen: string,
  solution: string[],
  rating: number | null = null,
): void {
  db.prepare(
    `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation, difficulty_rating)
     VALUES (?, 'test', ?, 'easy', ?, ?, '[]', 'why', ?)`,
  ).run(id, motif, fen, JSON.stringify(solution), rating);
}

function addCard(expectedUci = "d2d4"): number {
  const card = insertCard(db, {
    sourceKind: "teaching",
    sourceGameId: null,
    sourceMoveId: null,
    promptFen: START_FEN,
    studentColor: "white",
    playedUci: "e2e4",
    expectedUci,
    cpLoss: 100,
    classification: "inaccuracy",
    explanation: null,
    createdAt: T0.toISOString(),
  });
  return (card as { id: number }).id;
}

// A card the way a missed puzzle leaves it: the puzzle's position and first move, and its id.
function addPuzzleCard(puzzleId: string | null, fen: string, expectedUci: string): number {
  const card = insertCard(db, {
    sourceKind: "teaching",
    sourceGameId: null,
    sourceMoveId: null,
    promptFen: fen,
    studentColor: fen.split(" ")[1] === "b" ? "black" : "white",
    playedUci: null,
    expectedUci,
    cpLoss: null,
    classification: null,
    explanation: null,
    createdAt: T0.toISOString(),
    puzzleId,
  });
  return (card as { id: number }).id;
}

// Deterministic source for the shuffles of a puzzle queue, so a run is the same on every test run.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup(clock: Clock = fixedClock, log: Log = silentLog, shuffleRandom?: () => number) {
  const game = new GameService({ db, engine: new ScriptedEngine(["e7e5"]) });
  const session = createCoachSession(db, { promptVersion: "v" });
  const notifications = { sessionId: () => session.id };
  const desk = new ReviewDesk({ db, clock, notifications });
  const flushed = vi.fn();
  const activity = new ActivityService({
    db,
    game,
    training: { desk, notifications, clock, onNotification: flushed, shuffleRandom },
    log,
  });
  const rows = () =>
    listChatTail(db, session.id, 100).map((row) => JSON.parse(row.contentJson) as { type: string });
  const say = (text: string): number => {
    const row = appendChatMessage(
      db,
      session.id,
      { role: "user", kind: "text", contentJson: JSON.stringify({ text }) },
      clock,
    );
    activity.linkUserMessage(row.id);
    return row.id;
  };
  const notes = () =>
    listChatTail(db, session.id, 100)
      .filter((row) => row.kind === "notification")
      .map((row) => JSON.parse(row.contentJson) as CoachNotification);
  return { activity, game, flushed, rows, say, notes };
}

const training = (state: ActivityState | null): TrainingActivity => {
  if (state?.kind !== "training") throw new Error(`expected training, got ${state?.kind}`);
  return state;
};

// The run that is still open, as its row stores the queue it was drawn with.
function openRun(): { items: { kind: string; id: string | number }[] } | null {
  const row = db
    .prepare("SELECT items_json FROM training_runs WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1")
    .get() as { items_json: string } | undefined;
  return row
    ? { items: JSON.parse(row.items_json) as { kind: string; id: string | number }[] }
    : null;
}

const code = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return "no error";
};

describe("queue materialization", () => {
  it("serves a first batch of ten puzzles, with no length, when the inventory is larger", async () => {
    for (let i = 0; i < 12; i++) {
      const id = `p${String(i).padStart(2, "0")}`;
      addPuzzle(id, "fork", BACK_RANK, ["a1a8"], 1200);
      db.prepare("INSERT INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, ?, ?)").run(
        "fork",
        1200,
        id,
      );
    }
    const { activity } = setup();
    const state = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(state.item).toMatchObject({ kind: "puzzle", position_in_queue: 1 });
    expect(state.item).not.toHaveProperty("queue_length");
    expect(openRun()?.items).toHaveLength(10);
  });

  it("holds a set of ten, and says so, when the motif has unrated puzzles only", async () => {
    for (let i = 0; i < 12; i++)
      addPuzzle(`p${String(i).padStart(2, "0")}`, "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    const state = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(state.item).toMatchObject({ kind: "puzzle", position_in_queue: 1, queue_length: 10 });
  });

  it("serves a short queue, and says how short, when the motif has few puzzles", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    addPuzzle("f2", "fork", BACK_RANK, ["a1a8"]);
    addPuzzle("pin1", "pin", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    const state = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(state.item.queue_length).toBe(2);
  });

  it("carries the motif filter for a single motif and null for Any", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"], 1200);
    addPuzzle("p1", "pin", BACK_RANK, ["a1a8"], 1200);
    const { activity } = setup();
    const single = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(single.run_motif).toBe("fork");
    await activity.endTraining();
    const any = training(await activity.startTraining({ mode: "puzzles" }));
    expect(any.run_motif).toBeNull();
  });

  it("refuses a queue with nothing in it", async () => {
    const { activity } = setup();
    expect(await code(activity.startTraining({ mode: "puzzles", motif: "nope" }))).toBe(
      "empty_queue",
    );
    expect(await code(activity.startTraining({ mode: "srs" }))).toBe("empty_queue");
    expect(activity.current()).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM training_runs").get()).toEqual({ n: 0 });
  });

  it.each(["mateIn2", "deflection", "rookEndgame", "enPassant"])(
    "serves %s from puzzle_themes drawn around the student's rating",
    async (theme) => {
      const insertTheme = db.prepare(
        "INSERT INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, ?, ?)",
      );
      for (let i = 0; i < 10; i++) {
        addPuzzle(`near-${i}`, "tactics", BACK_RANK, ["a1a8"], 1150);
        insertTheme.run(theme, 1150, `near-${i}`);
        addPuzzle(`far-${i}`, "tactics", BACK_RANK, ["a1a8"], 1800);
        insertTheme.run(theme, 1800, `far-${i}`);
      }
      addPuzzle("other", "fork", BACK_RANK, ["a1a8"], 1200);
      insertTheme.run("fork", 1200, "other");
      const { activity } = setup();
      const ids = (prefix: string): string[] =>
        Array.from({ length: 10 }, (_, i) => `${prefix}-${i}`);
      const storedIds = (): string[] =>
        (openRun()?.items ?? []).map((item) => (item as { id: string }).id).sort();
      const near = training(await activity.startTraining({ mode: "puzzles", motif: theme }));
      expect(near.run_motif).toBe(theme);
      expect(storedIds()).toEqual(ids("near"));
      await activity.endTraining();
      setPuzzleRating(db, 1800, T0.toISOString());
      await activity.startTraining({ mode: "puzzles", motif: theme });
      expect(storedIds()).toEqual(ids("far"));
    },
  );

  it("keeps fixed choices on their themed draw and plain listing", async () => {
    const insertTheme = db.prepare(
      "INSERT INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, ?, ?)",
    );
    for (let i = 0; i < 10; i++) {
      addPuzzle(`fork-near-${i}`, "fork", BACK_RANK, ["a1a8"], 1180);
      insertTheme.run("fork", 1180, `fork-near-${i}`);
      addPuzzle(`fork-far-${i}`, "fork", BACK_RANK, ["a1a8"], 2200);
      insertTheme.run("fork", 2200, `fork-far-${i}`);
    }
    addPuzzle("trap-only", "opening_trap", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const forkIds = (openRun()?.items ?? []).map((item) => (item as { id: string }).id).sort();
    expect(forkIds).toEqual(Array.from({ length: 10 }, (_, i) => `fork-near-${i}`));
    await activity.endTraining();
    await activity.startTraining({ mode: "puzzles", motif: "opening_trap" });
    const trapIds = (openRun()?.items ?? []).map((item) => (item as { id: string }).id);
    expect(trapIds).toEqual(["trap-only"]);
  });

  it("binds unknown motifs safely and writes no run on refusal", async () => {
    addPuzzle("m1", "tactics", BACK_RANK, ["a1a8"], 1200);
    db.prepare("INSERT INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, ?, ?)").run(
      "mateIn2",
      1200,
      "m1",
    );
    const { activity } = setup();
    for (const bad of ["nope", "nope'", "' OR '1'='1", "mateIn2' OR '1'='1"]) {
      expect(await code(activity.startTraining({ mode: "puzzles", motif: bad }))).toBe(
        "empty_queue",
      );
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM training_runs").get()).toEqual({ n: 0 });
  });

  it("serves only the chosen colour in openings mode and refuses an empty inventory", async () => {
    addPuzzle("w1", "opening-white", BACK_RANK, ["a1a8"]);
    addPuzzle("b1", "opening-black", FORK, ["b5c7"]);
    addPuzzle("b2", "opening-black", BACK_RANK, ["a1a8"]);
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    const black = training(await activity.startTraining({ mode: "openings", color: "black" }));
    expect(black).toMatchObject({ mode: "openings", item: { motif: "opening-black" } });
    expect(black.item.queue_length).toBe(2);
    db.prepare("DELETE FROM puzzles WHERE motif = 'opening-white'").run();
    expect(await code(activity.startTraining({ mode: "openings", color: "white" }))).toBe(
      "empty_queue",
    );
    expect(await code(activity.startTraining({ mode: "openings" }))).toBe("empty_queue");
  });

  it("materializes the due cards for review mode", async () => {
    addCard();
    addCard();
    const { activity } = setup();
    const state = training(await activity.startTraining({ mode: "srs" }));
    expect(state).toMatchObject({
      mode: "srs",
      status: "prompt",
      orientation: "white",
      input_enabled: true,
      item: { kind: "card", position_in_queue: 1, queue_length: 2 },
    });
    expect(state.legal_moves).toHaveLength(20);
    expect(state.exposure_id).toBe((state.item as { exposure_id: string }).exposure_id);
  });

  describe("an unthemed queue that leans on the improvement areas", () => {
    const daysBeforeT0 = (days: number): string =>
      new Date(T0.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    let historyCount = 0;

    // A rated puzzle at the student's rating, served under each theme it carries: `puzzles.themes`
    // is what the unthemed sample and the statistics read, `puzzle_themes` what a themed draw reads.
    function addThemed(id: string, themes: readonly string[]): void {
      addPuzzle(id, "tactics", BACK_RANK, ["a1a8"], 1200);
      db.prepare("UPDATE puzzles SET themes = ? WHERE id = ?").run(themes.join(" "), id);
      const insertTheme = db.prepare(
        "INSERT INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, ?, ?)",
      );
      for (const theme of themes) insertTheme.run(theme, 1200, id);
    }

    // `<pool>-00`, `<pool>-01`, ...; a pool with no theme is the unthemed sample. The ids tell the
    // two kinds apart: a pool whose puzzles carry `opening` is never returned by the unthemed
    // sample, so it can only have come from a themed draw.
    function addPool(pool: string, count: number, themes: readonly string[] = []): void {
      for (let i = 0; i < count; i++) {
        const id = `${pool}-${String(i).padStart(2, "0")}`;
        if (themes.length > 0) addThemed(id, themes);
        else addPuzzle(id, "tactics", BACK_RANK, ["a1a8"], 1200);
      }
    }

    // Attempts on puzzles of the student's own that no draw can serve (popularity 0): they put a
    // theme on the statistics without adding to any pool.
    function addHistory(theme: string, played: number, firstTry: number, daysAgo = 1): void {
      for (let i = 0; i < played; i++) {
        const id = `history-${historyCount++}`;
        const right = i < firstTry;
        addPuzzle(id, "tactics", BACK_RANK, ["a1a8"], 1200);
        db.prepare("UPDATE puzzles SET themes = ?, popularity = 0 WHERE id = ?").run(theme, id);
        recordPuzzleAttempt(db, {
          puzzleId: id,
          attemptedAt: daysBeforeT0(daysAgo),
          solved: right,
          answered: [],
          failedPly: right ? null : 0,
          firstTry: right,
          tries: right ? 0 : 1,
          gaveUp: !right,
        });
      }
    }

    // Each theme missed 8 times in 8, the fewest a theme needs to be ranked, against a theme solved
    // first try every time, so the overall figure they are measured against sits well above them.
    function listAsWeakDaysAgo(daysAgo: number, ...themes: string[]): void {
      for (const theme of themes) addHistory(theme, 8, 0, daysAgo);
      addHistory("hangingPiece", 16, 16, daysAgo);
    }

    const listAsWeak = (...themes: string[]): void => listAsWeakDaysAgo(1, ...themes);

    const improvementAreas = (): string[] =>
      [...computeThemeStats(db, "30", fixedClock).improvement_areas].sort();

    const storedIds = (): string[] =>
      (openRun()?.items ?? []).map((item) => (item as { id: string }).id);

    const inPool = (ids: readonly string[], pool: string): string[] =>
      ids.filter((id) => id.startsWith(`${pool}-`));

    const withSeed = (seed: number) => setup(fixedClock, silentLog, seededRandom(seed));

    // Solves the ten puzzles of the first batch and asks for the one after the last, which draws
    // the second batch.
    async function passTheTenth(
      activity: ActivityService,
      start: TrainingActivity,
    ): Promise<TrainingActivity> {
      let state = start;
      for (let served = 0; served < 10; served++) {
        const solved = training(await activity.trainingTry("a1a8", state.activity_id));
        state = training(await activity.nextTrainingItem(solved.activity_id));
      }
      return state;
    }

    it("draws 3 of every batch of 10 from two listed themes, 2 for one and 1 for the other, and 7 from the unthemed sample", async () => {
      addPool("deflection", 12, ["deflection", "opening"]);
      addPool("pin", 12, ["pin", "opening"]);
      addPool("plain", 40);
      listAsWeak("deflection", "pin");
      expect(improvementAreas()).toEqual(["deflection", "pin"]);
      const perTheme = (ids: readonly string[]): number[] =>
        [inPool(ids, "deflection").length, inPool(ids, "pin").length].sort((a, b) => a - b);
      const { activity } = withSeed(1);
      const start = training(await activity.startTraining({ mode: "puzzles" }));
      const first = storedIds();
      expect(first).toHaveLength(10);
      expect(inPool(first, "plain")).toHaveLength(7);
      expect(perTheme(first)).toEqual([1, 2]);
      await passTheTenth(activity, start);
      expect(improvementAreas()).toEqual(["deflection", "pin"]);
      const second = storedIds().slice(10);
      expect(second).toHaveLength(10);
      expect(inPool(second, "plain")).toHaveLength(7);
      expect(perTheme(second)).toEqual([1, 2]);
    });

    it("takes one puzzle from each of three listed themes", async () => {
      for (const theme of ["deflection", "pin", "skewer"]) addPool(theme, 12, [theme, "opening"]);
      addPool("plain", 40);
      listAsWeak("deflection", "pin", "skewer");
      expect(improvementAreas()).toEqual(["deflection", "pin", "skewer"]);
      const { activity } = withSeed(2);
      await activity.startTraining({ mode: "puzzles" });
      const ids = storedIds();
      expect(inPool(ids, "deflection")).toHaveLength(1);
      expect(inPool(ids, "pin")).toHaveLength(1);
      expect(inPool(ids, "skewer")).toHaveLength(1);
      expect(inPool(ids, "plain")).toHaveLength(7);
    });

    it("starts the turns at a theme drawn with the shuffle source, so either theme can have the extra place", async () => {
      addPool("deflection", 12, ["deflection", "opening"]);
      addPool("pin", 12, ["pin", "opening"]);
      addPool("plain", 40);
      listAsWeak("deflection", "pin");
      // The first value of seed 7 is below one half and that of seed 1 above it.
      const placesOf = async (seed: number): Promise<number[]> => {
        const { activity } = withSeed(seed);
        await activity.startTraining({ mode: "puzzles" });
        const ids = storedIds();
        await activity.endTraining();
        return [inPool(ids, "deflection").length, inPool(ids, "pin").length];
      };
      expect(await placesOf(7)).toEqual([2, 1]);
      expect(await placesOf(1)).toEqual([1, 2]);
    });

    it("holds none of those puzzles when no theme is listed as an improvement area", async () => {
      addPool("deflection", 12, ["deflection", "opening"]);
      addPool("plain", 40);
      // Missed every time, but 7 attempts are too few for a theme to be ranked.
      addHistory("deflection", 7, 0);
      addHistory("hangingPiece", 16, 16);
      expect(improvementAreas()).toEqual([]);
      const { activity } = withSeed(1);
      const start = training(await activity.startTraining({ mode: "puzzles" }));
      expect(inPool(storedIds(), "plain")).toHaveLength(10);
      await passTheTenth(activity, start);
      expect(storedIds()).toHaveLength(20);
      expect(inPool(storedIds(), "plain")).toHaveLength(20);
    });

    it("reads the attempts of the last 30 days: older ones list nothing", async () => {
      addPool("pin", 12, ["pin", "opening"]);
      addPool("plain", 40);
      listAsWeakDaysAgo(40, "pin");
      expect(improvementAreas()).toEqual([]);
      const { activity } = withSeed(1);
      await activity.startTraining({ mode: "puzzles" });
      expect(inPool(storedIds(), "plain")).toHaveLength(10);
      await activity.endTraining();
      listAsWeakDaysAgo(20, "pin");
      expect(improvementAreas()).toEqual(["pin"]);
      await activity.startTraining({ mode: "puzzles" });
      expect(inPool(storedIds(), "pin")).toHaveLength(3);
    });

    it("builds a batch exactly as before when nothing is listed", async () => {
      addPool("plain", 40);
      const asBefore = listPuzzles(db, { ratingAround: 1200, limit: 10 }, seededRandom(3));
      const { activity } = withSeed(3);
      await activity.startTraining({ mode: "puzzles" });
      expect(storedIds()).toHaveLength(10);
      expect(storedIds()).toEqual(asBefore.puzzles.map((puzzle) => puzzle.id));
    });

    it("draws from a theme that entered the list after the run started, in the next batch", async () => {
      addPool("skewer", 12, ["skewer", "opening"]);
      addPool("plain", 40);
      const { activity } = withSeed(3);
      const start = training(await activity.startTraining({ mode: "puzzles" }));
      expect(inPool(storedIds(), "plain")).toHaveLength(10);
      listAsWeak("skewer");
      expect(improvementAreas()).toEqual(["skewer"]);
      await passTheTenth(activity, start);
      expect(improvementAreas()).toEqual(["skewer"]);
      const second = storedIds().slice(10);
      expect(second).toHaveLength(10);
      expect(inPool(second, "skewer")).toHaveLength(3);
      expect(inPool(second, "plain")).toHaveLength(7);
    });

    it.each([1, 2, 3, 4, 5, 6])(
      "serves no puzzle twice in two batches when one puzzle carries both listed themes (seed %i)",
      async (seed) => {
        // The only puzzle of either theme, and also part of the unthemed sample.
        addThemed("both-00", ["deflection", "pin"]);
        addPool("plain", 25);
        listAsWeak("deflection", "pin");
        expect(improvementAreas()).toEqual(["deflection", "pin"]);
        const { activity } = withSeed(seed);
        const start = training(await activity.startTraining({ mode: "puzzles" }));
        expect(storedIds()).toContain("both-00");
        await passTheTenth(activity, start);
        const ids = storedIds();
        expect(ids).toHaveLength(20);
        expect(new Set(ids).size).toBe(20);
      },
    );

    // The listed theme `skewer` has no puzzle anywhere; its places go to the unthemed sample.
    const withMissingTheme: [string, string[], [number, number]][] = [
      ["one of two listed themes", ["deflection", "skewer"], [1, 2]],
      ["the only listed theme", ["skewer"], [0, 0]],
    ];
    it.each(withMissingTheme)(
      "still holds 10 puzzles when %s has no puzzle in the database",
      async (_name, listed, [fewest, most]) => {
        addPool("deflection", 12, ["deflection", "opening"]);
        addPool("plain", 40);
        listAsWeak(...listed);
        expect(improvementAreas()).toEqual([...listed].sort());
        const { activity } = withSeed(1);
        await activity.startTraining({ mode: "puzzles" });
        const ids = storedIds();
        const deflections = inPool(ids, "deflection").length;
        expect(ids).toHaveLength(10);
        expect(deflections).toBeGreaterThanOrEqual(fewest);
        expect(deflections).toBeLessThanOrEqual(most);
        expect(inPool(ids, "plain")).toHaveLength(10 - deflections);
      },
    );

    it("skips the opening phase when it is the only listed theme", async () => {
      addPool("opening", 12, ["opening"]);
      addPool("plain", 40);
      listAsWeak("opening");
      expect(improvementAreas()).toEqual(["opening"]);
      const { activity } = withSeed(1);
      const start = training(await activity.startTraining({ mode: "puzzles" }));
      expect(inPool(storedIds(), "plain")).toHaveLength(10);
      await passTheTenth(activity, start);
      expect(inPool(storedIds(), "opening")).toEqual([]);
      expect(storedIds()).toHaveLength(20);
    });

    it("puts the boosted puzzles at different positions in runs seeded differently", async () => {
      addPool("deflection", 12, ["deflection", "opening"]);
      addPool("pin", 12, ["pin", "opening"]);
      addPool("plain", 40);
      listAsWeak("deflection", "pin");
      const positionsOf = async (seed: number): Promise<number[]> => {
        const { activity } = withSeed(seed);
        await activity.startTraining({ mode: "puzzles" });
        const ids = storedIds();
        await activity.endTraining();
        return ids.flatMap((id, position) => (id.startsWith("plain-") ? [] : [position]));
      };
      const first = await positionsOf(1);
      const second = await positionsOf(2);
      expect(first).toHaveLength(3);
      expect(second).toHaveLength(3);
      expect(first).not.toEqual(second);
      expect(await positionsOf(1)).toEqual(first);
    });

    it("keeps the run unthemed: its motif is NULL and the activity shows no theme", async () => {
      addPool("deflection", 12, ["deflection", "opening"]);
      addPool("plain", 40);
      listAsWeak("deflection");
      const { activity } = withSeed(4);
      const start = training(await activity.startTraining({ mode: "puzzles" }));
      expect(inPool(storedIds(), "deflection")).toHaveLength(3);
      expect(start.run_motif).toBeNull();
      expect(db.prepare("SELECT motif FROM training_runs").all()).toEqual([{ motif: null }]);
      const eleventh = await passTheTenth(activity, start);
      expect(inPool(storedIds().slice(10), "deflection")).toHaveLength(3);
      expect(eleventh.run_motif).toBeNull();
      expect(db.prepare("SELECT motif FROM training_runs").all()).toEqual([{ motif: null }]);
    });

    it("builds a queue of a chosen motif as before, from the themed draw alone", async () => {
      addPool("fork", 25, ["fork"]);
      addPool("deflection", 12, ["deflection", "opening"]);
      listAsWeak("deflection");
      expect(improvementAreas()).toEqual(["deflection"]);
      const { activity } = withSeed(5);
      const start = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
      expect(start.run_motif).toBe("fork");
      expect(inPool(storedIds(), "fork")).toHaveLength(10);
      await passTheTenth(activity, start);
      expect(storedIds()).toHaveLength(20);
      expect(inPool(storedIds(), "fork")).toHaveLength(20);
    });
  });
});

describe("a card item", () => {
  it("keeps the card open on a wrong try, counts it and tells the coach nothing yet", async () => {
    addCard("d2d4");
    const { activity, flushed, rows } = setup();
    const served = training(await activity.startTraining({ mode: "srs" }));
    const state = training(await activity.trainingTry("e2e4"));
    expect(state).toMatchObject({
      status: "prompt",
      input_enabled: true,
      fen: served.fen,
      expected: null,
      tries: 1,
      last_try: { uci: "e2e4", san: "e4", correct: false },
      gave_up: false,
      solution_line: null,
    });
    expect(state.legal_moves).toEqual(served.legal_moves);
    expect(rows()).toEqual([]);
    expect(flushed).not.toHaveBeenCalled();
  });

  it("ends a card given up with the expected move as its solution line and tells the coach", async () => {
    addCard("d2d4");
    const { activity, flushed, rows } = setup();
    await activity.startTraining({ mode: "srs" });
    const state = training(await activity.trainingShowSolution());
    expect(state).toMatchObject({
      status: "failed",
      input_enabled: false,
      legal_moves: [],
      expected: { uci: "d2d4", san: "d4" },
      gave_up: true,
      solution_line: ["d2d4"],
      suggested_grade: 1,
    });
    expect(rows().map((r) => r.type)).toEqual(["srs_answer"]);
    expect(flushed).toHaveBeenCalled();
  });

  it("hides the expected move and highlights the played move on a right answer", async () => {
    addCard("d2d4");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    const state = training(await activity.trainingTry("d2d4"));
    expect(state).toMatchObject({
      status: "solved",
      input_enabled: false,
      legal_moves: [],
      last_move: { from: "d2", to: "d4" },
      expected: null,
    });
  });

  it("leaves the piece on its new square after a right answer, for the board and for exploration", async () => {
    addCard("d2d4");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    const state = training(await activity.trainingTry("d2d4"));
    expect(state).toMatchObject({
      status: "solved",
      fen: FEN_AFTER_D4_FROM_START,
      turn: "black",
      last_move: { from: "d2", to: "d4" },
      exploring: { fen: FEN_AFTER_D4_FROM_START, line_san: [] },
    });
  });

  it("keeps the piece there after a wrong try before the right one, and once the card is rated", async () => {
    addCard("d2d4");
    const { activity } = setup();
    const served = training(await activity.startTraining({ mode: "srs" }));
    await activity.trainingTry("e2e4");
    const solved = training(await activity.trainingTry("d2d4"));
    expect(solved).toMatchObject({
      fen: FEN_AFTER_D4_FROM_START,
      exploring: { fen: FEN_AFTER_D4_FROM_START },
    });
    const rated = training(
      await activity.rateCard((served.item as { exposure_id: string }).exposure_id, 3),
    );
    expect(rated).toMatchObject({
      status: "rated",
      fen: FEN_AFTER_D4_FROM_START,
      last_move: { from: "d2", to: "d4" },
    });
  });

  // `solution_line` is the UCI moves from `fen`, which the board plays one by one: a given-up card
  // that published the position after its move would have the board play it a second time.
  it("keeps the prompt position under a card given up, so its solution line plays from it", async () => {
    addCard("d2d4");
    const { activity } = setup();
    const served = training(await activity.startTraining({ mode: "srs" }));
    const state = training(await activity.trainingShowSolution());
    expect(state).toMatchObject({
      fen: served.fen,
      exploring: { fen: served.fen },
      last_move: null,
      solution_line: ["d2d4"],
    });
    const board = new Chess(state.fen);
    for (const uci of state.solution_line ?? []) {
      board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
    }
    expect(board.fen()).toBe(FEN_AFTER_D4_FROM_START);
  });

  it("logs the item served, the answer and the rating", async () => {
    addCard("d2d4");
    const log = new RecordingLog();
    const { activity } = setup(fixedClock, log);
    const start = training(await activity.startTraining({ mode: "srs" }));
    await activity.trainingTry("d2d4");
    const exposure = (start.item as { exposure_id: string }).exposure_id;
    await activity.rateCard(exposure, 3);
    expect(log.named("training.item_served")[0]?.fields).toMatchObject({ mode: "srs" });
    expect(log.named("training.answer")[0]?.fields).toMatchObject({
      try: true,
      uci: "d2d4",
      correct: true,
      tries: 0,
      expected: null,
    });
    expect(log.named("srs.rated")[0]?.fields).toMatchObject({ exposure_id: exposure, grade: 3 });
  });

  it("rates the card and moves its schedule", async () => {
    const id = addCard("d2d4");
    const before = getCard(db, id)?.nextReviewAt;
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    await activity.trainingTry("d2d4");
    const rated = training(
      await activity.rateCard((start.item as { exposure_id: string }).exposure_id, 3),
    );
    expect(rated.status).toBe("rated");
    expect(getCard(db, id)?.nextReviewAt).not.toBe(before);
  });

  it("refuses a move that is not legal in the position", async () => {
    addCard();
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    expect(await code(activity.trainingTry("e2e5"))).toBe("illegal_move");
  });

  it("asks every move of the puzzle's line, plays the replies and offers the rating only at the end", async () => {
    addPuzzle("lichess-db:03oA5", "fork", LICHESS_FORK, LICHESS_FORK_LINE);
    addPuzzleCard("lichess-db:03oA5", LICHESS_FORK, "f8d6");
    const { activity, rows } = setup();
    const served = training(await activity.startTraining({ mode: "srs" }));
    const exposure = (served.item as { exposure_id: string }).exposure_id;
    expect(served).toMatchObject({ fen: LICHESS_FORK, orientation: "black", moves: [] });

    const first = training(await activity.trainingTry("f8d6"));
    expect(first).toMatchObject({
      status: "in_progress",
      input_enabled: true,
      fen: LICHESS_FORK_AFTER_FIRST_REPLY,
      last_move: { from: "f4", to: "d6" },
      suggested_grade: null,
    });
    expect(await code(activity.rateCard(exposure, 3))).toBe("exposure_unanswered");
    expect(await code(activity.nextTrainingItem())).toBe("item_unfinished");

    const second = training(await activity.trainingTry("f6e4"));
    expect(second).toMatchObject({
      status: "in_progress",
      fen: LICHESS_FORK_AFTER_SECOND_REPLY,
      last_move: { from: "d2", to: "e1" },
    });

    const done = training(await activity.trainingTry("e4d6"));
    expect(done).toMatchObject({
      status: "solved",
      input_enabled: false,
      fen: LICHESS_FORK_SOLVED,
      last_move: { from: "e4", to: "d6" },
      suggested_grade: 3,
    });
    expect(done.moves?.map((move) => move.uci)).toEqual(LICHESS_FORK_LINE);
    expect(rows().map((row) => row.type)).toEqual(["srs_answer"]);
    expect(training(await activity.rateCard(exposure, 3)).status).toBe("rated");
  });

  it("asks the whole line of the card a missed puzzle leaves", async () => {
    addPuzzle("fk:3", "fork", FORK, FORK_LINE);
    const { activity } = setup();
    await activity.startTrainingItem({ kind: "puzzle", id: "fk:3" });
    await activity.trainingTry("f4e5");
    await activity.trainingShowSolution();
    await activity.endTraining();
    await activity.startTraining({ mode: "srs" });
    const mid = training(await activity.trainingTry("b5c7"));
    expect(mid).toMatchObject({ status: "in_progress", fen: FORK_PUZZLE_AFTER_REPLY_FEN });
  });

  it("plays the next move of the line after a right move that is not the last, and stays open", async () => {
    addPuzzle("fk:3", "fork", FORK, FORK_LINE);
    addPuzzleCard("fk:3", FORK, "b5c7");
    const { activity } = setup();
    const served = training(await activity.startTraining({ mode: "srs" }));
    const mid = training(await activity.trainingTry("b5c7"));
    expect(mid).toMatchObject({
      status: "in_progress",
      input_enabled: true,
      turn: "white",
      fen: FORK_PUZZLE_AFTER_REPLY_FEN,
      last_move: { from: "e8", to: "f8" },
      exploring: { fen: FORK_PUZZLE_AFTER_REPLY_FEN, line_san: [] },
      expected: null,
      gave_up: false,
      tries: 0,
    });
    expect(mid.legal_moves.length).toBeGreaterThan(0);
    expect(mid.moves).toEqual([
      { ply: 0, uci: "b5c7", san: "Nxc7+", by: "student" },
      { ply: 1, uci: "e8f8", san: "Kf8", by: "reply" },
    ]);
    expect(mid.item).toEqual(served.item);
    expect(activity.current()).toEqual(mid);
  });

  it("keeps the card open at the step of a wrong try and lists the try beside its ply", async () => {
    addPuzzle("fk:3", "fork", FORK, FORK_LINE);
    addPuzzleCard("fk:3", FORK, "b5c7");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    const mid = training(await activity.trainingTry("b5c7"));
    const wrong = training(await activity.trainingTry("a1b1"));
    expect(wrong).toMatchObject({
      status: "in_progress",
      input_enabled: true,
      fen: mid.fen,
      tries: 1,
      last_try: { uci: "a1b1", san: "Rb1", correct: false },
    });
    expect(wrong.wrong_tries).toEqual([{ ply: 2, uci: "a1b1", san: "Rb1" }]);
    expect(wrong.moves).toEqual(mid.moves);
    expect(db.prepare("SELECT ply, uci, correct FROM training_tries ORDER BY seq").all()).toEqual([
      { ply: 0, uci: "b5c7", correct: 1 },
      { ply: 2, uci: "a1b1", correct: 0 },
    ]);
  });

  it("ends solved on the last move of the line, which stays on the board", async () => {
    addPuzzle("fk:3", "fork", FORK, FORK_LINE);
    addPuzzleCard("fk:3", FORK, "b5c7");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingTry("b5c7");
    const done = training(await activity.trainingTry("a1c1"));
    expect(done).toMatchObject({
      status: "solved",
      input_enabled: false,
      legal_moves: [],
      fen: FORK_PUZZLE_SOLVED_FEN,
      last_move: { from: "a1", to: "c1" },
      exploring: { fen: FORK_PUZZLE_SOLVED_FEN, line_san: [] },
      expected: null,
    });
    expect(done.moves?.map((move) => [move.uci, move.by])).toEqual([
      ["b5c7", "student"],
      ["e8f8", "reply"],
      ["a1c1", "student"],
    ]);
  });

  it("ends solved on any checkmate at the last step, and shows the one the student played", async () => {
    addPuzzle("mm:3", "mate", TWO_MATES, TWO_MATES_LINE);
    addPuzzleCard("mm:3", TWO_MATES, "h2h3");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingTry("h2h3");
    const done = training(await activity.trainingTry("b1b8"));
    expect(done).toMatchObject({
      status: "solved",
      fen: TWO_MATES_BY_B_ROOK,
      last_move: { from: "b1", to: "b8" },
    });
    expect(done.moves?.at(-1)).toMatchObject({ ply: 2, uci: "b1b8", by: "student" });
    expect(JSON.stringify(done.moves)).not.toContain("a1a8");
  });

  it("ends a card given up at a later step as failed, at that step, with the rest of the line", async () => {
    addPuzzle("lichess-db:03oA5", "fork", LICHESS_FORK, LICHESS_FORK_LINE);
    addPuzzleCard("lichess-db:03oA5", LICHESS_FORK, "f8d6");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingTry("f8d6");
    const given = training(await activity.trainingShowSolution());
    expect(given).toMatchObject({
      status: "failed",
      input_enabled: false,
      legal_moves: [],
      gave_up: true,
      fen: LICHESS_FORK_AFTER_FIRST_REPLY,
      exploring: { fen: LICHESS_FORK_AFTER_FIRST_REPLY },
      last_move: null,
      expected: { uci: "f6e4", san: "Ne4+" },
      solution_line: ["f6e4", "d2e1", "e4d6"],
      suggested_grade: 1,
    });
    expect(given.moves?.map((move) => move.uci)).toEqual(["f8d6", "f4d6"]);
    const board = new Chess(given.fen);
    for (const uci of given.solution_line ?? []) {
      board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
    }
    expect(board.fen()).toBe(LICHESS_FORK_SOLVED);
    expect(await code(activity.trainingTry("f6e4"))).toBe("item_finished");
  });

  it("shows the whole line from the start to a card given up before any move", async () => {
    addPuzzle("lichess-db:03oA5", "fork", LICHESS_FORK, LICHESS_FORK_LINE);
    addPuzzleCard("lichess-db:03oA5", LICHESS_FORK, "f8d6");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    const given = training(await activity.trainingShowSolution());
    expect(given).toMatchObject({
      status: "failed",
      fen: LICHESS_FORK,
      expected: { uci: "f8d6", san: "Bxd6" },
      solution_line: LICHESS_FORK_LINE,
      moves: [],
    });
  });

  it("grades a card with no puzzle on its own move, even where a stored puzzle starts the same", async () => {
    addPuzzle("fk:3", "fork", FORK, FORK_LINE);
    addPuzzleCard(null, FORK, "b5c7");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    const done = training(await activity.trainingTry("b5c7"));
    expect(done.status).toBe("solved");
    expect(done.moves).toEqual([{ ply: 0, uci: "b5c7", san: "Nxc7+", by: "student" }]);
  });

  // Both rooks mate on the back rank: a puzzle takes either on its last step, a card of one move
  // only the move it stores.
  it("grades a card whose puzzle has one move on its own move, so only that move solves it", async () => {
    addPuzzle("bk:1", "mate", TWO_ROOK_BACK_RANK, ["a1a8"]);
    addPuzzleCard("bk:1", TWO_ROOK_BACK_RANK, "a1a8");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    const other = training(await activity.trainingTry("b1b8"));
    expect(other).toMatchObject({ status: "prompt", tries: 1 });
    const done = training(await activity.trainingTry("a1a8"));
    expect(done.status).toBe("solved");
    expect(done.moves).toHaveLength(1);
  });

  it("grades a card whose puzzle is gone on its own move", async () => {
    addPuzzleCard("gone:3", FORK, "b5c7");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    const done = training(await activity.trainingTry("b5c7"));
    expect(done.status).toBe("solved");
    expect(done.moves).toHaveLength(1);
  });

  describe("when the stored puzzle is not the line the card was made from", () => {
    const gradedOnItsOwnMove = async (): Promise<void> => {
      const { activity } = setup();
      await activity.startTraining({ mode: "srs" });
      const done = training(await activity.trainingTry("b5c7"));
      expect(done.status).toBe("solved");
      expect(done.moves).toHaveLength(1);
    };

    it("grades on its own move a card whose puzzle now starts from another position", async () => {
      addPuzzle("moved:3", "fork", FORK.replace(" kq ", " - "), FORK_LINE);
      addPuzzleCard("moved:3", FORK, "b5c7");
      await gradedOnItsOwnMove();
    });

    it("grades on its own move a card whose puzzle now starts with another move", async () => {
      addPuzzle("moved:3", "fork", FORK, ["f4e5", "e8f8", "a1c1"]);
      addPuzzleCard("moved:3", FORK, "b5c7");
      await gradedOnItsOwnMove();
    });

    it("grades on its own move a card whose puzzle line ends on the opponent's reply", async () => {
      addPuzzle("even:4", "fork", FORK, [...FORK_LINE, "d8d7"]);
      addPuzzleCard("even:4", FORK, "b5c7");
      await gradedOnItsOwnMove();
    });
  });
});

describe("a puzzle item", () => {
  it("plays the opponent reply after a right answer and re-enables input", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const mid = training(await activity.trainingTry("b5c7"));
    expect(mid).toMatchObject({
      status: "in_progress",
      input_enabled: true,
      last_move: { from: "e8", to: "f8" },
      item: { kind: "puzzle", cursor: 2, reply_uci: "e8f8" },
    });
    expect(mid.legal_moves.length).toBeGreaterThan(0);
    expect(rows()).toEqual([]);
    const done = training(await activity.trainingTry("a1c1"));
    expect(done).toMatchObject({ status: "solved", input_enabled: false, expected: null });
    expect(rows()).toEqual([]);
    const attempts = db.prepare("SELECT solved FROM puzzle_attempts").all();
    expect(attempts).toEqual([{ solved: 1 }]);
  });

  it("leaves the last move on the board for the board and for exploration once it is solved", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("b5c7");
    const done = training(await activity.trainingTry("a1c1"));
    expect(done).toMatchObject({
      status: "solved",
      fen: FORK_PUZZLE_SOLVED_FEN,
      last_move: { from: "a1", to: "c1" },
      exploring: { fen: FORK_PUZZLE_SOLVED_FEN, line_san: [] },
    });
  });

  it("keeps the puzzle open at the same step on a wrong try and records nothing final", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const state = training(await activity.trainingTry("f4e5"));
    expect(state).toMatchObject({
      status: "prompt",
      input_enabled: true,
      fen: FORK,
      item: { cursor: 0 },
      tries: 1,
      last_try: { uci: "f4e5", correct: false },
    });
    expect(rows()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM puzzle_attempts").get()).toEqual({ n: 0 });
  });

  it("reports the checkmate the student played when it differs from the stored move", async () => {
    addPuzzle("m1", "mate", "6k1/5ppp/8/8/8/8/5PPP/RR4K1 w - - 0 1", ["a1a8"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "mate" });
    const done = training(await activity.trainingTry("b1b8"));
    expect(done).toMatchObject({ status: "solved", input_enabled: false });
    expect(done.item).toMatchObject({ kind: "puzzle" });
    expect(JSON.stringify(done)).toContain("b1b8");
    expect(JSON.stringify(done)).not.toContain("a1a8");
    expect(db.prepare("SELECT solved, first_try FROM puzzle_attempts").all()).toEqual([
      { solved: 1, first_try: 1 },
    ]);
  });

  it("gives up mid-way and shows the rest of the line from the current step", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const mid = training(await activity.trainingTry("b5c7"));
    const state = training(await activity.trainingShowSolution());
    expect(state).toMatchObject({
      status: "failed",
      input_enabled: false,
      fen: mid.fen,
      expected: { uci: "a1c1" },
      gave_up: true,
      solution_line: ["a1c1"],
      suggested_grade: null,
    });
    expect(rows()).toMatchObject([{ type: "puzzle_result", solved: false, gave_up: true }]);
    expect(db.prepare("SELECT solved, failed_ply FROM puzzle_attempts").all()).toEqual([
      { solved: 0, failed_ply: 2 },
    ]);
    expect(await code(activity.trainingTry("a1c1"))).toBe("item_finished");
    expect(await code(activity.trainingShowSolution())).toBe("item_finished");
  });
});

describe("command routing and refusals", () => {
  it("refuses rating a puzzle, and rating a card that is not on the board", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("a1a8");
    expect(await code(activity.rateCard("anything", 3))).toBe("exposure_unknown");
    await activity.endTraining();

    addCard();
    const first = training(await activity.startTraining({ mode: "srs" }));
    await activity.trainingTry("d2d4");
    expect(await code(activity.rateCard("not-the-serving", 3))).toBe("exposure_unknown");
    const exposure = (first.item as { exposure_id: string }).exposure_id;
    expect(await code(activity.rateCard(exposure, 9))).toBe("invalid_grade");
    await activity.rateCard(exposure, 3);
    expect(await code(activity.rateCard(exposure, 3))).toBe("exposure_used");
  });

  it("refuses rating a card that is no longer on the board", async () => {
    addCard();
    addCard();
    const { activity } = setup();
    const first = training(await activity.startTraining({ mode: "srs" }));
    await activity.trainingTry("d2d4");
    await activity.nextTrainingItem();
    const earlier = (first.item as { exposure_id: string }).exposure_id;
    expect(await code(activity.rateCard(earlier, 3))).toBe("exposure_unknown");
  });

  it("refuses rating a card that was never answered", async () => {
    addCard();
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    const exposure = (start.item as { exposure_id: string }).exposure_id;
    expect(await code(activity.rateCard(exposure, 3))).toBe("exposure_unanswered");
  });

  it("refuses next until the item is answered, for a card and for a puzzle", async () => {
    addCard();
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    expect(await code(activity.nextTrainingItem())).toBe("item_unfinished");
    await activity.endTraining();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    expect(await code(activity.nextTrainingItem())).toBe("item_unfinished");
    await activity.trainingTry("b5c7");
    expect(await code(activity.nextTrainingItem())).toBe("item_unfinished");
  });

  it("lets a card advance once answered, rated or not", async () => {
    addCard();
    addCard();
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingTry("d2d4");
    const next = training(await activity.nextTrainingItem());
    expect(next).toMatchObject({ status: "prompt", item: { position_in_queue: 2 } });
  });

  it("refuses a second answer, a stale id and any command outside training", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    expect(await code(activity.nextTrainingItem())).toBe("not_in_training");
    const state = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(await code(activity.trainingTry("a1a8", state.activity_id + 1))).toBe("stale_activity");
    await activity.trainingTry("a1a8");
    expect(await code(activity.trainingTry("a1a8"))).toBe("item_finished");
  });
});

describe("the end of a queue", () => {
  it("writes one summary row with the counts, and only at the end", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    addPuzzle("f2", "fork", BACK_RANK, ["a1a8"]);
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("a1a8");
    await activity.nextTrainingItem();
    await activity.trainingTry("g1h1");
    await activity.trainingShowSolution();
    expect(rows().filter((r) => r.type === "training_summary")).toEqual([]);
    const ended = training(await activity.nextTrainingItem());
    expect(ended.summary).toEqual({ solved: 1, failed: 1 });
    expect(ended.input_enabled).toBe(false);
    expect(rows().filter((r) => r.type === "training_summary")).toEqual([
      { type: "training_summary", mode: "puzzles", solved: 1, failed: 1 },
    ]);
    expect(await code(activity.nextTrainingItem())).toBe("item_finished");
    expect(rows().filter((r) => r.type === "training_summary")).toHaveLength(1);
  });

  it("returns to the unfinished live game, or to nothing", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    await activity.newGame({ color: "white", elo: 1200 });
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const back = await activity.endTraining();
    expect(back?.kind).toBe("live_game");
    await activity.resign();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    expect(await activity.endTraining()).toBeNull();
    expect(activity.current()).toBeNull();
  });
});

// A clock the test moves by hand, so offsets from the moment an item was served are exact.
function steppingClock(): Clock & { advance(seconds: number): void } {
  let now = T0.getTime();
  return {
    now: () => new Date(now),
    advance: (seconds) => {
      now += seconds * 1000;
    },
  };
}

const events = () =>
  db.prepare("SELECT seq, at_ms, kind, uci FROM exploration_events ORDER BY seq").all();

describe("an imported Lichess puzzle", () => {
  const SAMPLE =
    "00sHx,q3k1nr/1pp1nQpp/3p4/1P2p3/4P3/B1PP1b2/B5PP/5K2 b k - 0 17,e8d7 a2e6 d7d8 f7f8,1498,76,87,178,mate mateIn2 middlegame short,https://lichess.org/game/yyznGmXs/black#34,,";

  async function* lines(): AsyncGenerator<string> {
    yield SAMPLE;
  }

  it("is served by its motif and plays through to solved", async () => {
    await importLichessPuzzles({ lines: lines(), db, clock: fixedClock, log: silentLog });
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles", motif: "checkmate" }));
    expect(start.fen).toBe("q5nr/1ppknQpp/3p4/1P2p3/4P3/B1PP1b2/B5PP/5K2 w - - 1 18");
    const mid = training(await activity.trainingTry("a2e6"));
    expect(mid).toMatchObject({
      status: "in_progress",
      item: { kind: "puzzle", reply_uci: "d7d8" },
    });
    const done = training(await activity.trainingTry("f7f8"));
    expect(done).toMatchObject({ status: "solved", input_enabled: false });
    expect(db.prepare("SELECT puzzle_id, solved FROM puzzle_attempts").all()).toEqual([
      { puzzle_id: "lichess-db:00sHx", solved: 1 },
    ]);
  });
});

describe("exploration", () => {
  it("records moves with the server clock and shows the explored position", async () => {
    addCard("d2d4");
    const clock = steppingClock();
    const { activity } = setup(clock);
    await activity.startTraining({ mode: "srs" });
    clock.advance(12);
    const state = training(await activity.trainingExplore({ kind: "move", uci: "e2e4" }));
    expect(state.exploring).toEqual({
      fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      line_san: ["e4"],
      trail: [{ seq: 1, at_ms: 12_000, kind: "move", line_san: ["e4"] }],
    });
    expect(state).toMatchObject({ fen: START_FEN, turn: "black", status: "prompt" });
    expect(state.legal_moves).toHaveLength(20);
    expect(state.last_move).toEqual({ from: "e2", to: "e4" });
    clock.advance(3);
    await activity.trainingExplore({ kind: "move", uci: "e7e5" });
    expect(events()).toEqual([
      { seq: 1, at_ms: 12_000, kind: "move", uci: "e2e4" },
      { seq: 2, at_ms: 15_000, kind: "move", uci: "e7e5" },
    ]);
  });

  it("never grades: the card stays unanswered and no notification is written", async () => {
    addCard("d2d4");
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "srs" });
    const state = training(await activity.trainingExplore({ kind: "move", uci: "d2d4" }));
    expect(state.status).toBe("prompt");
    expect(rows()).toEqual([]);
    expect(db.prepare("SELECT answered_at FROM training_items").all()).toEqual([
      { answered_at: null },
    ]);
  });

  it("takes one move back on undo and returns to the served position on reset", async () => {
    addCard();
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingExplore({ kind: "move", uci: "e2e4" });
    await activity.trainingExplore({ kind: "move", uci: "e7e5" });
    const undone = training(await activity.trainingExplore({ kind: "undo" }));
    expect(undone.exploring.line_san).toEqual(["e4"]);
    expect(undone.turn).toBe("black");
    const reset = training(await activity.trainingExplore({ kind: "reset" }));
    expect(reset.exploring).toMatchObject({ fen: START_FEN, line_san: [] });
    expect(reset.last_move).toBeNull();
    expect(events().map((e) => (e as { kind: string }).kind)).toEqual([
      "move",
      "move",
      "undo",
      "reset",
    ]);
  });

  it("refuses an illegal exploration move, or one with nothing to undo, and records nothing", async () => {
    addCard();
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    expect(await code(activity.trainingExplore({ kind: "move", uci: "e2e5" }))).toBe(
      "illegal_exploration",
    );
    expect(await code(activity.trainingExplore({ kind: "move" }))).toBe("illegal_exploration");
    expect(await code(activity.trainingExplore({ kind: "undo" }))).toBe("illegal_exploration");
    expect(await code(activity.trainingExplore({ kind: "reset" }))).toBe("illegal_exploration");
    expect(events()).toEqual([]);
  });

  it("refuses to explore outside a training item and once the item is answered", async () => {
    addCard();
    const { activity } = setup();
    expect(await code(activity.trainingExplore({ kind: "undo" }))).toBe("not_exploring");
    const state = training(await activity.startTraining({ mode: "srs" }));
    expect(await code(activity.trainingExplore({ kind: "undo" }, state.activity_id + 1))).toBe(
      "stale_activity",
    );
    await activity.trainingTry("d2d4");
    expect(await code(activity.trainingExplore({ kind: "move", uci: "e2e4" }))).toBe(
      "not_exploring",
    );
  });

  it("grades the answer against the served position, ignoring what was explored", async () => {
    addCard("d2d4");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingExplore({ kind: "move", uci: "e2e4" });
    await activity.trainingExplore({ kind: "move", uci: "e7e5" });
    const done = training(await activity.trainingTry("d2d4"));
    expect(done).toMatchObject({
      status: "solved",
      exploring: { fen: FEN_AFTER_D4_FROM_START, line_san: [] },
      legal_moves: [],
    });
    expect(db.prepare("SELECT answer_uci, correct, answered_at FROM training_items").all()).toEqual(
      [{ answer_uci: "d2d4", correct: 1, answered_at: T0.toISOString() }],
    );
    expect(await code(activity.trainingTry("d2d4"))).toBe("item_finished");
  });

  it("links chat lines to the open item and not to the gap before the next one", async () => {
    addCard();
    addCard();
    const { activity, say } = setup();
    await activity.startTraining({ mode: "srs" });
    const during = say("I think the centre matters");
    await activity.trainingTry("d2d4");
    say("that was easy");
    await activity.nextTrainingItem();
    const second = say("now this one");
    const links = db
      .prepare("SELECT item_id, message_id FROM item_messages ORDER BY message_id")
      .all();
    expect(links).toEqual([
      { item_id: 1, message_id: during },
      { item_id: 2, message_id: second },
    ]);
  });

  it("keeps a multi-move puzzle open and restarts exploring from the position after the reply", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingExplore({ kind: "move", uci: "f4e5" });
    const mid = training(await activity.trainingTry("b5c7"));
    expect(mid.status).toBe("in_progress");
    expect(mid.exploring).toEqual({ fen: mid.fen, line_san: [], trail: [] });
    expect(db.prepare("SELECT answered_at FROM training_items").all()).toEqual([
      { answered_at: null },
    ]);
    const next = training(await activity.trainingExplore({ kind: "move", uci: "a1c1" }));
    expect(next.exploring.line_san).toEqual(["Rc1"]);
    await activity.trainingTry("a1c1");
    expect(db.prepare("SELECT answer_uci, correct FROM training_items").all()).toEqual([
      { answer_uci: "a1c1", correct: 1 },
    ]);
    expect(rows()).toEqual([]);
  });

  it("hands the coach what was written, what was tried and the wrong answer", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const clock = steppingClock();
    const { activity, say, notes } = setup(clock);
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    clock.advance(5);
    await activity.trainingExplore({ kind: "move", uci: "f4e5" });
    clock.advance(4);
    await activity.trainingExplore({ kind: "move", uci: "d8d5" });
    clock.advance(3);
    await activity.trainingExplore({ kind: "move", uci: "e5d4" });
    clock.advance(2);
    await activity.trainingExplore({ kind: "undo" });
    say("looking at the bishop first");
    await activity.trainingTry("f4e5");
    await activity.trainingShowSolution();
    const text = renderNotifications(notes());
    expect(text).toContain("looking at the bishop first");
    expect(text).toContain("+5s  14. Be5");
    expect(text).toContain("+9s  14. Be5 Qd5");
    expect(text).toContain("+12s  14. Be5 Qd5 Bd4");
    expect(text).toContain("+14s  undo");
    expect(text).toContain("Tries:\n+14s  Be5 (wrong)\nSolution shown: yes");
  });

  it("attaches the reasoning to the review card answer the desk wrote", async () => {
    addCard("d2d4");
    const { activity, say, notes } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingExplore({ kind: "move", uci: "e2e4" });
    await activity.trainingExplore({ kind: "reset" });
    say("e4 or d4?");
    await activity.trainingTry("e2e4");
    await activity.trainingTry("d2d4");
    const text = renderNotifications(notes());
    expect(text).toContain("What the student wrote:\n- e4 or d4?");
    expect(text).toContain("+0s  1. e4\n+0s  reset");
    expect(text).toContain("Tries:\n+0s  e4 (wrong)\n+0s  d4 (right)\nSolution shown: no");
  });
});

describe("the training state a client renders", () => {
  it("lists two moves, an undo and a reset as four events with rising offsets", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const clock = steppingClock();
    const { activity } = setup(clock);
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    for (const step of [
      { kind: "move", uci: "g1h1" },
      { kind: "move", uci: "g8h8" },
      { kind: "undo" },
      { kind: "reset" },
    ] as const) {
      clock.advance(2);
      await activity.trainingExplore(step);
    }
    const { trail } = training(activity.current()).exploring;
    expect(trail.map((e) => e.kind)).toEqual(["move", "move", "undo", "reset"]);
    expect(trail.map((e) => e.at_ms)).toEqual([2000, 4000, 6000, 8000]);
    expect(trail.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(trail.map((e) => e.line_san)).toEqual([["Kh1"], ["Kh1", "Kh8"], ["Kh1"], []]);
  });

  it("stamps served_at and starts each served item with an empty trail", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    addPuzzle("f2", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    const first = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(first.served_at).toBe(T0.toISOString());
    await activity.trainingExplore({ kind: "move", uci: "g1h1" });
    await activity.trainingTry("a1a8");
    const second = training(await activity.nextTrainingItem());
    expect(second.exploring.trail).toEqual([]);
  });

  it("restarts the trail when a multi-move puzzle advances", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingExplore({ kind: "move", uci: "f4e5" });
    const mid = training(await activity.trainingTry("b5c7"));
    expect(mid.exploring.trail).toEqual([]);
    const next = training(await activity.trainingExplore({ kind: "move", uci: "a1c1" }));
    expect(next.exploring.trail.map((e) => e.line_san)).toEqual([["Rc1"]]);
  });

  it("previews the interval each grade would set, and rating applies the previewed one", async () => {
    const id = addCard("d2d4");
    updateSchedule(db, id, {
      fsrs_state: 2,
      stability: 1,
      difficulty: 2.1181,
      learning_step: 0,
      lapses: 0,
      interval_hours: 24,
      last_reviewed_at: new Date(T0.getTime() - 24 * 3_600_000).toISOString(),
      next_review_at: T0.toISOString(),
    });
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    const item = start.item as Extract<typeof start.item, { kind: "card" }>;
    const preview = item.rating_preview;
    expect(Object.keys(preview)).toEqual(["1", "2", "3", "4"]);
    expect(preview["1"]).toBeCloseTo(10 / 60, 9);
    expect(preview["2"]).toBeLessThan(preview["3"]);
    expect(preview["3"]).toBeLessThan(preview["4"]);
    await activity.trainingTry("d2d4");
    await activity.rateCard(item.exposure_id, 3);
    expect(getCard(db, id)?.intervalHours).toBe(preview["3"]);
  });

  it("holds ten positions of a set fixed at the start, whatever the inventory", async () => {
    for (let i = 0; i < 25; i++) {
      const id = String(i).padStart(2, "0");
      addPuzzle(`fork${id}`, "fork", BACK_RANK, ["a1a8"]);
      addPuzzle(`white${id}`, "opening-white", BACK_RANK, ["a1a8"]);
      addPuzzle(`italian${id}`, "opening-italian", BACK_RANK, ["a1a8"]);
    }
    for (const start of [
      { mode: "puzzles", motif: "fork" },
      { mode: "puzzles", motif: "opening-italian" },
      { mode: "openings", color: "white" },
    ] as const) {
      const { activity } = setup();
      const state = training(await activity.startTraining(start));
      expect(state.item).toMatchObject({ position_in_queue: 1, queue_length: 10 });
      await activity.endTraining();
    }
  });

  it("serves every due card of a review queue, up to twenty", async () => {
    for (let i = 0; i < 7; i++) addCard();
    const { activity } = setup();
    const state = training(await activity.startTraining({ mode: "srs" }));
    expect(state.item).toMatchObject({ queue_length: 7 });
  });
});

// A card whose next step falls within 20 minutes of its rating comes back inside the same training:
// a new card answered Again is due in a minute, Hard in six and Good in ten, and only an interval of
// days (Easy on a new card, Good on its last learning step) leaves the run.
describe("a card that comes back inside the training", () => {
  const GRADE = { again: 1, hard: 2, good: 3, easy: 4 } as const;
  const cardOfItem = (state: TrainingActivity): number =>
    (state.item as { card_id: number }).card_id;
  const exposureOfItem = (state: TrainingActivity): string =>
    (state.item as { exposure_id: string }).exposure_id;
  const storedRun = (): { size: number; cards: number[] } => {
    const row = db
      .prepare("SELECT size, items_json FROM training_runs ORDER BY id DESC LIMIT 1")
      .get() as { size: number; items_json: string };
    return {
      size: row.size,
      cards: (JSON.parse(row.items_json) as { id: number }[]).map((item) => item.id),
    };
  };

  // Answers the card on the board right and rates it.
  async function rate(
    activity: ActivityService,
    state: TrainingActivity,
    grade: number,
  ): Promise<TrainingActivity> {
    await activity.trainingTry("d2d4");
    return training(await activity.rateCard(exposureOfItem(state), grade));
  }

  const next = async (activity: ActivityService): Promise<TrainingActivity> =>
    training(await activity.nextTrainingItem());

  it("serves a card rated Again again, though it was the only one, and does not finish while it is held", async () => {
    const id = addCard();
    const { activity } = setup(steppingClock());
    const first = training(await activity.startTraining({ mode: "srs" }));
    expect(first.item).toMatchObject({ position_in_queue: 1, queue_length: 1 });

    const rated = await rate(activity, first, GRADE.again);
    expect(rated.status).toBe("rated");

    const again = await next(activity);
    expect(again.summary).toBeNull();
    expect(again.item).toMatchObject({
      kind: "card",
      card_id: id,
      position_in_queue: 2,
      queue_length: 2,
    });
    expect(again.status).toBe("prompt");
    expect(again.input_enabled).toBe(true);
  });

  it("grows the length of the run by one as soon as a card is held", async () => {
    addCard();
    addCard();
    const { activity } = setup(steppingClock());
    const first = training(await activity.startTraining({ mode: "srs" }));
    expect(first.item).toMatchObject({ queue_length: 2 });
    expect(first.queue_outcomes).toEqual(["current", "pending"]);

    const rated = await rate(activity, first, GRADE.again);

    expect(rated.item).toMatchObject({ position_in_queue: 1, queue_length: 3 });
    expect(rated.queue_outcomes).toEqual(["solved", "pending", "pending"]);
    expect(storedRun().size).toBe(3);
  });

  it("does not hold a card rated Good on its last learning step, which is due in 2 days", async () => {
    const id = addCard();
    const { activity } = setup(steppingClock());
    const first = training(await activity.startTraining({ mode: "srs" }));
    const heldOnce = await rate(activity, first, GRADE.good);
    expect(heldOnce.item).toMatchObject({ queue_length: 2 });

    const second = await next(activity);
    expect(second.item).toMatchObject({ card_id: id, position_in_queue: 2, queue_length: 2 });
    const graduated = await rate(activity, second, GRADE.good);

    expect(getCard(db, id)?.intervalHours).toBeCloseTo(48, 9);
    expect(graduated.item).toMatchObject({ position_in_queue: 2, queue_length: 2 });
    const ended = await next(activity);
    expect(ended.summary).toEqual({ solved: 2, failed: 0 });
  });

  it.each([
    { grade: GRADE.again, held: true, minutes: 1 },
    { grade: GRADE.hard, held: true, minutes: 6 },
    { grade: GRADE.good, held: true, minutes: 10 },
    { grade: GRADE.easy, held: false, minutes: 8 * 24 * 60 },
  ])(
    "holds a new card rated $grade only if it is due soon: held $held, due in $minutes min",
    async ({ grade, held, minutes }) => {
      const id = addCard();
      const { activity } = setup(steppingClock());
      const first = training(await activity.startTraining({ mode: "srs" }));

      const rated = await rate(activity, first, grade);

      expect(getCard(db, id)?.intervalHours).toBeCloseTo(minutes / 60, 9);
      expect((rated.item as { queue_length: number }).queue_length).toBe(held ? 2 : 1);
      expect((await next(activity)).summary === null).toBe(held);
    },
  );

  it("holds a learned card that lapses, and not one that is remembered", async () => {
    const lapsing = addCard();
    const kept = addCard();
    for (const id of [lapsing, kept]) {
      updateSchedule(db, id, {
        fsrs_state: 2,
        stability: 3,
        difficulty: 5,
        learning_step: 0,
        lapses: 0,
        interval_hours: 72,
        last_reviewed_at: new Date(T0.getTime() - 72 * 3_600_000).toISOString(),
        next_review_at: T0.toISOString(),
      });
    }
    const { activity } = setup(steppingClock());
    const first = training(await activity.startTraining({ mode: "srs" }));
    expect(cardOfItem(first)).toBe(lapsing);

    const afterAgain = await rate(activity, first, GRADE.again);
    expect(afterAgain.item).toMatchObject({ queue_length: 3 });
    const second = await next(activity);
    expect(cardOfItem(second)).toBe(kept);
    const afterGood = await rate(activity, second, GRADE.good);
    expect(afterGood.item).toMatchObject({ queue_length: 3 });
  });

  it("serves a held card whose time has come before the next queued card", async () => {
    const [first, second, third] = [addCard(), addCard(), addCard()] as [number, number, number];
    const clock = steppingClock();
    const { activity } = setup(clock);
    const onFirst = training(await activity.startTraining({ mode: "srs" }));
    expect(cardOfItem(onFirst)).toBe(first);
    await rate(activity, onFirst, GRADE.again);

    // Its minute has not passed, so the next queued card comes first.
    const onSecond = await next(activity);
    expect(cardOfItem(onSecond)).toBe(second);
    await rate(activity, onSecond, GRADE.easy);

    // A minute has now passed since the rating: the held card goes ahead of the third.
    clock.advance(61);
    const back = await next(activity);
    expect(back.item).toMatchObject({ card_id: first, position_in_queue: 3, queue_length: 4 });
    await rate(activity, back, GRADE.easy);

    const last = await next(activity);
    expect(last.item).toMatchObject({ card_id: third, position_in_queue: 4 });
    // The stored items are in the order they were served in.
    expect(storedRun().cards).toEqual([first, second, first, third]);
    await rate(activity, last, GRADE.easy);
    expect((await next(activity)).summary).toEqual({ solved: 4, failed: 0 });
  });

  it("serves the held card due first at the end of the queue, though its time has not come", async () => {
    const [first, second] = [addCard(), addCard()] as [number, number];
    const clock = steppingClock();
    const { activity } = setup(clock);
    const onFirst = training(await activity.startTraining({ mode: "srs" }));
    await rate(activity, onFirst, GRADE.again);
    clock.advance(10);
    const onSecond = await next(activity);
    expect(cardOfItem(onSecond)).toBe(second);
    await rate(activity, onSecond, GRADE.again);

    // Nothing is queued, and neither held card is due yet: the first one held is served.
    const backFirst = await next(activity);
    expect(backFirst.item).toMatchObject({ card_id: first, position_in_queue: 3 });
    await rate(activity, backFirst, GRADE.easy);

    const backSecond = await next(activity);
    expect(backSecond.item).toMatchObject({ card_id: second, position_in_queue: 4 });
    expect(backSecond.summary).toBeNull();
    await rate(activity, backSecond, GRADE.easy);

    expect((await next(activity)).summary).toEqual({ solved: 4, failed: 0 });
  });

  it("finishes only when nothing is queued and nothing is held", async () => {
    addCard();
    const { activity, rows } = setup(steppingClock());
    const first = training(await activity.startTraining({ mode: "srs" }));
    await rate(activity, first, GRADE.again);
    expect(rows().filter((row) => row.type === "training_summary")).toEqual([]);

    const second = await next(activity);
    await rate(activity, second, GRADE.again);
    expect(rows().filter((row) => row.type === "training_summary")).toEqual([]);

    const third = await next(activity);
    expect(third.summary).toBeNull();
    await rate(activity, third, GRADE.easy);
    expect((await next(activity)).summary).toEqual({ solved: 3, failed: 0 });
    expect(rows().filter((row) => row.type === "training_summary")).toHaveLength(1);
  });

  it("gives a card served again a fresh exposure, and refuses to rate the one it had", async () => {
    addCard();
    const { activity } = setup(steppingClock());
    const first = training(await activity.startTraining({ mode: "srs" }));
    const oldExposure = exposureOfItem(first);
    await rate(activity, first, GRADE.again);

    const again = await next(activity);

    expect(exposureOfItem(again)).not.toBe(oldExposure);
    await activity.trainingTry("d2d4");
    expect(await code(activity.rateCard(oldExposure, GRADE.good))).toBe("exposure_unknown");
    const rated = training(await activity.rateCard(exposureOfItem(again), GRADE.easy));
    expect(rated.status).toBe("rated");
  });

  it("opens an item of the ledger for each serving of the card", async () => {
    const id = addCard();
    const { activity } = setup(steppingClock());
    const first = training(await activity.startTraining({ mode: "srs" }));
    await rate(activity, first, GRADE.again);
    await next(activity);

    expect(
      db.prepare("SELECT card_id, answered_at IS NOT NULL AS answered FROM training_items").all(),
    ).toEqual([
      { card_id: id, answered: 1 },
      { card_id: id, answered: 0 },
    ]);
  });

  it("leaves a held card due when the training ends, for the next one to pick up", async () => {
    const id = addCard();
    const clock = steppingClock();
    const { activity } = setup(clock);
    const first = training(await activity.startTraining({ mode: "srs" }));
    await rate(activity, first, GRADE.again);
    await activity.endTraining();
    expect(db.prepare("SELECT ended_reason FROM training_runs").get()).toEqual({
      ended_reason: "ended",
    });

    clock.advance(61);
    const second = training(await activity.startTraining({ mode: "srs" }));

    expect(second.item).toMatchObject({ card_id: id, position_in_queue: 1, queue_length: 1 });
  });

  it("leaves a held card due when the server restarts over the training", async () => {
    const id = addCard();
    const clock = steppingClock();
    const { activity } = setup(clock);
    const first = training(await activity.startTraining({ mode: "srs" }));
    await rate(activity, first, GRADE.again);
    clock.advance(61);
    endRunsLeftOpenAtStart(db, clock.now().toISOString());

    const { activity: restarted } = setup(clock);
    const second = training(await restarted.startTraining({ mode: "srs" }));

    expect(second.item).toMatchObject({ card_id: id, position_in_queue: 1, queue_length: 1 });
  });

  it("holds nothing for a single card the coach serves", async () => {
    const id = addCard();
    const { activity } = setup(steppingClock());
    const only = training(await activity.startTrainingItem({ kind: "card", id }));

    const rated = await rate(activity, only, GRADE.again);

    expect(rated.item).toMatchObject({ queue_length: 1 });
    expect((await next(activity)).summary).toEqual({ solved: 1, failed: 0 });
  });
});

describe("an item served by the coach", () => {
  const cardCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM srs_cards").get() as { n: number }).n;

  it("serves one card as item 1 of 1 in srs mode, due or not", async () => {
    const id = addCard();
    db.prepare("UPDATE srs_cards SET next_review_at = '2099-01-01T00:00:00.000Z'").run();
    const { activity } = setup();
    const state = training(await activity.startTrainingItem({ kind: "card", id }));
    expect(state.mode).toBe("srs");
    expect(state.item).toMatchObject({ kind: "card", card_id: id, position_in_queue: 1 });
    expect(state.item).toMatchObject({ queue_length: 1 });
    expect(state.input_enabled).toBe(true);
  });

  it("serves one puzzle as item 1 of 1 and refuses unknown ids by name", async () => {
    addPuzzle("fk:0", "fork", FORK, ["f4e5"]);
    const { activity } = setup();
    expect(await code(activity.startTrainingItem({ kind: "puzzle", id: "nope" }))).toBe(
      "puzzle_not_found",
    );
    expect(await code(activity.startTrainingItem({ kind: "card", id: 999 }))).toBe(
      "card_not_found",
    );
    const state = training(await activity.startTrainingItem({ kind: "puzzle", id: "fk:0" }));
    expect(state.item).toMatchObject({ kind: "puzzle", puzzle_id: "fk:0", queue_length: 1 });
  });

  it("refuses a second session while one is open", async () => {
    addPuzzle("fk:0", "fork", FORK, ["f4e5"]);
    const { activity } = setup();
    await activity.startTrainingItem({ kind: "puzzle", id: "fk:0" });
    expect(await code(activity.startTrainingItem({ kind: "puzzle", id: "fk:0" }))).toBe(
      "training_active",
    );
  });

  it("refuses to stack over an unfinished live game and leaves the board on it", async () => {
    addPuzzle("fk:0", "fork", FORK, ["f4e5"]);
    const { activity, game } = setup();
    await game.newGame({ color: "white", elo: 1200 });
    const live = await activity.enterLiveGame();
    expect(await code(activity.startTrainingItem({ kind: "puzzle", id: "fk:0" }))).toBe(
      "live_game_active",
    );
    expect(activity.current()).toEqual(live);
  });

  it("stacks over a finished live game and returns to nothing", async () => {
    addPuzzle("fk:0", "fork", FORK, ["f4e5"]);
    const { activity, game } = setup();
    await game.newGame({ color: "white", elo: 1200 });
    await activity.enterLiveGame();
    await game.resign();
    await activity.startTrainingItem({ kind: "puzzle", id: "fk:0" });
    expect(activity.current()?.kind).toBe("training");
    expect(await activity.endTraining()).toBeNull();
  });

  it("turns a given-up puzzle into one teaching card, once", async () => {
    addPuzzle("fk:0", "fork", FORK, ["f4e5"]);
    const { activity } = setup();
    for (let round = 0; round < 2; round++) {
      await activity.startTrainingItem({ kind: "puzzle", id: "fk:0" });
      await activity.trainingTry("h1g1");
      await activity.trainingShowSolution();
      await activity.endTraining();
    }
    expect(cardCount()).toBe(1);
    expect(db.prepare("SELECT * FROM srs_cards").get()).toMatchObject({
      source_kind: "teaching",
      puzzle_id: "fk:0",
      prompt_fen: FORK,
      student_color: "white",
      played_uci: "h1g1",
      expected_uci: "f4e5",
      cp_loss: null,
      classification: null,
      explanation: "why",
    });
  });

  it("creates no card for a puzzle solved on the first try", async () => {
    addPuzzle("fk:0", "fork", FORK, ["f4e5"]);
    const { activity } = setup();
    await activity.startTrainingItem({ kind: "puzzle", id: "fk:0" });
    await activity.trainingTry("f4e5");
    expect(cardCount()).toBe(0);
  });

  it("turns a puzzle solved after a wrong try into a teaching card", async () => {
    addPuzzle("fk:0", "fork", FORK, ["f4e5"]);
    const { activity } = setup();
    await activity.startTrainingItem({ kind: "puzzle", id: "fk:0" });
    await activity.trainingTry("h1g1");
    expect(cardCount()).toBe(0);
    const solved = training(await activity.trainingTry("f4e5"));
    expect(solved.status).toBe("solved");
    expect(cardCount()).toBe(1);
    expect(db.prepare("SELECT played_uci, expected_uci FROM srs_cards").get()).toEqual({
      played_uci: "h1g1",
      expected_uci: "f4e5",
    });
  });
});

describe("graded tries", () => {
  const triesRows = () =>
    db
      .prepare("SELECT item_id, seq, at_ms, ply, uci, correct FROM training_tries ORDER BY id")
      .all();
  const attemptRows = () =>
    db.prepare("SELECT solved, first_try, tries, gave_up FROM puzzle_attempts ORDER BY id").all();
  const exposureOf = (state: TrainingActivity): string =>
    (state.item as { exposure_id: string }).exposure_id;

  it("records every try in order, with its step, offset and correctness", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const clock = steppingClock();
    const { activity } = setup(clock);
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    clock.advance(3);
    await activity.trainingTry("f4e5");
    clock.advance(2);
    await activity.trainingTry("b5c7");
    clock.advance(4);
    await activity.trainingTry("a1b1");
    clock.advance(1);
    await activity.trainingTry("a1c1");
    const itemId = (db.prepare("SELECT id FROM training_items").get() as { id: number }).id;
    expect(triesRows()).toEqual([
      { item_id: itemId, seq: 1, at_ms: 3000, ply: 0, uci: "f4e5", correct: 0 },
      { item_id: itemId, seq: 2, at_ms: 5000, ply: 0, uci: "b5c7", correct: 1 },
      { item_id: itemId, seq: 3, at_ms: 9000, ply: 2, uci: "a1b1", correct: 0 },
      { item_id: itemId, seq: 4, at_ms: 10000, ply: 2, uci: "a1c1", correct: 1 },
    ]);
  });

  it("writes first_try, tries and gave_up for each way a puzzle can end", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    addPuzzle("f2", "fork", BACK_RANK, ["a1a8"]);
    addPuzzle("f3", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("a1a8");
    await activity.nextTrainingItem();
    await activity.trainingTry("a1a2");
    await activity.trainingTry("a1a3");
    const solved = training(await activity.trainingTry("a1a8"));
    expect(solved).toMatchObject({ status: "solved", tries: 2, gave_up: false });
    await activity.nextTrainingItem();
    await activity.trainingTry("a1a2");
    await activity.trainingShowSolution();
    expect(attemptRows()).toEqual([
      { solved: 1, first_try: 1, tries: 0, gave_up: 0 },
      { solved: 1, first_try: 0, tries: 2, gave_up: 0 },
      { solved: 0, first_try: 0, tries: 1, gave_up: 1 },
    ]);
  });

  it("suggests Good for a card right first try, and its review counts as correct", async () => {
    addCard("d2d4");
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    const done = training(await activity.trainingTry("d2d4"));
    expect(done.suggested_grade).toBe(3);
    await activity.rateCard(exposureOf(start), 3);
    expect(db.prepare("SELECT answered_uci, correct FROM srs_reviews").get()).toEqual({
      answered_uci: "d2d4",
      correct: 1,
    });
  });

  it("suggests Again for a card solved after a wrong try, and its review counts the first try", async () => {
    addCard("d2d4");
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    await activity.trainingTry("e2e4");
    const done = training(await activity.trainingTry("d2d4"));
    expect(done).toMatchObject({ status: "solved", suggested_grade: 1, tries: 1 });
    await activity.rateCard(exposureOf(start), 1);
    expect(db.prepare("SELECT answered_uci, correct FROM srs_reviews").get()).toEqual({
      answered_uci: "e2e4",
      correct: 0,
    });
  });

  it("suggests Again for a card whose solution was shown, even before any try", async () => {
    addCard("d2d4");
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    const done = training(await activity.trainingShowSolution());
    expect(done).toMatchObject({ status: "failed", suggested_grade: 1, gave_up: true });
    await activity.rateCard(exposureOf(start), 1);
    expect(db.prepare("SELECT correct FROM srs_reviews").get()).toEqual({ correct: 0 });
  });

  // The line a card of several moves is reviewed through; the first move alone cannot tell these apart.
  async function reviewLineCard() {
    addPuzzle("fk:3", "fork", FORK, FORK_LINE);
    addPuzzleCard("fk:3", FORK, "b5c7");
    const harness = setup();
    const start = training(await harness.activity.startTraining({ mode: "srs" }));
    return { ...harness, exposure: exposureOf(start) };
  }
  const reviewRow = () => db.prepare("SELECT answered_uci, correct FROM srs_reviews").get();

  it("suggests Good for a card of several moves right at every step, and its review counts as correct", async () => {
    const { activity, exposure } = await reviewLineCard();
    await activity.trainingTry("b5c7");
    const done = training(await activity.trainingTry("a1c1"));
    expect(done).toMatchObject({ status: "solved", suggested_grade: 3, tries: 0 });
    await activity.rateCard(exposure, 3);
    expect(reviewRow()).toEqual({ answered_uci: "b5c7", correct: 1 });
  });

  it("suggests Again and counts the review wrong when a later step had a wrong try after a right first move", async () => {
    const { activity, exposure } = await reviewLineCard();
    await activity.trainingTry("b5c7");
    await activity.trainingTry("a1b1");
    const done = training(await activity.trainingTry("a1c1"));
    expect(done).toMatchObject({ status: "solved", suggested_grade: 1, tries: 1 });
    await activity.rateCard(exposure, 1);
    expect(reviewRow()).toEqual({ answered_uci: "b5c7", correct: 0 });
  });

  it("answers with the first try of the first step when that step was missed before it was found", async () => {
    const { activity, exposure } = await reviewLineCard();
    await activity.trainingTry("f4e5");
    await activity.trainingTry("b5c7");
    const done = training(await activity.trainingTry("a1c1"));
    expect(done).toMatchObject({ status: "solved", suggested_grade: 1, tries: 1 });
    await activity.rateCard(exposure, 1);
    expect(reviewRow()).toEqual({ answered_uci: "f4e5", correct: 0 });
  });

  it("suggests Again and counts the review wrong when the solution was shown at a later step", async () => {
    const { activity, exposure } = await reviewLineCard();
    await activity.trainingTry("b5c7");
    const done = training(await activity.trainingShowSolution());
    expect(done).toMatchObject({ status: "failed", suggested_grade: 1, gave_up: true });
    await activity.rateCard(exposure, 1);
    expect(reviewRow()).toEqual({ answered_uci: "b5c7", correct: 0 });
  });

  it("answers a card of several moves shown before any try with the null move", async () => {
    const { activity, exposure } = await reviewLineCard();
    await activity.trainingShowSolution();
    await activity.rateCard(exposure, 1);
    expect(reviewRow()).toEqual({ answered_uci: "0000", correct: 0 });
  });

  it("writes no attempt, moves no rating, creates no card and tells the coach once for a card of several moves", async () => {
    addPuzzle("fk:3", "fork", FORK, FORK_LINE, 1400);
    addPuzzleCard("fk:3", FORK, "b5c7");
    const { activity, notes } = setup();
    const ratingBefore = currentPuzzleRating(db);
    await activity.startTraining({ mode: "srs" });
    await activity.trainingTry("b5c7");
    await activity.trainingTry("a1b1");
    const done = training(await activity.trainingTry("a1c1"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM puzzle_attempts").get()).toEqual({ n: 0 });
    // A second card for this puzzle would be dropped by the unique puzzle id, so this count only
    // guards a card made by another route.
    expect(db.prepare("SELECT COUNT(*) AS n FROM srs_cards").get()).toEqual({ n: 1 });
    expect(
      db.prepare("SELECT value FROM settings WHERE key = 'puzzle_rating'").get(),
    ).toBeUndefined();
    expect(currentPuzzleRating(db)).toBe(ratingBefore);
    expect(done).toMatchObject({ student_rating: ratingBefore, rating_change: null });
    expect(notes().map((note) => note.type)).toEqual(["srs_answer"]);
  });

  it("tells the coach of a card of several moves at the step where the first wrong try was", async () => {
    const { activity, notes } = await reviewLineCard();
    await activity.trainingTry("b5c7");
    await activity.trainingTry("a1b1");
    await activity.trainingTry("a1c1");
    expect(notes()).toMatchObject([
      {
        type: "srs_answer",
        prompt_fen: FORK_PUZZLE_AFTER_REPLY_FEN,
        answered_uci: "a1b1",
        answered_san: "Rb1",
        expected_uci: "a1c1",
        expected_san: "Rc1",
        correct: false,
      },
    ]);
    const text = renderNotifications(notes());
    expect(text).toContain("missed review card 1 on the first try with Rb1, then found Rc1.");
    expect(text).toContain(`Position (FEN): ${FORK_PUZZLE_AFTER_REPLY_FEN}`);
  });

  it("tells the coach of a card of several moves at the step where the solution was shown", async () => {
    const { activity, notes } = await reviewLineCard();
    await activity.trainingTry("b5c7");
    await activity.trainingShowSolution();
    expect(notes()).toMatchObject([
      {
        type: "srs_answer",
        prompt_fen: FORK_PUZZLE_AFTER_REPLY_FEN,
        expected_uci: "a1c1",
        expected_san: "Rc1",
        correct: false,
      },
    ]);
    const text = renderNotifications(notes());
    expect(text).toContain("gave up on review card 1 and was shown Rc1.");
    expect(text).toContain(`Position (FEN): ${FORK_PUZZLE_AFTER_REPLY_FEN}`);
  });

  it("tells the coach of a card of several moves missed at its first step on the card's own move", async () => {
    const { activity, notes } = await reviewLineCard();
    await activity.trainingTry("f4e5");
    await activity.trainingTry("b5c7");
    await activity.trainingTry("a1c1");
    expect(notes()).toMatchObject([
      { prompt_fen: FORK, answered_uci: "f4e5", expected_uci: "b5c7", correct: false },
    ]);
    expect(renderNotifications(notes())).toContain("on the first try with Be5, then found Nxc7+.");
  });

  it("leaves the notification of a card of one move as the desk wrote it", async () => {
    addCard("d2d4");
    const { activity, notes } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingTry("e2e4");
    await activity.trainingTry("d2d4");
    expect(notes()).toMatchObject([
      {
        type: "srs_answer",
        prompt_fen: START_FEN,
        answered_uci: "e2e4",
        answered_san: "e4",
        expected_uci: "d2d4",
        expected_san: "d4",
        correct: false,
      },
    ]);
  });

  it("writes one notification per item, after the last try, carrying every try", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    addCard("d2d4");
    const { activity, notes, flushed } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("f4e5");
    await activity.trainingTry("b5c7");
    await activity.trainingTry("a1b1");
    expect(notes()).toEqual([]);
    expect(flushed).not.toHaveBeenCalled();
    await activity.trainingTry("a1c1");
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({
      type: "puzzle_result",
      solved: true,
      first_try: false,
      tries: 2,
      gave_up: false,
      reasoning: {
        gave_up: false,
        tries: [
          { uci: "f4e5", correct: false },
          { uci: "b5c7", correct: true },
          { uci: "a1b1", correct: false },
          { uci: "a1c1", correct: true },
        ],
      },
    });
    await activity.endTraining();

    await activity.startTraining({ mode: "srs" });
    await activity.trainingTry("e2e4");
    await activity.trainingTry("g1f3");
    await activity.trainingShowSolution();
    const cardNotes = notes().filter((note) => note.type === "srs_answer");
    expect(cardNotes).toHaveLength(1);
    expect(cardNotes[0]).toMatchObject({
      answered_uci: "e2e4",
      correct: false,
      reasoning: { gave_up: true, tries: [{ uci: "e2e4" }, { uci: "g1f3" }] },
    });
  });
});

describe("hint", () => {
  it("marks the origin square and the ledger row, and clears on the next try", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const hinted = training(await activity.trainingHint());
    expect(hinted.hint_square).toBe("b5");
    expect(db.prepare("SELECT hinted FROM training_items").get()).toEqual({ hinted: 1 });
    const afterTry = training(await activity.trainingTry("f4e5"));
    expect(afterTry.hint_square).toBeNull();
  });

  it("marks a card with its expected origin and clears on the next try", async () => {
    addCard("d2d4");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    const hinted = training(await activity.trainingHint());
    expect(hinted.hint_square).toBe("d2");
    expect(db.prepare("SELECT hinted FROM training_items").get()).toEqual({ hinted: 1 });
    const afterTry = training(await activity.trainingTry("e2e4"));
    expect(afterTry.hint_square).toBeNull();
  });

  it("counts a hinted puzzle solve as not first try and keeps the hint flag", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingHint();
    const done = training(await activity.trainingTry("a1a8"));
    expect(done).toMatchObject({ status: "solved", hint_square: null });
    expect(
      db.prepare("SELECT solved, first_try, tries, gave_up, hinted FROM puzzle_attempts").all(),
    ).toEqual([{ solved: 1, first_try: 0, tries: 0, gave_up: 0, hinted: 1 }]);
    expect(db.prepare("SELECT hinted, correct FROM training_items").get()).toEqual({
      hinted: 1,
      correct: 0,
    });
  });

  it("suggests Again for a card solved after a hint", async () => {
    addCard("d2d4");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingHint();
    const done = training(await activity.trainingTry("d2d4"));
    expect(done).toMatchObject({ status: "solved", suggested_grade: 1, hint_square: null });
    expect(db.prepare("SELECT hinted FROM training_items").get()).toEqual({ hinted: 1 });
  });

  it("marks the origin of the move the current step asks for on a card of several moves", async () => {
    addPuzzle("fk:3", "fork", FORK, FORK_LINE);
    addPuzzleCard("fk:3", FORK, "b5c7");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    expect(training(await activity.trainingHint()).hint_square).toBe("b5");
    expect(training(await activity.trainingTry("b5c7")).hint_square).toBeNull();
    expect(training(await activity.trainingHint()).hint_square).toBe("a1");
    const done = training(await activity.trainingTry("a1c1"));
    expect(done).toMatchObject({ status: "solved", suggested_grade: 1, hint_square: null });
    expect(await code(activity.trainingHint())).toBe("item_finished");
  });

  it("refuses a hint once the item is finished", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("a1a8");
    expect(await code(activity.trainingHint())).toBe("item_finished");
    await activity.endTraining();
    addCard("d2d4");
    await activity.startTraining({ mode: "srs" });
    await activity.trainingShowSolution();
    expect(await code(activity.trainingHint())).toBe("item_finished");
  });
});

describe("drawings and hint in the reasoning", () => {
  it("keeps each snapshot with its offset and skips one identical to the previous", async () => {
    addCard("d2d4");
    const clock = steppingClock();
    const { activity, notes } = setup(clock);
    await activity.startTraining({ mode: "srs" });
    clock.advance(4);
    await activity.trainingDrawings([{ orig: "e4", dest: "e5", color: "red" }]);
    clock.advance(2);
    await activity.trainingDrawings([{ orig: "e4", dest: "e5", color: "red" }]);
    clock.advance(4);
    await activity.trainingDrawings([{ orig: "d5", color: "green" }]);
    await activity.trainingTry("d2d4");
    const note = notes().at(-1) as { reasoning?: { drawings?: unknown[]; hint_at_ms?: unknown } };
    expect(note.reasoning?.drawings).toEqual([
      { at_ms: 4_000, shapes: [{ orig: "e4", dest: "e5", color: "red" }] },
      { at_ms: 10_000, shapes: [{ orig: "d5", color: "green" }] },
    ]);
    expect(note.reasoning?.hint_at_ms).toBeNull();
  });

  it("keeps at most 30 snapshots, the newest replacing the last one kept", async () => {
    addCard("d2d4");
    const clock = steppingClock();
    const { activity, notes } = setup(clock);
    await activity.startTraining({ mode: "srs" });
    for (let n = 0; n < 31; n++) {
      clock.advance(1);
      const square = `a${(n % 8) + 1}` as string;
      await activity.trainingDrawings([{ orig: square, color: "green" }]);
    }
    await activity.trainingTry("d2d4");
    const note = notes().at(-1) as { reasoning?: { drawings?: { at_ms: number }[] } };
    expect(note.reasoning?.drawings).toHaveLength(30);
    expect(note.reasoning?.drawings?.[29]).toEqual({
      at_ms: 31_000,
      shapes: [{ orig: "a7", color: "green" }],
    });
    expect(note.reasoning?.drawings?.[28]).toEqual({
      at_ms: 29_000,
      shapes: [{ orig: "a5", color: "green" }],
    });
  });

  it("records the hint offset in the reasoning and prints it on the notification", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const clock = steppingClock();
    const { activity, notes } = setup(clock);
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    clock.advance(8);
    await activity.trainingHint();
    clock.advance(2);
    await activity.trainingTry("a1a8");
    const note = notes().at(-1) as {
      reasoning?: { hint_at_ms?: unknown; drawings?: unknown[] };
      first_try?: boolean;
    };
    expect(note.first_try).toBe(false);
    expect(note.reasoning?.hint_at_ms).toBe(8_000);
    expect(note.reasoning?.drawings).toEqual([]);
  });

  it("accepts drawings after the item ended while it is still on the board", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity, notes } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    await activity.trainingTry("a1a8");
    await activity.trainingDrawings([{ orig: "e4", color: "green" }], start.activity_id);
    expect(notes()).toHaveLength(0);
    await activity.trainingAskCoach(start.activity_id);
    const note = notes().at(-1) as { reasoning?: { drawings?: unknown[] } };
    expect(note.reasoning?.drawings).toEqual([
      { at_ms: 0, shapes: [{ orig: "e4", color: "green" }] },
    ]);
  });

  it("refuses drawings off training and on a stale activity", async () => {
    addCard("d2d4");
    const { activity } = setup();
    expect(await code(activity.trainingDrawings([{ orig: "e4", color: "green" }]))).toBe(
      "not_in_training",
    );
    const start = training(await activity.startTraining({ mode: "srs" }));
    expect(
      await code(
        activity.trainingDrawings([{ orig: "e4", color: "green" }], start.activity_id + 1),
      ),
    ).toBe("stale_activity");
  });

  it("refuses drawings once the run has ended with its summary", async () => {
    addCard("d2d4");
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    const answered = training(await activity.trainingTry("d2d4", start.activity_id));
    const done = training(await activity.nextTrainingItem(answered.activity_id));
    expect(done.summary).not.toBeNull();
    expect(await code(activity.trainingDrawings([{ orig: "e4", color: "green" }]))).toBe(
      "not_in_training",
    );
  });
});

describe("move list, progress and rating", () => {
  it("carries the played line and the wrong tries beside the ply they were graded at", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(start).toMatchObject({ moves: [], wrong_tries: [], queue_outcomes: ["current"] });
    const wrong = training(await activity.trainingTry("f4e5", start.activity_id));
    expect(wrong.wrong_tries).toEqual([{ ply: 0, uci: "f4e5", san: "Be5" }]);
    expect(wrong.moves).toEqual([]);
    const mid = training(await activity.trainingTry("b5c7", start.activity_id));
    expect(mid.moves).toEqual([
      { ply: 0, uci: "b5c7", san: "Nxc7+", by: "student" },
      { ply: 1, uci: "e8f8", san: "Kf8", by: "reply" },
    ]);
    const done = training(await activity.trainingTry("a1c1", start.activity_id));
    expect((done.moves ?? []).map((move) => move.uci)).toEqual(["b5c7", "e8f8", "a1c1"]);
    expect((done.moves ?? []).at(-1)).toMatchObject({ ply: 2, by: "student" });
    expect(done.wrong_tries).toEqual([{ ply: 0, uci: "f4e5", san: "Be5" }]);
  });

  it("keeps the line at the step a given-up puzzle stopped on", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    await activity.trainingTry("b5c7", start.activity_id);
    const given = training(await activity.trainingShowSolution(start.activity_id));
    expect((given.moves ?? []).map((move) => move.uci)).toEqual(["b5c7", "e8f8"]);
    expect(given.solution_line).toEqual(["a1c1"]);
  });

  it("holds a card's right answer as its one-move line, with the wrong tries beside it", async () => {
    addCard("d2d4");
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "srs" }));
    await activity.trainingTry("e2e4", start.activity_id);
    const done = training(await activity.trainingTry("d2d4", start.activity_id));
    expect(done.moves).toEqual([{ ply: 0, uci: "d2d4", san: "d4", by: "student" }]);
    expect(done.wrong_tries).toEqual([{ ply: 0, uci: "e2e4", san: "e4" }]);
  });

  it("marks each queue position as the run moves on", async () => {
    addPuzzle("b1", "fork", BACK_RANK, ["a1a8"]);
    addPuzzle("b2", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(start.queue_outcomes).toEqual(["current", "pending"]);
    const solved = training(await activity.trainingTry("a1a8", start.activity_id));
    expect(solved.queue_outcomes).toEqual(["solved", "pending"]);
    const second = training(await activity.nextTrainingItem(start.activity_id));
    expect(second.queue_outcomes).toEqual(["solved", "current"]);
    const given = training(await activity.trainingShowSolution(start.activity_id));
    expect(given.queue_outcomes).toEqual(["solved", "failed"]);
  });

  it("moves the student's rating on a rated puzzle and leaves it alone on an unrated one", async () => {
    addPuzzle("r1", "fork", BACK_RANK, ["a1a8"], 1400);
    addPuzzle("u1", "pin", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(start).toMatchObject({ student_rating: 1200, rating_change: null });
    expect(start.item).toMatchObject({ kind: "puzzle", rating: 1400 });
    const solved = training(await activity.trainingTry("a1a8", start.activity_id));
    expect(solved).toMatchObject({ student_rating: 1224, rating_change: 24 });
    await activity.endTraining();
    const unrated = training(await activity.startTraining({ mode: "puzzles", motif: "pin" }));
    expect(unrated.item).toMatchObject({ kind: "puzzle", rating: null });
    const done = training(await activity.trainingTry("a1a8", unrated.activity_id));
    expect(done).toMatchObject({ student_rating: 1224, rating_change: null });
  });

  it("counts a hinted solve as a loss for the rating", async () => {
    addPuzzle("r1", "fork", BACK_RANK, ["a1a8"], 1200);
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    await activity.trainingHint(start.activity_id);
    const solved = training(await activity.trainingTry("a1a8", start.activity_id));
    expect(solved).toMatchObject({ status: "solved", student_rating: 1184, rating_change: -16 });
  });
});

describe("the puzzles a queue draws from", () => {
  function addThemed(id: string, theme: string, rating: number): void {
    addPuzzle(id, theme, BACK_RANK, ["a1a8"], rating);
    db.prepare("INSERT INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, ?, ?)").run(
      theme,
      rating,
      id,
    );
  }

  const queueIds = (): string[] =>
    (openRun()?.items ?? []).map((item) => (item as { id: string }).id).sort();

  const numbered = (prefix: string, count: number): string[] =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}`);

  it.each([
    ["back_rank_mate", "backRankMate"],
    ["checkmate", "mate"],
  ])("serves the %s motif from the %s theme", async (motif, theme) => {
    for (const id of numbered("themed", 5)) addThemed(id, theme, 1200);
    addPuzzle("stored", motif, BACK_RANK, ["a1a8"], 1200);
    await setup().activity.startTraining({ mode: "puzzles", motif });
    expect(queueIds()).toEqual(numbered("themed", 5));
  });

  it("serves a hangingPiece queue holding only puzzles carrying that theme", async () => {
    for (const id of numbered("hanging", 5)) addThemed(id, "hangingPiece", 1200);
    addThemed("other", "fork", 1200);
    const { activity } = setup();
    const state = training(
      await activity.startTraining({ mode: "puzzles", motif: "hangingPiece" }),
    );
    expect(state.run_motif).toBe("hangingPiece");
    expect(queueIds()).toEqual(numbered("hanging", 5));
  });

  it("accepts a theme outside the fixed list when puzzle_themes holds it, and refuses one that is nowhere", async () => {
    for (const id of numbered("mated", 3)) {
      addPuzzle(id, "tactics", BACK_RANK, ["a1a8"], 1200);
      db.prepare("INSERT INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, ?, ?)").run(
        "mateIn1",
        1200,
        id,
      );
    }
    const { activity } = setup();
    const state = training(await activity.startTraining({ mode: "puzzles", motif: "mateIn1" }));
    expect(state.run_motif).toBe("mateIn1");
    expect(queueIds()).toEqual(numbered("mated", 3));
    await activity.endTraining();
    expect(await code(activity.startTraining({ mode: "puzzles", motif: "nope" }))).toBe(
      "empty_queue",
    );
    expect(openRun()).toBeNull();
  });

  it("samples a theme around the student's rating", async () => {
    for (const id of numbered("near", 10)) addThemed(id, "fork", 1100);
    for (const id of numbered("far", 10)) addThemed(id, "fork", 1800);
    await setup().activity.startTraining({ mode: "puzzles", motif: "fork" });
    expect(queueIds()).toEqual(numbered("near", 10));
  });

  it("follows the student's current rating, not the default", async () => {
    for (const id of numbered("near", 10)) addThemed(id, "fork", 1100);
    for (const id of numbered("far", 10)) addThemed(id, "fork", 1800);
    setPuzzleRating(db, 1800, T0.toISOString());
    await setup().activity.startTraining({ mode: "puzzles", motif: "fork" });
    expect(queueIds()).toEqual(numbered("far", 10));
  });

  it("samples an Any queue around the rating, without opening material", async () => {
    for (const id of numbered("near", 10)) addPuzzle(id, "endgame", BACK_RANK, ["a1a8"], 1100);
    for (const id of numbered("far", 10)) addPuzzle(id, "endgame", BACK_RANK, ["a1a8"], 1800);
    addPuzzle("drill", "opening-white", BACK_RANK, ["a1a8"], 1100);
    await setup().activity.startTraining({ mode: "puzzles" });
    expect(queueIds()).toEqual(numbered("near", 10));
  });

  it("draws a first batch of ten from a themed queue and from an Any queue", async () => {
    for (const id of numbered("near", 12)) addThemed(id, "fork", 1100);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    expect(queueIds()).toHaveLength(10);
    await activity.endTraining();
    await activity.startTraining({ mode: "puzzles" });
    expect(queueIds()).toHaveLength(10);
  });

  it("refuses an Any queue when only opening material is left", async () => {
    addPuzzle("drill", "opening-white", BACK_RANK, ["a1a8"]);
    addPuzzle("rated-drill", "opening-black", BACK_RANK, ["a1a8"], 1200);
    const { activity } = setup();
    expect(await code(activity.startTraining({ mode: "puzzles" }))).toBe("empty_queue");
  });

  it("keeps the plain listing for a motif with no theme rows, whatever its rating", async () => {
    addPuzzle("high", "endgame", BACK_RANK, ["a1a8"], 2500);
    addPuzzle("unrated", "endgame", BACK_RANK, ["a1a8"]);
    await setup().activity.startTraining({ mode: "puzzles", motif: "endgame" });
    expect(queueIds()).toEqual(["high", "unrated"]);
  });

  it("keeps the plain listing for an opening drill", async () => {
    addPuzzle("w1", "opening-white", BACK_RANK, ["a1a8"]);
    addThemed("w2", "opening-white", 2500);
    await setup().activity.startTraining({ mode: "openings", color: "white" });
    expect(queueIds()).toEqual(["w1", "w2"]);
  });
});

describe("a puzzle queue without an end", () => {
  const named = (prefix: string, count: number): string[] =>
    Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);

  function addRated(id: string, rating: number, theme?: string): void {
    addPuzzle(id, "tactics", BACK_RANK, ["a1a8"], rating);
    if (theme === undefined) return;
    db.prepare("INSERT INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, ?, ?)").run(
      theme,
      rating,
      id,
    );
  }

  const storedIds = (): string[] =>
    (openRun()?.items ?? []).map((item) => (item as { id: string }).id);

  const storedSize = (): number =>
    (
      db.prepare("SELECT size FROM training_runs ORDER BY id DESC LIMIT 1").get() as {
        size: number;
      }
    ).size;

  // Solves the puzzle on the board and asks for the one after it.
  async function solveAndAdvance(activity: ActivityService): Promise<TrainingActivity> {
    const solved = training(await activity.trainingTry("a1a8"));
    return training(await activity.nextTrainingItem(solved.activity_id));
  }

  async function advanceTo(
    activity: ActivityService,
    start: TrainingActivity,
    position: number,
  ): Promise<TrainingActivity> {
    let state = start;
    while (state.item.position_in_queue < position) state = await solveAndAdvance(activity);
    return state;
  }

  it.each([
    ["no motif", undefined],
    ["a Lichess theme", "mateIn2"],
    ["a library motif", "fork"],
  ])("starts a queue of %s with ten puzzles and no length", async (_name, motif) => {
    for (const id of named("p", 25)) addRated(id, 1200, motif);
    const { activity } = setup();
    const state = training(
      await activity.startTraining({ mode: "puzzles", ...(motif ? { motif } : {}) }),
    );
    expect(state.item).toMatchObject({ kind: "puzzle", position_in_queue: 1 });
    expect(state.item).not.toHaveProperty("queue_length");
    expect(storedIds()).toHaveLength(10);
  });

  it("draws ten more when the next item is asked on the tenth, none of them already in the run", async () => {
    for (const id of named("p", 25)) addRated(id, 1200);
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles" }));
    const tenth = await advanceTo(activity, start, 10);
    const firstBatch = storedIds();
    expect(firstBatch).toHaveLength(10);
    const eleventh = await solveAndAdvance(activity);
    expect(eleventh).toMatchObject({ status: "prompt", summary: null });
    expect(eleventh.item).toMatchObject({ position_in_queue: 11 });
    expect(eleventh.item).not.toHaveProperty("queue_length");
    const stored = storedIds();
    expect(stored).toHaveLength(20);
    expect(stored.slice(0, 10)).toEqual(firstBatch);
    expect(new Set(stored).size).toBe(20);
    expect(storedSize()).toBe(20);
    expect(eleventh.item).toMatchObject({ puzzle_id: stored[10] });
    expect(eleventh.activity_id).toBe(tenth.activity_id);
  });

  it("draws only the puzzles the run lacks when fewer than ten are left", async () => {
    for (const id of named("p", 15)) addRated(id, 1200);
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles" }));
    await advanceTo(activity, start, 10);
    const eleventh = await solveAndAdvance(activity);
    expect(eleventh.item).toMatchObject({ position_in_queue: 11 });
    const stored = storedIds();
    expect(stored).toHaveLength(15);
    expect(new Set(stored).size).toBe(15);
    expect(storedSize()).toBe(15);
  });

  it("draws the next batch around the rating the student has by then", async () => {
    for (const id of named("low", 12)) addRated(id, 1100);
    for (const id of named("high", 12)) addRated(id, 1900);
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles" }));
    expect(storedIds().every((id) => id.startsWith("low"))).toBe(true);
    await advanceTo(activity, start, 10);
    setPuzzleRating(db, 1900, T0.toISOString());
    await solveAndAdvance(activity);
    const second = storedIds().slice(10);
    expect(second).toHaveLength(10);
    expect(second.every((id) => id.startsWith("high"))).toBe(true);
  });

  it("finishes the run, with its summary, when a refill finds no puzzle", async () => {
    for (const id of named("p", 25)) addRated(id, 1200);
    const { activity, rows } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles" }));
    const last = await advanceTo(activity, start, 25);
    expect(storedIds()).toHaveLength(25);
    expect(new Set(storedIds()).size).toBe(25);
    expect(storedSize()).toBe(25);
    const answered = training(await activity.trainingTry("a1a8", last.activity_id));
    expect(rows().filter((r) => r.type === "training_summary")).toEqual([]);
    const ended = training(await activity.nextTrainingItem(answered.activity_id));
    expect(ended.summary).toEqual({ solved: 25, failed: 0 });
    expect(ended.input_enabled).toBe(false);
    expect(rows().filter((r) => r.type === "training_summary")).toEqual([
      { type: "training_summary", mode: "puzzles", solved: 25, failed: 0 },
    ]);
    expect(db.prepare("SELECT ended_reason, size FROM training_runs").all()).toEqual([
      { ended_reason: "finished", size: 25 },
    ]);
  });

  it("refuses to start with no puzzle to draw, and writes no run", async () => {
    const { activity } = setup();
    expect(await code(activity.startTraining({ mode: "puzzles" }))).toBe("empty_queue");
    expect(db.prepare("SELECT COUNT(*) AS n FROM training_runs").get()).toEqual({ n: 0 });
  });

  it("carries the outcomes of the items served so far, and never a pending one", async () => {
    for (const id of named("p", 25)) addRated(id, 1200);
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles" }));
    expect(start.queue_outcomes).toEqual(["current"]);
    const solved = training(await activity.trainingTry("a1a8", start.activity_id));
    expect(solved.queue_outcomes).toEqual(["solved"]);
    const second = training(await activity.nextTrainingItem(start.activity_id));
    expect(second.item).toMatchObject({ position_in_queue: 2 });
    expect(second.item).not.toHaveProperty("queue_length");
    expect(second.queue_outcomes).toEqual(["solved", "current"]);
    const given = training(await activity.trainingShowSolution(start.activity_id));
    expect(given.queue_outcomes).toEqual(["solved", "failed"]);
    const third = training(await activity.nextTrainingItem(start.activity_id));
    const eleventh = await advanceTo(activity, third, 11);
    expect(eleventh.queue_outcomes).toEqual([
      "solved",
      "failed",
      ...Array.from({ length: 8 }, () => "solved"),
      "current",
    ]);
  });

  it("ends as ended, with no summary, when the student stops in the middle of a refill", async () => {
    for (const id of named("p", 25)) addRated(id, 1200);
    const { activity, rows } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles" }));
    await advanceTo(activity, start, 11);
    expect(await activity.endTraining()).toBeNull();
    expect(db.prepare("SELECT ended_reason, size FROM training_runs").all()).toEqual([
      { ended_reason: "ended", size: 20 },
    ]);
    expect(rows().filter((r) => r.type === "training_summary")).toEqual([]);
  });

  it.each([
    ["the Italian drill", { mode: "puzzles", motif: "opening-italian" }, "opening-italian"],
    ["a library motif no theme names", { mode: "puzzles", motif: "opening_trap" }, "opening_trap"],
    ["an opening drill", { mode: "openings", color: "white" }, "opening-white"],
  ] as const)(
    "keeps %s to its length and ends it on its last item",
    async (_name, start, motif) => {
      addPuzzle("a", motif, BACK_RANK, ["a1a8"]);
      addPuzzle("b", motif, BACK_RANK, ["a1a8"]);
      // Rated puzzles a queue that went on past its end would draw from.
      for (const id of named("r", 12)) addRated(id, 1200);
      const { activity, rows } = setup();
      const first = training(await activity.startTraining(start));
      expect(first.item).toMatchObject({ position_in_queue: 1, queue_length: 2 });
      expect(first.queue_outcomes).toEqual(["current", "pending"]);
      await activity.trainingTry("a1a8", first.activity_id);
      const second = training(await activity.nextTrainingItem(first.activity_id));
      expect(second.item).toMatchObject({ position_in_queue: 2, queue_length: 2 });
      await activity.trainingTry("a1a8", first.activity_id);
      const ended = training(await activity.nextTrainingItem(first.activity_id));
      expect(ended.summary).toEqual({ solved: 2, failed: 0 });
      expect(rows().filter((r) => r.type === "training_summary")).toHaveLength(1);
      expect(db.prepare("SELECT ended_reason, size FROM training_runs").all()).toEqual([
        { ended_reason: "finished", size: 2 },
      ]);
    },
  );

  it("ends a run of due cards and a single item on their last item, as before", async () => {
    addCard();
    for (const id of named("r", 12)) addRated(id, 1200);
    const { activity } = setup();
    const card = training(await activity.startTraining({ mode: "srs" }));
    expect(card.item).toMatchObject({ queue_length: 1 });
    await activity.trainingTry("d2d4", card.activity_id);
    expect(training(await activity.nextTrainingItem(card.activity_id)).summary).toEqual({
      solved: 1,
      failed: 0,
    });
    await activity.endTraining();
    addPuzzle("fk:0", "fork", BACK_RANK, ["a1a8"], 1200);
    const single = training(await activity.startTrainingItem({ kind: "puzzle", id: "fk:0" }));
    expect(single.item).toMatchObject({ position_in_queue: 1, queue_length: 1 });
    await activity.trainingTry("a1a8", single.activity_id);
    expect(training(await activity.nextTrainingItem(single.activity_id)).summary).toEqual({
      solved: 1,
      failed: 0,
    });
  });
});

describe("an opening drill of one family", () => {
  function addOpeningPuzzle(
    id: string,
    color: "white" | "black",
    openingName: string | null,
  ): void {
    addPuzzle(id, `opening-${color}`, BACK_RANK, ["a1a8"]);
    db.prepare("UPDATE puzzles SET opening_name = ? WHERE id = ?").run(openingName, id);
  }

  const queueIds = (): string[] =>
    (openRun()?.items ?? []).map((item) => (item as { id: string }).id).sort();

  function fillDrills(): void {
    addOpeningPuzzle("it1", "white", "Italian Game");
    addOpeningPuzzle("it2", "white", "Italian Game: Giuoco Piano");
    addOpeningPuzzle("it3", "white", "Italian Game: Two Knights Defense");
    addOpeningPuzzle("sic1", "white", "Sicilian Defense: Najdorf Variation");
    addOpeningPuzzle("none1", "white", null);
    addOpeningPuzzle("none2", "white", "");
    addOpeningPuzzle("blk-sic", "black", "Sicilian Defense");
    addOpeningPuzzle("blk-it", "black", "Italian Game");
  }

  it("serves only the positions of the family, whichever name of it they carry", async () => {
    fillDrills();
    const { activity } = setup();
    const state = training(
      await activity.startTraining({ mode: "openings", color: "white", opening: "Italian Game" }),
    );
    expect(state).toMatchObject({ mode: "openings", item: { queue_length: 3 } });
    expect(queueIds()).toEqual(["it1", "it2", "it3"]);
  });

  it("serves the positions with no name for the unnamed entry, and no named one", async () => {
    fillDrills();
    const { activity } = setup();
    await activity.startTraining({ mode: "openings", color: "white", opening: UNNAMED_OPENING });
    expect(queueIds()).toEqual(["none1", "none2"]);
  });

  it("keeps the colours apart, serving a family of the colour it is asked for", async () => {
    fillDrills();
    const { activity } = setup();
    await activity.startTraining({ mode: "openings", color: "black", opening: "Sicilian Defense" });
    expect(queueIds()).toEqual(["blk-sic"]);
  });

  it("serves every position of the colour, named or not, when no opening is named", async () => {
    fillDrills();
    const { activity } = setup();
    await activity.startTraining({ mode: "openings", color: "white" });
    expect(queueIds()).toEqual(["it1", "it2", "it3", "none1", "none2", "sic1"]);
  });

  it("holds the family to ten positions", async () => {
    for (let i = 0; i < 12; i++) addOpeningPuzzle(`sic${i}`, "white", "Sicilian Defense");
    addOpeningPuzzle("it1", "white", "Italian Game");
    const { activity } = setup();
    const state = training(
      await activity.startTraining({
        mode: "openings",
        color: "white",
        opening: "Sicilian Defense",
      }),
    );
    expect(state.item.queue_length).toBe(10);
    expect(queueIds().every((id) => id.startsWith("sic"))).toBe(true);
  });

  it("ignores the opening in a mode that has none", async () => {
    addCard();
    const { activity } = setup();
    const state = training(await activity.startTraining({ mode: "srs", opening: "Nowhere" }));
    expect(state.item).toMatchObject({ kind: "card", queue_length: 1 });
  });

  it.each([
    ["a family of the other colour", "black", "Italian Game"],
    ["a full opening name, which is no family", "white", "Italian Game: Giuoco Piano"],
    ["a family written in another case", "white", "italian game"],
    ["a family with spaces around it", "white", " Italian Game "],
    ["text meant for the query", "white", "Italian Game' OR '1'='1"],
    ["a family nothing was stored for", "white", "Vienna Game"],
  ] as const)("refuses %s as unknown_opening", async (_name, color, opening) => {
    for (const id of ["w1", "w2"]) addOpeningPuzzle(id, "white", "Italian Game: Giuoco Piano");
    addOpeningPuzzle("w3", "white", "Italian Game");
    addOpeningPuzzle("b1", "black", "Sicilian Defense");
    const { activity } = setup();
    expect(await code(activity.startTraining({ mode: "openings", color, opening }))).toBe(
      "unknown_opening",
    );
    expect(activity.current()).toBeNull();
    expect(openRun()).toBeNull();
  });

  it("refuses the unnamed entry for a colour whose positions all have a name", async () => {
    addOpeningPuzzle("w1", "white", "Italian Game");
    const { activity } = setup();
    expect(
      await code(
        activity.startTraining({ mode: "openings", color: "white", opening: UNNAMED_OPENING }),
      ),
    ).toBe("unknown_opening");
  });

  it("leaves the run on the board untouched when the family is refused", async () => {
    fillDrills();
    const { activity } = setup();
    const running = training(
      await activity.startTraining({ mode: "openings", color: "white", opening: "Italian Game" }),
    );
    const runBefore = openRun();
    expect(
      await code(
        activity.startTraining({ mode: "openings", color: "white", opening: "Vienna Game" }),
      ),
    ).toBe("unknown_opening");
    expect(activity.current()).toMatchObject({
      kind: "training",
      activity_id: running.activity_id,
    });
    expect(openRun()).toEqual(runBefore);
    expect(db.prepare("SELECT COUNT(*) AS n FROM training_runs").get()).toEqual({ n: 1 });
  });
});

describe("a puzzle queue of one Lichess opening tag", () => {
  const ITALIAN = "Italian_Game Italian_Game_Classical_Variation";
  const FRENCH = "French_Defense French_Defense_Advance_Variation";

  // A rated puzzle filed under each tag of `openingTags`, as the import files a Lichess puzzle.
  function addTagged(id: string, rating: number, openingTags: string): void {
    addPuzzle(id, "tactics", BACK_RANK, ["a1a8"], rating);
    db.prepare("UPDATE puzzles SET opening_tags = ? WHERE id = ?").run(openingTags, id);
    for (const tag of openingTags.split(" ")) {
      db.prepare("INSERT INTO puzzle_openings (opening, rating, puzzle_id) VALUES (?, ?, ?)").run(
        tag,
        rating,
        id,
      );
    }
  }

  const named = (prefix: string, count: number): string[] =>
    Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);

  const storedIds = (): string[] =>
    (openRun()?.items ?? []).map((item) => (item as { id: string }).id);

  const runCount = (): unknown => db.prepare("SELECT COUNT(*) AS n FROM training_runs").get();

  async function solveAndAdvance(activity: ActivityService): Promise<TrainingActivity> {
    const solved = training(await activity.trainingTry("a1a8"));
    return training(await activity.nextTrainingItem(solved.activity_id));
  }

  it("serves only the tag's puzzles, around the student's rating, in a queue with no length", async () => {
    for (const id of named("near", 12)) addTagged(id, 1150, ITALIAN);
    for (const id of named("far", 12)) addTagged(id, 1800, ITALIAN);
    for (const id of named("french", 12)) addTagged(id, 1150, FRENCH);
    const { activity } = setup();
    const state = training(
      await activity.startTraining({ mode: "puzzles", opening: "Italian_Game" }),
    );
    expect(state).toMatchObject({ mode: "puzzles", run_motif: null, item: { kind: "puzzle" } });
    expect(state.item).not.toHaveProperty("queue_length");
    expect(storedIds()).toHaveLength(10);
    expect(storedIds().every((id) => id.startsWith("near"))).toBe(true);
    await activity.endTraining();
    setPuzzleRating(db, 1800, T0.toISOString());
    await activity.startTraining({ mode: "puzzles", opening: "Italian_Game" });
    expect(storedIds().every((id) => id.startsWith("far"))).toBe(true);
  });

  it("serves a variation's tag apart from its family's", async () => {
    addTagged("classical", 1200, ITALIAN);
    addTagged("pianissimo", 1200, "Italian_Game Italian_Game_Giuoco_Pianissimo");
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", opening: "Italian_Game_Giuoco_Pianissimo" });
    expect(storedIds()).toEqual(["pianissimo"]);
  });

  it("draws ten more of the tag when the tenth is answered, none of them already in the run", async () => {
    for (const id of named("it", 25)) addTagged(id, 1200, ITALIAN);
    for (const id of named("fr", 25)) addTagged(id, 1200, FRENCH);
    const { activity } = setup();
    let state = training(
      await activity.startTraining({ mode: "puzzles", opening: "Italian_Game" }),
    );
    while (state.item.position_in_queue < 10) state = await solveAndAdvance(activity);
    const firstBatch = storedIds();
    const eleventh = await solveAndAdvance(activity);
    expect(eleventh).toMatchObject({ status: "prompt", summary: null });
    expect(eleventh.item).toMatchObject({ position_in_queue: 11 });
    expect(eleventh.item).not.toHaveProperty("queue_length");
    const stored = storedIds();
    expect(stored).toHaveLength(20);
    expect(stored.slice(0, 10)).toEqual(firstBatch);
    expect(new Set(stored).size).toBe(20);
    expect(stored.every((id) => id.startsWith("it"))).toBe(true);
  });

  it("finishes the run when the tag has no puzzle left that the run lacks", async () => {
    for (const id of named("it", 3)) addTagged(id, 1200, ITALIAN);
    for (const id of named("fr", 12)) addTagged(id, 1200, FRENCH);
    const { activity } = setup();
    let state = training(
      await activity.startTraining({ mode: "puzzles", opening: "Italian_Game" }),
    );
    while (state.item.position_in_queue < 3) state = await solveAndAdvance(activity);
    await activity.trainingTry("a1a8", state.activity_id);
    const ended = training(await activity.nextTrainingItem(state.activity_id));
    expect(ended.summary).toEqual({ solved: 3, failed: 0 });
    expect(db.prepare("SELECT ended_reason, size FROM training_runs").all()).toEqual([
      { ended_reason: "finished", size: 3 },
    ]);
  });

  it("refuses a tag no puzzle carries with empty_queue and leaves the run on the board", async () => {
    addTagged("classical", 1200, ITALIAN);
    const { activity } = setup();
    expect(
      await code(activity.startTraining({ mode: "puzzles", opening: "Scandinavian_Defense" })),
    ).toBe("empty_queue");
    expect(activity.current()).toBeNull();
    expect(runCount()).toEqual({ n: 0 });
    const running = training(
      await activity.startTraining({ mode: "puzzles", opening: "Italian_Game" }),
    );
    const runBefore = openRun();
    for (const opening of ["Scandinavian_Defense", "Italian_Game' OR '1'='1", "italian_game"]) {
      expect(await code(activity.startTraining({ mode: "puzzles", opening }))).toBe("empty_queue");
    }
    expect(activity.current()).toMatchObject({ activity_id: running.activity_id });
    expect(openRun()).toEqual(runBefore);
    expect(runCount()).toEqual({ n: 1 });
  });

  it("refuses an opening together with a motif, and starts nothing", async () => {
    addTagged("classical", 1200, ITALIAN);
    db.prepare("INSERT INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, ?, ?)").run(
      "fork",
      1200,
      "classical",
    );
    const { activity } = setup();
    expect(
      await code(
        activity.startTraining({ mode: "puzzles", motif: "fork", opening: "Italian_Game" }),
      ),
    ).toBe("invalid_command");
    expect(activity.current()).toBeNull();
    expect(runCount()).toEqual({ n: 0 });
  });

  it("rates and records its puzzles as any puzzle: the attempt, the rating, and a card after a miss", async () => {
    addTagged("solved", 1400, ITALIAN);
    addTagged("missed", 1400, ITALIAN);
    const { activity } = setup();
    const first = training(
      await activity.startTraining({ mode: "puzzles", opening: "Italian_Game" }),
    );
    expect(first.item).toMatchObject({ kind: "puzzle", rating: 1400 });
    const solvedId = (first.item as { puzzle_id: string }).puzzle_id;
    const solved = training(await activity.trainingTry("a1a8", first.activity_id));
    expect(solved).toMatchObject({ status: "solved", student_rating: 1224, rating_change: 24 });
    const second = training(await activity.nextTrainingItem(first.activity_id));
    const missedId = (second.item as { puzzle_id: string }).puzzle_id;
    await activity.trainingTry("a1a2", second.activity_id);
    const given = training(await activity.trainingShowSolution(second.activity_id));
    expect(given).toMatchObject({ status: "failed", student_rating: 1215, rating_change: -9 });
    expect(
      db.prepare("SELECT puzzle_id, solved, first_try FROM puzzle_attempts ORDER BY id").all(),
    ).toEqual([
      { puzzle_id: solvedId, solved: 1, first_try: 1 },
      { puzzle_id: missedId, solved: 0, first_try: 0 },
    ]);
    expect(db.prepare("SELECT puzzle_id FROM srs_cards").all()).toEqual([{ puzzle_id: missedId }]);
  });
});

describe("a puzzle solved first try", () => {
  it("writes no notification and does not wake the coach", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity, flushed, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const done = training(await activity.trainingTry("a1a8"));
    expect(done).toMatchObject({ status: "solved", coach_comment: "offered" });
    expect(rows()).toEqual([]);
    expect(flushed).not.toHaveBeenCalled();
    expect(db.prepare("SELECT first_try FROM puzzle_attempts").get()).toEqual({ first_try: 1 });
  });

  it("still writes one notification and wakes the coach after a wrong try, a hint or a give-up", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity, flushed, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("a1a2");
    const missed = training(await activity.trainingTry("a1a8"));
    expect(missed.coach_comment).toBeNull();
    expect(rows()).toMatchObject([{ type: "puzzle_result", first_try: false }]);
    expect(flushed).toHaveBeenCalledTimes(1);
    await activity.endTraining();

    for (const how of ["hint", "give_up"] as const) {
      const again = setup();
      await again.activity.startTraining({ mode: "puzzles", motif: "fork" });
      if (how === "hint") {
        await again.activity.trainingHint();
        await again.activity.trainingTry("a1a8");
      } else {
        await again.activity.trainingShowSolution();
      }
      expect(again.flushed).toHaveBeenCalledTimes(1);
      expect(again.rows().filter((r) => r.type === "puzzle_result")).toHaveLength(1);
      await again.activity.endTraining();
    }
  });

  it("writes the requested row once when the student asks, with the solution", async () => {
    addPuzzle("f1", "fork", FORK, ["b5c7", "e8f8", "a1c1"]);
    const { activity, flushed, notes } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("b5c7");
    await activity.trainingTry("a1c1");
    const asked = training(await activity.trainingAskCoach());
    expect(asked.coach_comment).toBe("requested");
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({
      type: "puzzle_result",
      requested: true,
      first_try: true,
      solution_san: ["Nxc7+", "Kf8", "Rc1"],
    });
    expect(flushed).toHaveBeenCalledTimes(1);
  });

  it("refuses a second ask, a stale activity and an ask with no ended item", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity, notes } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(await code(activity.trainingAskCoach(start.activity_id))).toBe("not_in_training");
    await activity.trainingTry("a1a8", start.activity_id);
    expect(await code(activity.trainingAskCoach(start.activity_id + 1))).toBe("stale_activity");
    await activity.trainingAskCoach(start.activity_id);
    expect(await code(activity.trainingAskCoach(start.activity_id))).toBe("already_requested");
    expect(notes()).toHaveLength(1);
  });

  it("refuses an ask about a card or a missed puzzle", async () => {
    addCard("d2d4");
    const { activity } = setup();
    await activity.startTraining({ mode: "srs" });
    await activity.trainingTry("d2d4");
    expect(await code(activity.trainingAskCoach())).toBe("not_in_training");
  });
});

describe("a quiet coach ask after a miss or a give-up stays refused", () => {
  it("refuses an ask on a puzzle solved after a wrong try, writing nothing and not waking the coach", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity, flushed, notes } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("a1a2");
    const missed = training(await activity.trainingTry("a1a8"));
    expect(missed.coach_comment).toBeNull();
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({ type: "puzzle_result", first_try: false });
    const wakes = flushed.mock.calls.length;
    expect(await code(activity.trainingAskCoach())).toBe("not_in_training");
    expect(notes()).toHaveLength(1);
    expect(flushed.mock.calls.length).toBe(wakes);
  });

  it("refuses an ask on a given-up puzzle, writing nothing and not waking the coach", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
    const { activity, flushed, notes } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const failed = training(await activity.trainingShowSolution());
    expect(failed.status).toBe("failed");
    expect(notes()).toHaveLength(1);
    const wakes = flushed.mock.calls.length;
    expect(await code(activity.trainingAskCoach())).toBe("not_in_training");
    expect(notes()).toHaveLength(1);
    expect(flushed.mock.calls.length).toBe(wakes);
  });
});

describe("a mix practice queue drawn equally from the improvement areas", () => {
  const daysBeforeT0 = (days: number): string =>
    new Date(T0.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  let mixHistoryCount = 0;

  function mixAddThemed(id: string, themes: readonly string[]): void {
    addPuzzle(id, "tactics", BACK_RANK, ["a1a8"], 1200);
    db.prepare("UPDATE puzzles SET themes = ? WHERE id = ?").run(themes.join(" "), id);
    const insertTheme = db.prepare(
      "INSERT INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, ?, ?)",
    );
    for (const theme of themes) insertTheme.run(theme, 1200, id);
  }

  function mixAddPool(pool: string, count: number, themes: readonly string[] = []): void {
    for (let i = 0; i < count; i++) {
      const id = `${pool}-${String(i).padStart(2, "0")}`;
      if (themes.length > 0) mixAddThemed(id, themes);
      else addPuzzle(id, "tactics", BACK_RANK, ["a1a8"], 1200);
    }
  }

  function mixAddHistory(theme: string, played: number, firstTry: number, daysAgo = 1): void {
    for (let i = 0; i < played; i++) {
      const id = `mix-history-${mixHistoryCount++}`;
      const right = i < firstTry;
      addPuzzle(id, "tactics", BACK_RANK, ["a1a8"], 1200);
      db.prepare("UPDATE puzzles SET themes = ?, popularity = 0 WHERE id = ?").run(theme, id);
      recordPuzzleAttempt(db, {
        puzzleId: id,
        attemptedAt: daysBeforeT0(daysAgo),
        solved: right,
        answered: [],
        failedPly: right ? null : 0,
        firstTry: right,
        tries: right ? 0 : 1,
        gaveUp: !right,
      });
    }
  }

  function mixListAsWeakDaysAgo(daysAgo: number, ...themes: string[]): void {
    for (const theme of themes) mixAddHistory(theme, 8, 0, daysAgo);
    mixAddHistory("hangingPiece", 16, 16, daysAgo);
  }

  const mixListAsWeak = (...themes: string[]): void => mixListAsWeakDaysAgo(1, ...themes);

  const mixImprovementAreas = (): string[] =>
    [...computeThemeStats(db, "30", fixedClock).improvement_areas].sort();

  const mixStoredIds = (): string[] =>
    (openRun()?.items ?? []).map((item) => (item as { id: string }).id);

  const mixInPool = (ids: readonly string[], pool: string): string[] =>
    ids.filter((id) => id.startsWith(`${pool}-`));

  const withMixSeed = (seed: number) => setup(fixedClock, silentLog, seededRandom(seed));

  async function mixPassTheTenth(
    activity: ActivityService,
    start: TrainingActivity,
  ): Promise<TrainingActivity> {
    let state = start;
    for (let served = 0; served < 10; served++) {
      const solved = training(await activity.trainingTry("a1a8", state.activity_id));
      state = training(await activity.nextTrainingItem(solved.activity_id));
    }
    return state;
  }

  it("exports the reserved mix motif outside the fixed choices", () => {
    expect(MIX_PRACTICE_MOTIF).toBe("mix-practice");
    expect(isFixedPracticeMotif(MIX_PRACTICE_MOTIF)).toBe(false);
    expect(isFixedPracticeMotif("fork")).toBe(true);
  });

  it("builds a first batch of 10 with 4, 3 and 3, and the same shares without repeats in the second", async () => {
    for (const theme of ["deflection", "pin", "skewer"]) mixAddPool(theme, 12, [theme]);
    mixAddHistory("deflection", 12, 0);
    mixAddHistory("pin", 8, 0);
    mixAddHistory("skewer", 8, 0);
    mixAddHistory("hangingPiece", 16, 16);
    expect(mixImprovementAreas()).toEqual(["deflection", "pin", "skewer"]);
    const { activity } = withMixSeed(1);
    const start = training(
      await activity.startTraining({ mode: "puzzles", motif: MIX_PRACTICE_MOTIF }),
    );
    expect(start.run_motif).toBe("mix-practice");
    expect(start.item).not.toHaveProperty("queue_length");
    const first = mixStoredIds();
    expect(first).toHaveLength(10);
    expect(mixInPool(first, "deflection")).toHaveLength(4);
    expect(mixInPool(first, "pin")).toHaveLength(3);
    expect(mixInPool(first, "skewer")).toHaveLength(3);
    expect(db.prepare("SELECT motif FROM training_runs").all()).toEqual([
      { motif: "mix-practice" },
    ]);
    const secondState = await mixPassTheTenth(activity, start);
    expect(secondState.run_motif).toBe("mix-practice");
    const stored = mixStoredIds();
    expect(stored).toHaveLength(20);
    const second = stored.slice(10);
    expect(mixInPool(second, "deflection")).toHaveLength(4);
    expect(mixInPool(second, "pin")).toHaveLength(3);
    expect(mixInPool(second, "skewer")).toHaveLength(3);
    expect(new Set(stored).size).toBe(20);
    expect(second.every((id) => !first.includes(id))).toBe(true);
  });

  it("completes one listed theme with the two least played motif themes, list order on ties", async () => {
    for (const theme of ["deflection", "advancedPawn", "attackingF2F7"])
      mixAddPool(theme, 12, [theme]);
    mixListAsWeak("deflection");
    const { activity } = withMixSeed(1);
    await activity.startTraining({ mode: "puzzles", motif: MIX_PRACTICE_MOTIF });
    const ids = mixStoredIds();
    expect(ids).toHaveLength(10);
    expect(mixInPool(ids, "deflection")).toHaveLength(4);
    expect(mixInPool(ids, "advancedPawn")).toHaveLength(3);
    expect(mixInPool(ids, "attackingF2F7")).toHaveLength(3);
  });

  it("skips the most played motif theme when completing a short list", async () => {
    for (const theme of ["deflection", "attackingF2F7", "capturingDefender", "advancedPawn"])
      mixAddPool(theme, 12, [theme]);
    mixListAsWeak("deflection");
    mixAddHistory("advancedPawn", 10, 10);
    const { activity } = withMixSeed(1);
    await activity.startTraining({ mode: "puzzles", motif: MIX_PRACTICE_MOTIF });
    const ids = mixStoredIds();
    expect(mixInPool(ids, "advancedPawn")).toHaveLength(0);
    expect(mixInPool(ids, "deflection")).toHaveLength(4);
    expect(mixInPool(ids, "attackingF2F7")).toHaveLength(3);
    expect(mixInPool(ids, "capturingDefender")).toHaveLength(3);
  });

  it("draws from the first three motif themes with no improvement area and no attempt", async () => {
    const firstThree = LICHESS_PRACTICE_MOTIFS.slice(0, 3).map((entry) => entry.theme);
    for (const theme of firstThree) mixAddPool(theme, 12, [theme]);
    expect(mixImprovementAreas()).toEqual([]);
    const { activity } = withMixSeed(1);
    await activity.startTraining({ mode: "puzzles", motif: MIX_PRACTICE_MOTIF });
    const ids = mixStoredIds();
    expect(ids).toHaveLength(10);
    expect(mixInPool(ids, firstThree[0] as string)).toHaveLength(4);
    expect(mixInPool(ids, firstThree[1] as string)).toHaveLength(3);
    expect(mixInPool(ids, firstThree[2] as string)).toHaveLength(3);
  });

  it("gives two puzzles to each of the two weakest with eight improvement areas", async () => {
    const eight = [
      "deflection",
      "fork",
      "kingsideAttack",
      "pin",
      "queensideAttack",
      "sacrifice",
      "skewer",
      "trappedPiece",
    ];
    for (const theme of eight) mixAddPool(theme, 12, [theme]);
    mixListAsWeak(...eight);
    expect(mixImprovementAreas()).toEqual([...eight].sort());
    const { activity } = withMixSeed(1);
    await activity.startTraining({ mode: "puzzles", motif: MIX_PRACTICE_MOTIF });
    const ids = mixStoredIds();
    expect(ids).toHaveLength(10);
    const ordered = [...eight].sort();
    expect(mixInPool(ids, ordered[0] as string)).toHaveLength(2);
    expect(mixInPool(ids, ordered[1] as string)).toHaveLength(2);
    for (const theme of ordered.slice(2)) expect(mixInPool(ids, theme)).toHaveLength(1);
  });

  it.each([1, 2, 3, 4, 5, 6])(
    "serves no puzzle twice when one puzzle carries two themes (seed %i)",
    async (seed) => {
      mixAddThemed("both-00", ["deflection", "pin"]);
      for (const theme of ["deflection", "pin", "skewer"]) mixAddPool(theme, 12, [theme]);
      mixListAsWeak("deflection", "pin", "skewer");
      const { activity } = withMixSeed(seed);
      const start = training(
        await activity.startTraining({ mode: "puzzles", motif: MIX_PRACTICE_MOTIF }),
      );
      await mixPassTheTenth(activity, start);
      const ids = mixStoredIds();
      expect(ids).toHaveLength(20);
      expect(new Set(ids).size).toBe(20);
    },
  );

  it.each([1, 2, 3, 4])(
    "never serves a puzzle of the first batch again when each pool holds only its share (seed %i)",
    async (seed) => {
      mixAddPool("deflection", 4, ["deflection"]);
      mixAddPool("pin", 3, ["pin"]);
      mixAddPool("skewer", 3, ["skewer"]);
      mixListAsWeak("deflection", "pin", "skewer");
      const { activity } = withMixSeed(seed);
      const start = training(
        await activity.startTraining({ mode: "puzzles", motif: MIX_PRACTICE_MOTIF }),
      );
      expect(mixStoredIds()).toHaveLength(10);
      const last = await mixPassTheTenth(activity, start);
      expect(last.summary).toEqual({ solved: 10, failed: 0 });
      expect(last.input_enabled).toBe(false);
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "leaves a batch in no theme-by-theme order (seed %i)",
    async (seed) => {
      for (const theme of ["deflection", "pin", "skewer"]) mixAddPool(theme, 12, [theme]);
      mixListAsWeak("deflection", "pin", "skewer");
      const { activity } = withMixSeed(seed);
      await activity.startTraining({ mode: "puzzles", motif: MIX_PRACTICE_MOTIF });
      const themes = mixStoredIds().map((id) => id.split("-")[0]);
      expect(themes).toHaveLength(10);
      const runs = themes.filter((theme, index) => index === 0 || theme !== themes[index - 1]);
      expect(runs.length).toBeGreaterThan(3);
    },
  );

  it("keeps the batch at 10 when a theme has no puzzle, passing its share on", async () => {
    mixAddPool("deflection", 12, ["deflection"]);
    mixAddPool("pin", 12, ["pin"]);
    mixListAsWeak("deflection", "pin", "skewer");
    expect(mixImprovementAreas()).toEqual(["deflection", "pin", "skewer"]);
    const { activity } = withMixSeed(1);
    await activity.startTraining({ mode: "puzzles", motif: MIX_PRACTICE_MOTIF });
    const ids = mixStoredIds();
    expect(ids).toHaveLength(10);
    expect(mixInPool(ids, "skewer")).toHaveLength(0);
    expect(mixInPool(ids, "deflection").length + mixInPool(ids, "pin").length).toBe(10);
  });

  it("refuses an empty mix queue with empty_queue and writes no run", async () => {
    mixListAsWeak("deflection", "pin", "skewer");
    const { activity } = setup();
    expect(await code(activity.startTraining({ mode: "puzzles", motif: MIX_PRACTICE_MOTIF }))).toBe(
      "empty_queue",
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM training_runs").get()).toEqual({ n: 0 });
  });

  it("starts without a stored puzzle carrying the reserved motif", async () => {
    for (const theme of ["deflection", "pin", "skewer"]) mixAddPool(theme, 12, [theme]);
    mixListAsWeak("deflection", "pin", "skewer");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM puzzles WHERE motif = ?").get(MIX_PRACTICE_MOTIF),
    ).toEqual({ n: 0 });
    const { activity } = setup();
    const state = training(
      await activity.startTraining({ mode: "puzzles", motif: MIX_PRACTICE_MOTIF }),
    );
    expect(state.run_motif).toBe("mix-practice");
    expect(mixStoredIds()).toHaveLength(10);
  });

  it("moves the puzzle rating on a first-try solve like any rated queue", async () => {
    for (const theme of ["deflection", "pin", "skewer"]) mixAddPool(theme, 12, [theme]);
    mixListAsWeak("deflection", "pin", "skewer");
    const { activity } = withMixSeed(1);
    const start = training(
      await activity.startTraining({ mode: "puzzles", motif: MIX_PRACTICE_MOTIF }),
    );
    expect(start).toMatchObject({ student_rating: 1200, rating_change: null });
    const solved = training(await activity.trainingTry("a1a8", start.activity_id));
    expect(solved).toMatchObject({ student_rating: 1216, rating_change: 16 });
  });

  it("orders the queue differently with differently seeded shuffles", async () => {
    for (const theme of ["deflection", "pin", "skewer"]) mixAddPool(theme, 12, [theme]);
    mixListAsWeak("deflection", "pin", "skewer");
    const orderOf = async (seed: number): Promise<string[]> => {
      const { activity } = withMixSeed(seed);
      await activity.startTraining({ mode: "puzzles", motif: MIX_PRACTICE_MOTIF });
      const ids = mixStoredIds();
      await activity.endTraining();
      return ids;
    };
    const first = await orderOf(1);
    const second = await orderOf(2);
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(first).not.toEqual(second);
    expect(await orderOf(1)).toEqual(first);
  });
});

describe("a drill of the positions from the student's games", () => {
  const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const AFTER_C5 = "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
  const HOUR_MS = 3_600_000;
  const hoursFromT0 = (hours: number): string =>
    new Date(T0.getTime() + hours * HOUR_MS).toISOString();

  interface FoundFixture {
    color?: "white" | "black";
    phase?: "opening" | "middlegame" | "endgame";
    fromRepeat?: boolean;
    listed?: boolean;
    // Left out after a run had listed it, so its puzzle row stays.
    keptPuzzle?: boolean;
    accepted?: string[];
    foundAt?: string;
  }

  // A position as the generator stores it: its row and, once listed, its one-move puzzle.
  function addFound(id: string, fixture: FoundFixture = {}): void {
    const color = fixture.color ?? "black";
    const phase = fixture.phase ?? "opening";
    const fen = color === "black" ? AFTER_E4 : START_FEN;
    const accepted = fixture.accepted ?? [color === "black" ? "e7e5" : "e2e4"];
    insertFoundPosition(db, {
      id,
      fen,
      color,
      phase,
      fromMistake: !fixture.fromRepeat,
      fromRepeat: fixture.fromRepeat ?? false,
      fromDeparture: false,
      listed: fixture.listed ?? true,
      acceptedUci: accepted,
      reachedGames: 1,
      bestGames: 0,
      lastReachedAt: T0.toISOString(),
      gameId: 1,
      ply: 2,
      firstFoundAt: fixture.foundAt ?? hoursFromT0(-100),
    });
    if (fixture.listed === false && !fixture.keptPuzzle) return;
    addPuzzle(id, `${phase}-${color}`, fen, [accepted[0] as string]);
  }

  // The grades the drill logged for the cards, one for each rating that moved a card.
  const loggedGrades = (): { key: string; grade: number }[] =>
    (
      db.prepare("SELECT card_key, grade FROM drill_reviews ORDER BY id").all() as {
        card_key: string;
        grade: number;
      }[]
    ).map((row) => ({ key: row.card_key, grade: row.grade }));

  const minutesFromT0 = (minutes: number): string =>
    new Date(T0.getTime() + minutes * 60_000).toISOString();

  // A learned card, two right first tries behind it, due again at `next`.
  function addFoundCard(id: string, next: string): void {
    db.prepare(
      `INSERT INTO found_cards (position_id, interval_hours, fsrs_state, stability, difficulty,
         next_review_at, introduced_at, reviews, last_reviewed_at)
       VALUES (?, 24, 2, 1, 2.1181, ?, ?, 2, ?)`,
    ).run(id, next, hoursFromT0(-48), hoursFromT0(-24));
  }

  const foundCard = (id: string): unknown =>
    db
      .prepare(
        `SELECT interval_hours, fsrs_state, learning_step, lapses, next_review_at, reviews,
           last_reviewed_at
         FROM found_cards WHERE position_id = ?`,
      )
      .get(id);

  // The queue of the open run, in the order it serves it.
  const servedIds = (): string[] => (openRun()?.items ?? []).map((item) => String(item.id));

  const runCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM training_runs").get() as { n: number }).n;

  // Three due cards, one of them due this very moment, two cards due tomorrow and twelve new
  // positions, each group stored out of the order it is served in.
  function fillSeventeen(): string[] {
    for (const [id, hours] of [
      ["due-x", 0],
      ["due-y", -5],
      ["due-z", -2],
      ["later-x", 26],
      ["later-y", 24],
    ] as const) {
      addFound(id);
      addFoundCard(id, hoursFromT0(hours));
    }
    const newestFirst: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `new-${String(i).padStart(2, "0")}`;
      addFound(id, { foundAt: hoursFromT0(-100 + i) });
      newestFirst.unshift(id);
    }
    return newestFirst;
  }

  it("serves the due cards by review time and then the newest positions, ten in recommended", async () => {
    const newestFirst = fillSeventeen();
    const { activity } = setup();
    const state = training(await activity.startTraining({ mode: "found", scope: "recommended" }));
    expect(state).toMatchObject({
      mode: "found",
      item: { kind: "puzzle", puzzle_id: "due-y", queue_length: 10 },
    });
    expect(servedIds()).toEqual(["due-y", "due-z", "due-x", ...newestFirst.slice(0, 7)]);
  });

  it("serves only the due cards in due, and every position in all, due, new, then the rest", async () => {
    const newestFirst = fillSeventeen();
    const { activity } = setup();
    await activity.startTraining({ mode: "found", scope: "due" });
    expect(servedIds()).toEqual(["due-y", "due-z", "due-x"]);
    const all = training(await activity.startTraining({ mode: "found", scope: "all" }));
    expect(all.item.queue_length).toBe(17);
    expect(servedIds()).toEqual(["due-y", "due-z", "due-x", ...newestFirst, "later-y", "later-x"]);
  });

  it("narrows every scope to the phase and the colour asked for", async () => {
    addFound("end-due", { phase: "endgame" });
    addFoundCard("end-due", hoursFromT0(-3));
    addFound("end-rep", { phase: "endgame", fromRepeat: true });
    addFound("end-later", { phase: "endgame" });
    addFoundCard("end-later", hoursFromT0(24));
    addFound("end-white", { phase: "endgame", color: "white" });
    addFoundCard("end-white", hoursFromT0(-4));
    addFound("mid-due", { phase: "middlegame" });
    addFoundCard("mid-due", hoursFromT0(-6));
    addFound("open-new", { phase: "opening" });
    const { activity } = setup();
    const served = async (input: Parameters<typeof activity.startTraining>[0]) => {
      await activity.startTraining(input);
      return servedIds();
    };

    expect(await served({ mode: "found", scope: "recommended", phase: "endgame" })).toEqual([
      "end-white",
      "end-due",
      "end-rep",
    ]);
    expect(await served({ mode: "found", scope: "due", phase: "endgame" })).toEqual([
      "end-white",
      "end-due",
    ]);
    expect(await served({ mode: "found", scope: "all", phase: "endgame" })).toEqual([
      "end-white",
      "end-due",
      "end-rep",
      "end-later",
    ]);
    expect(await served({ mode: "found", scope: "all", phase: "endgame", color: "black" })).toEqual(
      ["end-due", "end-rep", "end-later"],
    );
    expect(await served({ mode: "found", scope: "all", color: "white" })).toEqual(["end-white"]);
  });

  it("serves one position alone in all, due or not, and rates it by its first try", async () => {
    addFound("one");
    addFoundCard("one", hoursFromT0(24));
    addFound("other");
    addFoundCard("other", hoursFromT0(-1));
    const { activity } = setup();
    const state = training(
      await activity.startTraining({ mode: "found", scope: "all", position: "one" }),
    );
    expect(state.item).toMatchObject({ puzzle_id: "one", queue_length: 1 });
    expect(servedIds()).toEqual(["one"]);
    await activity.trainingTry("d7d5");
    expect(foundCard("one")).toMatchObject({
      interval_hours: 10 / 60,
      fsrs_state: 3,
      lapses: 1,
      next_review_at: minutesFromT0(10),
      reviews: 3,
    });
  });

  it("narrows the scope to the one position, so recommended refuses one that is not due", async () => {
    addFound("one");
    addFoundCard("one", hoursFromT0(24));
    addFound("other");
    const { activity } = setup();
    expect(
      await code(activity.startTraining({ mode: "found", scope: "recommended", position: "one" })),
    ).toBe("empty_queue");
    expect(runCount()).toBe(0);
  });

  it.each([
    ["an id nothing has", "own:missing"],
    ["the id of a position left out of the list", "left-out"],
  ])("refuses %s with empty_queue and writes no run", async (_name, position) => {
    addFound("listed");
    addFound("left-out", { listed: false, keptPuzzle: true });
    const { activity } = setup();
    expect(await code(activity.startTraining({ mode: "found", scope: "all", position }))).toBe(
      "empty_queue",
    );
    expect(activity.current()).toBeNull();
    expect(runCount()).toBe(0);
  });

  it("never serves a position left out of the list, in any scope", async () => {
    addFound("listed");
    addFound("left-out", { listed: false, keptPuzzle: true, foundAt: hoursFromT0(-1) });
    addFound("never-listed", { listed: false, foundAt: hoursFromT0(-2) });
    const { activity } = setup();
    for (const scope of ["recommended", "all"] as const) {
      await activity.startTraining({ mode: "found", scope });
      expect(servedIds()).toEqual(["listed"]);
    }
  });

  it("refuses recommended and due with no due card and no new position, and writes no run", async () => {
    addFound("later");
    addFoundCard("later", hoursFromT0(24));
    addFound("left-out", { listed: false, keptPuzzle: true });
    const { activity } = setup();
    for (const scope of ["recommended", "due"] as const) {
      expect(await code(activity.startTraining({ mode: "found", scope }))).toBe("empty_queue");
    }
    expect(activity.current()).toBeNull();
    expect(runCount()).toBe(0);
    await activity.startTraining({ mode: "found", scope: "all" });
    expect(servedIds()).toEqual(["later"]);
  });

  it("refuses a drill with no scope", async () => {
    addFound("one");
    const { activity } = setup();
    expect(await code(activity.startTraining({ mode: "found" }))).toBe("empty_queue");
    expect(runCount()).toBe(0);
  });

  it("takes any accepted move as right and leaves it on the board", async () => {
    addFound("two-good", { accepted: ["e7e5", "c7c5"] });
    const { activity } = setup();
    await activity.startTraining({ mode: "found", scope: "all" });
    const solved = training(await activity.trainingTry("c7c5"));
    expect(solved).toMatchObject({
      status: "solved",
      fen: AFTER_C5,
      last_move: { from: "c7", to: "c5" },
      last_try: { uci: "c7c5", correct: true },
      moves: [{ ply: 0, uci: "c7c5", san: "c5", by: "student" }],
      tries: 0,
    });
    expect(db.prepare("SELECT solved, first_try FROM puzzle_attempts").get()).toEqual({
      solved: 1,
      first_try: 1,
    });
  });

  it("keeps a move outside the accepted ones a wrong try", async () => {
    addFound("two-good", { accepted: ["e7e5", "c7c5"] });
    const { activity } = setup();
    await activity.startTraining({ mode: "found", scope: "all" });
    const missed = training(await activity.trainingTry("d7d5"));
    expect(missed).toMatchObject({
      status: "prompt",
      fen: AFTER_E4,
      tries: 1,
      last_try: { uci: "d7d5", correct: false },
    });
  });

  it("keeps the same puzzle to its one solution move in mode puzzles", async () => {
    addFound("two-good", { accepted: ["e7e5", "c7c5"] });
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "opening-black" });
    const missed = training(await activity.trainingTry("c7c5"));
    expect(missed).toMatchObject({ mode: "puzzles", status: "prompt", tries: 1 });
    expect(training(await activity.trainingTry("e7e5")).status).toBe("solved");
  });

  it("rates a first-try solve Good: a new position gets its card, a due one moves up", async () => {
    addFound("fresh");
    addFound("due");
    addFoundCard("due", hoursFromT0(-1));
    const { activity } = setup();
    await activity.startTraining({ mode: "found", scope: "all", position: "fresh" });
    await activity.trainingTry("e7e5");
    expect(foundCard("fresh")).toEqual({
      interval_hours: 10 / 60,
      fsrs_state: 1,
      learning_step: 1,
      lapses: 0,
      next_review_at: minutesFromT0(10),
      reviews: 1,
      last_reviewed_at: T0.toISOString(),
    });
    await activity.startTraining({ mode: "found", scope: "all", position: "due" });
    await activity.trainingTry("e7e5");
    expect(foundCard("due")).toMatchObject({ fsrs_state: 2, lapses: 0, reviews: 3 });
    expect((foundCard("due") as { interval_hours: number }).interval_hours).toBeGreaterThan(24);
    expect(loggedGrades()).toEqual([
      { key: "fresh", grade: 3 },
      { key: "due", grade: 3 },
    ]);
  });

  it("rates a wrong first try Again, back in 10 minutes, and no later try at all", async () => {
    addFound("due");
    addFoundCard("due", hoursFromT0(-1));
    const { activity } = setup();
    await activity.startTraining({ mode: "found", scope: "all" });
    await activity.trainingTry("d7d5");
    const missed = foundCard("due");
    expect(missed).toMatchObject({
      interval_hours: 10 / 60,
      fsrs_state: 3,
      lapses: 1,
      next_review_at: minutesFromT0(10),
      reviews: 3,
    });
    // A second wrong try would count another review and lapse again if it rated the card.
    await activity.trainingTry("g8f6");
    expect(training(await activity.trainingTry("e7e5")).status).toBe("solved");
    expect(foundCard("due")).toEqual(missed);
    expect(loggedGrades()).toEqual([{ key: "due", grade: 1 }]);
  });

  it.each([
    ["a hint", "hint"],
    ["a shown solution", "give_up"],
  ] as const)("rates %s before any try Again, and nothing after it", async (_n, how) => {
    addFound("fresh");
    const { activity } = setup();
    await activity.startTraining({ mode: "found", scope: "all" });
    if (how === "hint") await activity.trainingHint();
    else await activity.trainingShowSolution();
    const rated = foundCard("fresh");
    expect(rated).toMatchObject({
      interval_hours: 1 / 60,
      fsrs_state: 1,
      learning_step: 0,
      next_review_at: minutesFromT0(1),
      reviews: 1,
    });
    if (how === "hint") {
      await activity.trainingTry("d7d5");
      expect(training(await activity.trainingTry("e7e5")).status).toBe("solved");
      expect(db.prepare("SELECT first_try FROM puzzle_attempts").get()).toEqual({ first_try: 0 });
    }
    expect(foundCard("fresh")).toEqual(rated);
  });

  it("keeps the schedule of a card not yet due on a right first try", async () => {
    addFound("early");
    addFoundCard("early", hoursFromT0(24));
    const { activity } = setup();
    const before = foundCard("early");
    await activity.startTraining({ mode: "found", scope: "all" });
    expect(training(await activity.trainingTry("e7e5")).status).toBe("solved");
    expect(foundCard("early")).toEqual(before);
    expect(foundCard("early")).toMatchObject({ next_review_at: hoursFromT0(24) });
    expect(loggedGrades()).toEqual([]);
  });

  it("writes the attempt of a miss as for any puzzle, with no review card and no rating move", async () => {
    addFound("missed");
    addFound("given-up");
    setPuzzleRating(db, 1350, T0.toISOString());
    const { activity } = setup();
    await activity.startTraining({ mode: "found", scope: "all", position: "missed" });
    await activity.trainingTry("d7d5");
    const solved = training(await activity.trainingTry("e7e5"));
    expect(solved).toMatchObject({ status: "solved", rating_change: null, student_rating: 1350 });
    await activity.startTraining({ mode: "found", scope: "all", position: "given-up" });
    await activity.trainingShowSolution();
    expect(db.prepare("SELECT COUNT(*) AS n FROM srs_cards").get()).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          "SELECT puzzle_id, solved, first_try, tries, gave_up FROM puzzle_attempts ORDER BY id",
        )
        .all(),
    ).toEqual([
      { puzzle_id: "missed", solved: 1, first_try: 0, tries: 1, gave_up: 0 },
      { puzzle_id: "given-up", solved: 0, first_try: 0, tries: 0, gave_up: 1 },
    ]);
    expect(currentPuzzleRating(db)).toBe(1350);
  });

  it("writes no review card and rates no found card when its puzzle is missed in mode puzzles", async () => {
    addFound("own:missed");
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "opening-black" });
    await activity.trainingTry("d7d5");
    expect(training(await activity.trainingTry("e7e5")).status).toBe("solved");
    expect(db.prepare("SELECT puzzle_id FROM srs_cards").all()).toEqual([]);
    expect(foundCard("own:missed")).toBeUndefined();
  });

  it("keeps the run in training_runs and ends it as left when the student leaves the board", async () => {
    addFound("a");
    addFound("b", { foundAt: hoursFromT0(-1) });
    const { activity } = setup();
    await activity.startTraining({ mode: "found", scope: "recommended" });
    const stored = () =>
      db.prepare("SELECT mode, size, items_json, ended_reason FROM training_runs").get();
    expect(stored()).toEqual({
      mode: "found",
      size: 2,
      items_json: JSON.stringify([
        { kind: "puzzle", id: "b" },
        { kind: "puzzle", id: "a" },
      ]),
      ended_reason: null,
    });
    await activity.newGame({ color: "white", elo: 1200 });
    expect(stored()).toMatchObject({ mode: "found", ended_reason: "left" });
  });

  it("ends a drill of the positions from games as left when the server starts", async () => {
    addFound("a");
    addFound("b");
    const first = setup();
    await first.activity.startTraining({ mode: "found", scope: "all" });
    await first.activity.trainingTry("e7e5");
    expect(openRun()).not.toBeNull();

    endRunsLeftOpenAtStart(db, T0.toISOString());
    const second = setup();
    expect(second.activity.current()).toBeNull();
    expect(db.prepare("SELECT mode, ended_reason FROM training_runs").get()).toEqual({
      mode: "found",
      ended_reason: "left",
    });
    expect(foundCard("a")).toMatchObject({ reviews: 1 });
    expect(foundCard("b")).toBeUndefined();
  });

  describe("a retry of a position that ended", () => {
    const foundRow = (id: string): unknown =>
      db.prepare("SELECT * FROM found_cards WHERE position_id = ?").get(id);

    it.each([
      ["a wrong try", (activity: ActivityService) => activity.trainingTry("d7d5")],
      ["a hint", (activity: ActivityService) => activity.trainingHint()],
      ["the solution shown", (activity: ActivityService) => activity.trainingShowSolution()],
    ])("leaves the card a right first play made as it was after %s", async (_name, miss) => {
      addFound("one");
      const clock = steppingClock();
      const { activity } = setup(clock);
      await activity.startTraining({ mode: "found", scope: "all" });
      const solved = training(await activity.trainingTry("e7e5"));
      expect(solved.status).toBe("solved");
      const card = foundRow("one");
      expect(card).toMatchObject({ reviews: 1, lapses: 0 });
      expect(loggedGrades()).toEqual([{ key: "one", grade: 3 }]);

      clock.advance(3600);
      const again = training(await activity.retryTrainingItem());
      expect(again).toMatchObject({ status: "prompt", retry: true, mode: "found" });
      expect(again.item).toMatchObject({ puzzle_id: "one", position_in_queue: 1 });
      await miss(activity);
      expect(foundRow("one")).toEqual(card);
      if (training(activity.current()).status !== "failed") await activity.trainingShowSolution();
      expect(training(activity.current())).toMatchObject({ status: "failed", retry: true });
      expect(foundRow("one")).toEqual(card);
      expect(loggedGrades()).toEqual([{ key: "one", grade: 3 }]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM puzzle_attempts").get()).toEqual({ n: 1 });
    });

    it("leaves the card a missed first play made as it was when the retry is right", async () => {
      addFound("one", { accepted: ["e7e5", "c7c5"] });
      const clock = steppingClock();
      const { activity, notes } = setup(clock);
      await activity.startTraining({ mode: "found", scope: "all" });
      await activity.trainingTry("d7d5");
      await activity.trainingTry("e7e5");
      const card = foundRow("one");
      expect(card).toMatchObject({ reviews: 1 });
      expect(loggedGrades()).toEqual([{ key: "one", grade: 1 }]);
      const told = notes();

      clock.advance(3600);
      await activity.retryTrainingItem();
      const solved = training(await activity.trainingTry("c7c5"));
      expect(solved).toMatchObject({
        status: "solved",
        retry: true,
        moves: [{ uci: "c7c5", san: "c5" }],
        queue_outcomes: ["solved"],
      });
      expect(foundRow("one")).toEqual(card);
      expect(loggedGrades()).toEqual([{ key: "one", grade: 1 }]);
      expect(notes()).toEqual(told);
      expect(db.prepare("SELECT COUNT(*) AS n FROM puzzle_attempts").get()).toEqual({ n: 1 });
    });
  });

  describe("the note of the position", () => {
    const NOTE = "Claims the center and frees the bishop for the diagonal.";

    function addNoted(id: string, fixture: FoundFixture = {}): void {
      addFound(id, fixture);
      expect(setFoundNote(db, id, NOTE)).toBe(true);
    }

    it("is not in the state while the item is open, a wrong try or a hint included", async () => {
      addNoted("noted");
      const { activity } = setup();
      const served = training(await activity.startTraining({ mode: "found", scope: "all" }));
      expect(served.note).toBeNull();
      expect(training(await activity.trainingTry("d7d5")).note).toBeNull();
      expect(training(await activity.trainingHint()).note).toBeNull();
      expect(JSON.stringify(activity.current())).not.toContain(NOTE);
    });

    it("goes while a retry is open and comes back when the retry ends", async () => {
      addNoted("noted");
      const { activity } = setup();
      await activity.startTraining({ mode: "found", scope: "all" });
      await activity.trainingTry("e7e5");
      expect(training(await activity.retryTrainingItem()).note).toBeNull();
      expect(JSON.stringify(activity.current())).not.toContain(NOTE);
      const shown = training(await activity.trainingShowSolution());
      expect(shown).toMatchObject({ status: "failed", note: { san: "e5", text: NOTE } });
    });

    it("comes with a solved item, titled by the move that was right", async () => {
      addNoted("noted");
      const { activity } = setup();
      await activity.startTraining({ mode: "found", scope: "all" });
      const solved = training(await activity.trainingTry("e7e5"));
      expect(solved).toMatchObject({ status: "solved", note: { san: "e5", text: NOTE } });
    });

    it("names the best accepted move when the student solved it with another accepted one", async () => {
      addNoted("two-good", { accepted: ["e7e5", "c7c5"] });
      const { activity } = setup();
      await activity.startTraining({ mode: "found", scope: "all" });
      const solved = training(await activity.trainingTry("c7c5"));
      expect(solved).toMatchObject({
        status: "solved",
        moves: [{ uci: "c7c5", san: "c5" }],
        note: { san: "e5", text: NOTE },
      });
    });

    it("comes with the solution once it is shown, even after a wrong try", async () => {
      addNoted("noted");
      const { activity } = setup();
      await activity.startTraining({ mode: "found", scope: "all" });
      await activity.trainingTry("d7d5");
      const shown = training(await activity.trainingShowSolution());
      expect(shown).toMatchObject({
        status: "failed",
        gave_up: true,
        expected: { uci: "e7e5", san: "e5" },
        note: { san: "e5", text: NOTE },
      });
    });

    it("is null at the end of a position that has no note", async () => {
      addFound("bare");
      const { activity } = setup();
      await activity.startTraining({ mode: "found", scope: "all" });
      const solved = training(await activity.trainingTry("e7e5"));
      expect(solved.status).toBe("solved");
      expect(solved).toHaveProperty("note", null);
    });

    it("moves on with the item: the next position shows its own note and none while open", async () => {
      addNoted("first", { foundAt: hoursFromT0(-1) });
      addFound("second");
      const { activity } = setup();
      await activity.startTraining({ mode: "found", scope: "all" });
      expect(training(await activity.trainingTry("e7e5")).note).toMatchObject({ text: NOTE });
      const next = training(await activity.nextTrainingItem());
      expect(next.item).toMatchObject({ puzzle_id: "second" });
      expect(next.note).toBeNull();
      expect(training(await activity.trainingTry("e7e5")).note).toBeNull();
    });

    it("is absent in another mode, though that puzzle is the same stored one", async () => {
      addNoted("noted");
      const { activity } = setup();
      await activity.startTraining({ mode: "puzzles", motif: "opening-black" });
      const solved = training(await activity.trainingTry("e7e5"));
      expect(solved).toMatchObject({ mode: "puzzles", status: "solved" });
      expect(solved).not.toHaveProperty("note");
      const open = training(await activity.startTraining({ mode: "openings", color: "black" }));
      expect(open).not.toHaveProperty("note");
    });
  });
});

describe("a drill of the positions from games narrowed to one opening", () => {
  const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";

  function addFoundWithOpening(
    id: string,
    openingName: string,
    fixture: { color?: "white" | "black"; phase?: "opening" | "middlegame" | "endgame" } = {},
  ): void {
    const color = fixture.color ?? "black";
    const phase = fixture.phase ?? "opening";
    const fen = color === "black" ? AFTER_E4 : START_FEN;
    const accepted = [color === "black" ? "e7e5" : "e2e4"];
    insertFoundPosition(db, {
      id,
      fen,
      color,
      phase,
      fromMistake: true,
      fromRepeat: false,
      fromDeparture: false,
      listed: true,
      acceptedUci: accepted,
      reachedGames: 1,
      bestGames: 0,
      lastReachedAt: T0.toISOString(),
      gameId: 1,
      ply: 2,
      firstFoundAt: T0.toISOString(),
    });
    addPuzzle(id, `${phase}-${color}`, fen, accepted);
    db.prepare("UPDATE puzzles SET opening_name = ? WHERE id = ?").run(openingName, id);
  }

  function fillThree(): void {
    addFoundWithOpening("a-two-knights", "Italian Game: Two Knights Defense", {
      color: "black",
      phase: "opening",
    });
    addFoundWithOpening("b-giuoco", "Italian Game: Giuoco Pianissimo", {
      color: "black",
      phase: "middlegame",
    });
    addFoundWithOpening("c-scandi", "Scandinavian Defense", { color: "black", phase: "opening" });
  }

  const servedIds = (): string[] => (openRun()?.items ?? []).map((item) => String(item.id));

  const runCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM training_runs").get() as { n: number }).n;

  it("serves a family under its name and one variation under its full name", async () => {
    fillThree();
    const { activity } = setup();
    await activity.startTraining({ mode: "found", scope: "all", opening: "Italian Game" });
    expect(servedIds().sort()).toEqual(["a-two-knights", "b-giuoco"]);
    await activity.startTraining({
      mode: "found",
      scope: "all",
      opening: "Italian Game: Two Knights Defense",
    });
    expect(servedIds()).toEqual(["a-two-knights"]);
    await activity.startTraining({
      mode: "found",
      scope: "all",
      opening: "Scandinavian Defense",
    });
    expect(servedIds()).toEqual(["c-scandi"]);
  });

  it("serves every scope through the same opening filter", async () => {
    fillThree();
    for (const id of ["a-two-knights", "b-giuoco"]) {
      db.prepare(
        `INSERT INTO found_cards (position_id, interval_hours, fsrs_state, stability, difficulty,
           next_review_at, introduced_at, reviews, last_reviewed_at)
         VALUES (?, 24, 2, 1, 2.1181, ?, ?, 2, ?)`,
      ).run(
        id,
        new Date(T0.getTime() - 3_600_000).toISOString(),
        T0.toISOString(),
        T0.toISOString(),
      );
    }
    const { activity } = setup();
    for (const scope of ["recommended", "due", "all"] as const) {
      await activity.startTraining({ mode: "found", scope, opening: "Italian Game" });
      expect(servedIds().sort()).toEqual(["a-two-knights", "b-giuoco"]);
    }
  });

  it("combines the opening with the colour and the phase, each narrowing further", async () => {
    fillThree();
    const { activity } = setup();
    await activity.startTraining({
      mode: "found",
      scope: "all",
      opening: "Italian Game",
      color: "black",
    });
    expect(servedIds().sort()).toEqual(["a-two-knights", "b-giuoco"]);
    await activity.startTraining({
      mode: "found",
      scope: "all",
      opening: "Italian Game",
      phase: "opening",
    });
    expect(servedIds()).toEqual(["a-two-knights"]);
    await activity.startTraining({
      mode: "found",
      scope: "all",
      opening: "Italian Game",
      color: "black",
      phase: "middlegame",
    });
    expect(servedIds()).toEqual(["b-giuoco"]);
  });

  it("refuses an opening nothing carries with empty_queue and writes no run", async () => {
    fillThree();
    const { activity } = setup();
    expect(
      await code(
        activity.startTraining({ mode: "found", scope: "all", opening: "French Defense" }),
      ),
    ).toBe("empty_queue");
    expect(activity.current()).toBeNull();
    expect(runCount()).toBe(0);
    expect(
      await code(
        activity.startTraining({
          mode: "found",
          scope: "all",
          opening: "Italian Game",
          color: "white",
        }),
      ),
    ).toBe("empty_queue");
    expect(runCount()).toBe(0);
  });

  it("refuses a prefix of a family that is not the family, and writes no run", async () => {
    fillThree();
    const { activity } = setup();
    expect(
      await code(activity.startTraining({ mode: "found", scope: "all", opening: "Italian" })),
    ).toBe("empty_queue");
    expect(activity.current()).toBeNull();
    expect(runCount()).toBe(0);
  });

  it("treats an opening with a quote as a literal value, not as SQL", async () => {
    fillThree();
    const { activity } = setup();
    expect(
      await code(activity.startTraining({ mode: "found", scope: "all", opening: "' OR '1'='1" })),
    ).toBe("empty_queue");
    expect(runCount()).toBe(0);
  });
});

describe("a miss on a position from the student's games, in any mode but its own drill", () => {
  const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  // The id the generator gives the position, so the rule is held to the prefix it really writes.
  const OWN = puzzleId(positionKey(AFTER_E4));
  // A Lichess id on a library row of the same motif, so that all three ways serve it too: only the
  // id tells the two puzzles apart.
  const LICHESS = "lichess-db:00sHx";

  type Served = Promise<ActivityState | null>;
  const WAYS: [
    string,
    TrainingActivity["mode"],
    (activity: ActivityService, id: string) => Served,
  ][] = [
    [
      "the openings drill",
      "openings",
      (activity) => activity.startTraining({ mode: "openings", color: "black" }),
    ],
    [
      "a puzzles queue",
      "puzzles",
      (activity) => activity.startTraining({ mode: "puzzles", motif: "opening-black" }),
    ],
    [
      "a single puzzle the coach serves",
      "puzzles",
      (activity, id) => activity.startTrainingItem({ kind: "puzzle", id }),
    ],
  ];

  const cardPuzzles = (): unknown[] => db.prepare("SELECT puzzle_id FROM srs_cards").all();
  const attempts = (): unknown[] =>
    db
      .prepare(
        "SELECT puzzle_id, solved, first_try, tries, gave_up, hinted FROM puzzle_attempts ORDER BY id",
      )
      .all();

  it.each(WAYS)(
    "makes no review card in %s, and still writes the attempt",
    async (_way, mode, start) => {
      addPuzzle(OWN, "opening-black", AFTER_E4, ["e7e5"]);
      const { activity } = setup();
      const served = training(await start(activity, OWN));
      expect(served).toMatchObject({ mode, item: { kind: "puzzle", puzzle_id: OWN } });
      await activity.trainingTry("d7d5");
      expect(training(await activity.trainingTry("e7e5")).status).toBe("solved");
      expect(cardPuzzles()).toEqual([]);
      expect(attempts()).toEqual([
        { puzzle_id: OWN, solved: 1, first_try: 0, tries: 1, gave_up: 0, hinted: 0 },
      ]);
    },
  );

  it.each(WAYS)(
    "still makes one review card of a Lichess puzzle missed in %s",
    async (_way, mode, start) => {
      addPuzzle(LICHESS, "opening-black", AFTER_E4, ["e7e5"]);
      const { activity } = setup();
      const served = training(await start(activity, LICHESS));
      expect(served).toMatchObject({ mode, item: { kind: "puzzle", puzzle_id: LICHESS } });
      await activity.trainingTry("d7d5");
      expect(training(await activity.trainingTry("e7e5")).status).toBe("solved");
      expect(cardPuzzles()).toEqual([{ puzzle_id: LICHESS }]);
      expect(attempts()).toEqual([
        { puzzle_id: LICHESS, solved: 1, first_try: 0, tries: 1, gave_up: 0, hinted: 0 },
      ]);
    },
  );

  it("makes none either when the solution is shown or the solve took a hint", async () => {
    addPuzzle(OWN, "opening-black", AFTER_E4, ["e7e5"]);
    const { activity } = setup();
    await activity.startTrainingItem({ kind: "puzzle", id: OWN });
    expect(training(await activity.trainingShowSolution()).status).toBe("failed");
    await activity.endTraining();
    await activity.startTrainingItem({ kind: "puzzle", id: OWN });
    await activity.trainingHint();
    expect(training(await activity.trainingTry("e7e5")).status).toBe("solved");
    expect(cardPuzzles()).toEqual([]);
    expect(attempts()).toEqual([
      { puzzle_id: OWN, solved: 0, first_try: 0, tries: 0, gave_up: 1, hinted: 0 },
      { puzzle_id: OWN, solved: 1, first_try: 0, tries: 0, gave_up: 0, hinted: 1 },
    ]);
  });

  it("is what the Grading entry of AGENTS.md says", () => {
    const agents = readFileSync(join(import.meta.dirname, "../../../../AGENTS.md"), "utf8");
    const entry = /- \*\*Grading:\*\*[\s\S]*?(?=\n- \*\*)/.exec(agents)?.[0] ?? "";
    const grading = entry.replace(/\s+/g, " ");
    expect(grading).toContain(
      "a position from the student's games never becomes a review card: a puzzle whose id starts with `own:` makes none in any mode",
    );
    expect(grading).toContain("a single puzzle the coach serves included");
    expect(grading).toContain("still writes its `puzzle_attempts` row");
  });
});

describe("what a review card says it is, and the explanation it shows at the end", () => {
  const AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
  const LICHESS = "lichess-db:03oA5";
  const WHY = "Take the centre first: the queen's pawn is defended, the king's pawn is not.";

  // The state as the browser reads it: the schema drops whatever it does not declare.
  const onTheWire = (state: ActivityState | null): TrainingActivity =>
    TrainingActivitySchema.parse(training(state));
  const originOf = (state: ActivityState | null): unknown =>
    (onTheWire(state).item as { origin?: unknown }).origin;
  const storedCards = (): unknown[] =>
    db.prepare("SELECT source_kind, puzzle_id FROM srs_cards ORDER BY id").all();
  const exposureOf = (state: TrainingActivity): string =>
    (state.item as { exposure_id: string }).exposure_id;

  // The coach's own tool, called as the SDK calls it, with the fake world's evaluator.
  async function addCoachCard(explanation: string): Promise<number> {
    const tools = buildSrsTools({
      db,
      clock: fixedClock,
      evaluateMove: makeWorld(db).world.evaluateMove,
    });
    const tool = tools.find((entry) => entry.name === "add_srs_card");
    if (!tool) throw new Error("add_srs_card is not registered");
    const input = { fen: START_FEN, played_uci: "e2e4", best_uci: "d2d4", explanation };
    const result = await tool.handler(z.object(tool.inputSchema).parse(input) as never, {});
    const body = JSON.parse((result.content[0] as { text: string }).text) as { card_id: number };
    return body.card_id;
  }

  // The card a missed puzzle leaves, made by the miss itself: the puzzle is given up and its run ended.
  async function missPuzzle(activity: ActivityService, id: string): Promise<void> {
    await activity.startTrainingItem({ kind: "puzzle", id });
    await activity.trainingShowSolution();
    await activity.endTraining();
  }

  describe("the origin of the card", () => {
    it("is game for a card made from a move of a game", async () => {
      expect(createCardsFromGame(db, insertGradedGame(db), fixedClock)).toMatchObject({
        created: 3,
      });
      expect(storedCards()).toContainEqual({ source_kind: "game_move", puzzle_id: null });
      const { activity } = setup();
      expect(originOf(await activity.startTraining({ mode: "srs" }))).toBe("game");
    });

    it("is game for a card whose puzzle is a position from the student's games", async () => {
      const own = puzzleId(positionKey(AFTER_E4));
      addPuzzle(own, "opening-black", AFTER_E4, ["e7e5"]);
      addPuzzleCard(own, AFTER_E4, "e7e5");
      expect(storedCards()).toEqual([{ source_kind: "teaching", puzzle_id: own }]);
      const { activity } = setup();
      expect(originOf(await activity.startTraining({ mode: "srs" }))).toBe("game");
    });

    it("is puzzle for the card a missed Lichess puzzle leaves", async () => {
      addPuzzle(LICHESS, "fork", LICHESS_FORK, LICHESS_FORK_LINE);
      const { activity } = setup();
      await missPuzzle(activity, LICHESS);
      expect(storedCards()).toEqual([{ source_kind: "teaching", puzzle_id: LICHESS }]);
      expect(originOf(await activity.startTraining({ mode: "srs" }))).toBe("puzzle");
    });

    it("is coach for a card the coach's tool made", async () => {
      await addCoachCard(WHY);
      expect(storedCards()).toEqual([{ source_kind: "teaching", puzzle_id: null }]);
      const { activity } = setup();
      expect(originOf(await activity.startTraining({ mode: "srs" }))).toBe("coach");
    });

    // The rule reads the columns in order, and the kind of source comes first.
    it("stays game for a game's card that names a puzzle the student missed", async () => {
      addPuzzle(LICHESS, "fork", LICHESS_FORK, LICHESS_FORK_LINE);
      const card = insertCard(db, {
        sourceKind: "game_move",
        sourceGameId: null,
        sourceMoveId: null,
        promptFen: LICHESS_FORK,
        studentColor: "black",
        playedUci: null,
        expectedUci: "f8d6",
        cpLoss: 150,
        classification: "mistake",
        explanation: null,
        createdAt: T0.toISOString(),
        puzzleId: LICHESS,
      });
      expect(card).not.toBeNull();
      const { activity } = setup();
      expect(originOf(await activity.startTraining({ mode: "srs" }))).toBe("game");
    });

    it("comes with a single card the coach serves, and stays with the item to its end", async () => {
      const id = await addCoachCard(WHY);
      const { activity } = setup();
      const served = await activity.startTrainingItem({ kind: "card", id });
      expect(originOf(served)).toBe("coach");
      expect(originOf(await activity.trainingTry("e2e4"))).toBe("coach");
      const solved = await activity.trainingTry("d2d4");
      expect(originOf(solved)).toBe("coach");
      expect(originOf(await activity.rateCard(exposureOf(training(solved)), 3))).toBe("coach");
    });
  });

  describe("the explanation of the card", () => {
    it("is not in the state while the card is open, a wrong try or a hint included", async () => {
      await addCoachCard(WHY);
      const { activity } = setup();
      const served = onTheWire(await activity.startTraining({ mode: "srs" }));
      expect(served.note).toBeNull();
      expect(onTheWire(await activity.trainingTry("e2e4")).note).toBeNull();
      expect(onTheWire(await activity.trainingHint()).note).toBeNull();
      expect(JSON.stringify(activity.current())).not.toContain(WHY);
    });

    it("comes with a solved card, titled by its expected move, and stays once it is rated", async () => {
      await addCoachCard(WHY);
      const { activity } = setup();
      const served = training(await activity.startTraining({ mode: "srs" }));
      const solved = onTheWire(await activity.trainingTry("d2d4"));
      expect(solved).toMatchObject({ status: "solved", note: { san: "d4", text: WHY } });
      const rated = onTheWire(await activity.rateCard(exposureOf(served), 3));
      expect(rated).toMatchObject({ status: "rated", note: { san: "d4", text: WHY } });
    });

    it("comes with the solution once it is shown, even after a wrong try", async () => {
      await addCoachCard(WHY);
      const { activity } = setup();
      await activity.startTraining({ mode: "srs" });
      await activity.trainingTry("e2e4");
      const shown = onTheWire(await activity.trainingShowSolution());
      expect(shown).toMatchObject({
        status: "failed",
        gave_up: true,
        expected: { uci: "d2d4", san: "d4" },
        note: { san: "d4", text: WHY },
      });
    });

    it("is null at the end of a card that stores no explanation", async () => {
      addCard("d2d4");
      const { activity } = setup();
      await activity.startTraining({ mode: "srs" });
      const solved = training(await activity.trainingTry("d2d4"));
      expect(solved.status).toBe("solved");
      expect(solved).toHaveProperty("note", null);
    });

    it.each(["", "  \n"])("is null at the end of a card whose explanation is %j", async (empty) => {
      const id = addCard("d2d4");
      expect(setExplanation(db, id, empty)).toBe(true);
      const { activity } = setup();
      await activity.startTraining({ mode: "srs" });
      expect(training(await activity.trainingTry("d2d4"))).toHaveProperty("note", null);
      await activity.endTraining();
      await activity.startTraining({ mode: "srs" });
      expect(training(await activity.trainingShowSolution())).toHaveProperty("note", null);
    });

    describe("of a card left by an imported Lichess puzzle", () => {
      // One Lichess row under the themes given. The import files it under a motif by its themes
      // and stores that motif's sentence as the explanation, which the miss copies to the card.
      const rowOf = (id: string, themes: string): string =>
        [
          id,
          "q3k1nr/1pp1nQpp/3p4/1P2p3/4P3/B1PP1b2/B5PP/5K2 b k - 0 17",
          "e8d7 a2e6 d7d8 f7f8",
          "1498,76,87,178",
          themes,
          "https://lichess.org/game/yyznGmXs/black#34,,",
        ].join(",");

      async function missImported(id: string, themes: string) {
        async function* lines(): AsyncGenerator<string> {
          yield rowOf(id, themes);
        }
        await importLichessPuzzles({ lines: lines(), db, clock: fixedClock, log: silentLog });
        const { activity } = setup();
        await missPuzzle(activity, `lichess-db:${id}`);
        const cards = db.prepare("SELECT explanation FROM srs_cards").all();
        expect(cards).toHaveLength(1);
        return { activity, explanation: (cards[0] as { explanation: string | null }).explanation };
      }

      it("is null for the sentence the import gives a puzzle of no motif, solved or shown", async () => {
        const { activity, explanation } = await missImported("00none", "middlegame short");
        expect(explanation).toBe(FILLER_PUZZLE_EXPLANATION);
        await activity.startTraining({ mode: "srs" });
        await activity.trainingTry("a2e6");
        const solved = onTheWire(await activity.trainingTry("f7f8"));
        expect(solved.status).toBe("solved");
        expect(solved).toHaveProperty("note", null);
        await activity.endTraining();
        await activity.startTraining({ mode: "srs" });
        const shown = onTheWire(await activity.trainingShowSolution());
        expect(shown.status).toBe("failed");
        expect(shown).toHaveProperty("note", null);
      });

      it("is the sentence the import gives a motif, which says something", async () => {
        const themes = "mate mateIn2 middlegame short";
        const { activity, explanation } = await missImported("00sHx", themes);
        expect(explanation).toBeTruthy();
        expect(explanation).not.toBe(FILLER_PUZZLE_EXPLANATION);
        await activity.startTraining({ mode: "srs" });
        await activity.trainingTry("a2e6");
        const solved = onTheWire(await activity.trainingTry("f7f8"));
        expect(solved).toMatchObject({
          status: "solved",
          note: { san: "Be6+", text: explanation },
        });
      });
    });

    it("is null for a card of another origin that stores exactly the import's filler", async () => {
      await addCoachCard(FILLER_PUZZLE_EXPLANATION);
      const { activity } = setup();
      const served = onTheWire(await activity.startTraining({ mode: "srs" }));
      expect(served.item).toMatchObject({ origin: "coach" });
      const solved = onTheWire(await activity.trainingTry("d2d4"));
      expect(solved.status).toBe("solved");
      expect(solved).toHaveProperty("note", null);
    });

    it("is shown for an explanation that only starts with the import's filler", async () => {
      const longer = `${FILLER_PUZZLE_EXPLANATION} The queen's pawn is defended, the king's is not.`;
      await addCoachCard(longer);
      const { activity } = setup();
      await activity.startTraining({ mode: "srs" });
      const solved = onTheWire(await activity.trainingTry("d2d4"));
      expect(solved).toMatchObject({ status: "solved", note: { san: "d4", text: longer } });
    });

    it("moves on with the item: the next card shows none while it is open", async () => {
      await addCoachCard(WHY);
      addCard("d2d4");
      const { activity } = setup();
      const served = training(await activity.startTraining({ mode: "srs" }));
      expect(training(await activity.trainingTry("d2d4")).note).toMatchObject({ text: WHY });
      await activity.rateCard(exposureOf(served), 4);
      const next = training(await activity.nextTrainingItem());
      expect(next.item).toMatchObject({ kind: "card", position_in_queue: 2 });
      expect(next.note).toBeNull();
    });

    describe("of a card reviewed through its puzzle's line", () => {
      // The puzzle's own text is what the miss stores with the card.
      const LINE_WHY = "why";

      async function startLineCard(): Promise<ActivityService> {
        addPuzzle(LICHESS, "fork", LICHESS_FORK, LICHESS_FORK_LINE);
        const { activity } = setup();
        await missPuzzle(activity, LICHESS);
        const served = onTheWire(await activity.startTraining({ mode: "srs" }));
        expect(served).toMatchObject({ fen: LICHESS_FORK, note: null });
        return activity;
      }

      it("stays out at every step of the line, a hint at a later step included", async () => {
        const activity = await startLineCard();
        const first = onTheWire(await activity.trainingTry("f8d6"));
        expect(first).toMatchObject({ status: "in_progress", note: null });
        expect(onTheWire(await activity.trainingHint()).note).toBeNull();
        const second = onTheWire(await activity.trainingTry("f6e4"));
        expect(second).toMatchObject({ status: "in_progress", note: null });
      });

      it("comes at the last step, titled by the first move of the line", async () => {
        const activity = await startLineCard();
        await activity.trainingTry("f8d6");
        await activity.trainingTry("f6e4");
        const done = onTheWire(await activity.trainingTry("e4d6"));
        expect(done).toMatchObject({
          status: "solved",
          fen: LICHESS_FORK_SOLVED,
          note: { san: "Bxd6", text: LINE_WHY },
        });
      });

      it("comes when the solution is shown at a later step, still titled by the first move", async () => {
        const activity = await startLineCard();
        await activity.trainingTry("f8d6");
        const given = onTheWire(await activity.trainingShowSolution());
        expect(given).toMatchObject({
          status: "failed",
          fen: LICHESS_FORK_AFTER_FIRST_REPLY,
          expected: { uci: "f6e4", san: "Ne4+" },
          note: { san: "Bxd6", text: LINE_WHY },
        });
      });
    });
  });

  it("is what the Grading and Found notes entries of AGENTS.md say", () => {
    const agents = readFileSync(join(import.meta.dirname, "../../../../AGENTS.md"), "utf8");
    const entryOf = (name: string): string =>
      (
        new RegExp(`- \\*\\*${name}:\\*\\*[\\s\\S]*?(?=\\n- \\*\\*)`).exec(agents)?.[0] ?? ""
      ).replace(/\s+/g, " ");
    const grading = entryOf("Grading");
    for (const said of [
      "`origin`",
      "`Missed puzzle`",
      "`From your game`",
      "`Coach card`",
      "in the tag beside the item's title",
      "The title stays `Card 3 of 20`",
      "the line pinned over the conversation does not repeat the origin",
      "`srs_cards.explanation`",
      "null while the card is open, a hint included",
      "`FILLER_PUZZLE_EXPLANATION`",
      "the import's sentences that describe a motif are shown",
    ]) {
      expect(grading).toContain(said);
    }
    expect(entryOf("Found notes")).toContain("a review card carries its own explanation");
  });
});

describe("a retry of an ended puzzle", () => {
  const countOf = (sql: string, ...params: (string | number)[]): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;
  const attemptsOf = (id: string): number =>
    countOf("SELECT COUNT(*) AS n FROM puzzle_attempts WHERE puzzle_id = ?", id);
  const storedRating = (): unknown =>
    db.prepare("SELECT value FROM settings WHERE key = 'puzzle_rating'").get();
  const cards = (): unknown[] => db.prepare("SELECT * FROM srs_cards ORDER BY id").all();
  // The run's row as its last step left it, without the served item, which a retry replaces.
  const tallyOfRun = (): unknown =>
    db
      .prepare(
        `SELECT size, items_json, position, solved, failed, outcomes_json
         FROM training_runs ORDER BY id DESC LIMIT 1`,
      )
      .get();
  // What the run's row says of the item on the board, written with every step.
  const storedCurrent = (): { item_id: number; status: string; coach_ask: string } =>
    JSON.parse(
      (
        db.prepare("SELECT current_json FROM training_runs ORDER BY id DESC LIMIT 1").get() as {
          current_json: string;
        }
      ).current_json,
    );
  // Each serve of the puzzle as the ledger keeps it, with the tries graded under it.
  const servesOf = (id: string): unknown[] =>
    db
      .prepare(
        `SELECT i.served_at, i.answered_at, i.answer_uci, i.correct, i.hinted,
           (SELECT COUNT(*) FROM training_tries t WHERE t.item_id = i.id) AS tries
         FROM training_items i WHERE i.puzzle_id = ? ORDER BY i.id`,
      )
      .all(id);

  // How a second play can end: each is a miss or a win on a first play, and nothing on a retry.
  const ENDINGS = ["solved", "solved after a wrong try", "solved with a hint", "given up"] as const;
  type Ending = (typeof ENDINGS)[number];

  async function playBackRank(
    activity: ActivityService,
    ending: Ending,
  ): Promise<TrainingActivity> {
    if (ending === "given up") return training(await activity.trainingShowSolution());
    if (ending === "solved after a wrong try") await activity.trainingTry("a1a2");
    if (ending === "solved with a hint") await activity.trainingHint();
    return training(await activity.trainingTry("a1a8"));
  }

  it.each(["solved", "failed"] as const)(
    "serves a %s puzzle again at its place in the queue, from its first move",
    async (status) => {
      addPuzzle("f1", "fork", FORK, FORK_LINE);
      const clock = steppingClock();
      const log = new RecordingLog();
      const { activity } = setup(clock, log);
      const start = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
      await activity.trainingTry("f4e5");
      await activity.trainingTry("b5c7");
      clock.advance(40);
      const ended = training(
        status === "solved"
          ? await activity.trainingTry("a1c1")
          : await activity.trainingShowSolution(),
      );
      expect(ended).toMatchObject({ status, tries: 1 });
      expect(ended).not.toHaveProperty("retry");
      clock.advance(5);

      const again = training(await activity.retryTrainingItem(start.activity_id));
      expect(TrainingActivitySchema.parse(again)).toEqual(again);
      expect(again).toMatchObject({
        activity_id: start.activity_id,
        status: "prompt",
        retry: true,
        fen: FORK,
        input_enabled: true,
        tries: 0,
        last_try: null,
        moves: [],
        wrong_tries: [],
        exploring: { fen: FORK, line_san: [], trail: [] },
        gave_up: false,
        expected: null,
        solution_line: null,
        hint_square: null,
        summary: null,
        served_at: new Date(T0.getTime() + 45_000).toISOString(),
      });
      expect(again.item).toEqual(start.item);
      expect(again.served_at).not.toBe(ended.served_at);
      expect(again.legal_moves).toEqual(start.legal_moves);
      expect(log.named("training.item_served").map((entry) => entry.fields.item)).toEqual([
        start.item,
        start.item,
      ]);
    },
  );

  it("grades the second play on the board and keeps it in the ledger as an item of its own", async () => {
    addPuzzle("f1", "fork", FORK, FORK_LINE);
    const clock = steppingClock();
    const log = new RecordingLog();
    const { activity } = setup(clock, log);
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("b5c7");
    await activity.trainingTry("a1c1");
    clock.advance(30);
    await activity.retryTrainingItem();
    clock.advance(4);
    const wrong = training(await activity.trainingTry("f4e5"));
    expect(wrong).toMatchObject({
      status: "prompt",
      tries: 1,
      last_try: { uci: "f4e5", correct: false },
      wrong_tries: [{ ply: 0, uci: "f4e5", san: "Be5" }],
    });
    const hinted = training(await activity.trainingHint());
    expect(hinted.hint_square).toBe("b5");
    const mid = training(await activity.trainingTry("b5c7"));
    expect(mid).toMatchObject({ status: "in_progress", fen: FORK_PUZZLE_AFTER_REPLY_FEN });
    clock.advance(6);
    const solved = training(await activity.trainingTry("a1c1"));
    expect(solved).toMatchObject({ status: "solved", fen: FORK_PUZZLE_SOLVED_FEN, retry: true });
    expect((solved.moves ?? []).map((move) => move.uci)).toEqual(FORK_LINE);

    expect(servesOf("f1")).toEqual([
      {
        served_at: T0.toISOString(),
        answered_at: T0.toISOString(),
        answer_uci: "a1c1",
        correct: 1,
        hinted: 0,
        tries: 2,
      },
      {
        served_at: new Date(T0.getTime() + 30_000).toISOString(),
        answered_at: new Date(T0.getTime() + 40_000).toISOString(),
        answer_uci: "a1c1",
        correct: 0,
        hinted: 1,
        tries: 3,
      },
    ]);
    expect(log.named("training.answer").map((entry) => entry.fields.uci)).toEqual([
      "b5c7",
      "a1c1",
      "f4e5",
      "b5c7",
      "a1c1",
    ]);
    const lastServe = db.prepare("SELECT MAX(id) AS id FROM training_items").get() as {
      id: number;
    };
    expect(storedCurrent()).toMatchObject({ item_id: lastServe.id, status: "solved" });

    const shown = setup(clock);
    await shown.activity.startTraining({ mode: "puzzles", motif: "fork" });
    await shown.activity.trainingTry("b5c7");
    await shown.activity.trainingTry("a1c1");
    await shown.activity.retryTrainingItem();
    await shown.activity.trainingTry("b5c7");
    const given = training(await shown.activity.trainingShowSolution());
    expect(given).toMatchObject({
      status: "failed",
      gave_up: true,
      retry: true,
      fen: FORK_PUZZLE_AFTER_REPLY_FEN,
      expected: { uci: "a1c1", san: "Rc1" },
      solution_line: ["a1c1"],
    });
  });

  it("can be asked again of a retry that ended, and moves on to the next item as before", async () => {
    addPuzzle("b1", "fork", BACK_RANK, ["a1a8"]);
    addPuzzle("b2", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    const start = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(training(await activity.trainingTry("a1a8")).coach_comment).toBe("offered");
    await activity.retryTrainingItem();
    await activity.trainingShowSolution();
    const third = training(await activity.retryTrainingItem());
    expect(third).toMatchObject({ status: "prompt", retry: true, tries: 0 });
    expect(third.item).toEqual(start.item);
    // The play the offer is about is still the first one, not the retry before this one.
    expect(training(await activity.trainingTry("a1a8")).coach_comment).toBe("offered");
    const next = training(await activity.nextTrainingItem());
    expect(next).toMatchObject({ status: "prompt", item: { position_in_queue: 2 } });
    expect(next).not.toHaveProperty("retry");
    expect(next.queue_outcomes).toEqual(["solved", "current"]);
    expect(servesOf(start.item.kind === "puzzle" ? start.item.puzzle_id : "")).toHaveLength(3);
  });

  it("refuses an open item, a card and an ended queue, and leaves the board as it was", async () => {
    addPuzzle("f1", "fork", FORK, FORK_LINE);
    addCard("d2d4");
    const { activity } = setup();
    expect(await code(activity.retryTrainingItem())).toBe("not_in_training");

    const start = training(await activity.startTraining({ mode: "puzzles", motif: "fork" }));
    expect(await code(activity.retryTrainingItem(start.activity_id))).toBe("invalid_state");
    await activity.trainingTry("b5c7");
    expect(await code(activity.retryTrainingItem(start.activity_id))).toBe("invalid_state");
    const solved = training(await activity.trainingTry("a1c1"));
    expect(await code(activity.retryTrainingItem(start.activity_id + 1))).toBe("stale_activity");
    expect(activity.current()).toEqual(solved);
    expect(servesOf("f1")).toHaveLength(1);
    const ended = training(await activity.nextTrainingItem());
    expect(ended.summary).toEqual({ solved: 1, failed: 0 });
    expect(await code(activity.retryTrainingItem())).toBe("item_finished");
    expect(activity.current()).toEqual(ended);
    expect(servesOf("f1")).toHaveLength(1);
    await activity.endTraining();

    const card = training(await activity.startTraining({ mode: "srs" }));
    expect(await code(activity.retryTrainingItem())).toBe("invalid_state");
    const answered = training(await activity.trainingTry("d2d4"));
    expect(await code(activity.retryTrainingItem())).toBe("invalid_state");
    expect(activity.current()).toEqual(answered);
    await activity.rateCard((card.item as { exposure_id: string }).exposure_id, 3);
    expect(await code(activity.retryTrainingItem())).toBe("invalid_state");
    expect(countOf("SELECT COUNT(*) AS n FROM training_items WHERE kind = 'card'")).toBe(1);
  });

  it.each(ENDINGS)("writes no attempt row when the retry is %s", async (ending) => {
    addPuzzle("r1", "fork", BACK_RANK, ["a1a8"], 1400);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("a1a8");
    expect(attemptsOf("r1")).toBe(1);
    const attempt = db.prepare("SELECT * FROM puzzle_attempts").all();
    await activity.retryTrainingItem();
    expect(attemptsOf("r1")).toBe(1);
    const ended = await playBackRank(activity, ending);
    expect(ended.status).toBe(ending === "given up" ? "failed" : "solved");
    expect(attemptsOf("r1")).toBe(1);
    expect(db.prepare("SELECT * FROM puzzle_attempts").all()).toEqual(attempt);
  });

  it.each(ENDINGS)("leaves the puzzle rating alone when the retry is %s", async (ending) => {
    addPuzzle("r1", "fork", BACK_RANK, ["a1a8"], 1400);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const first = training(await activity.trainingTry("a1a8"));
    expect(first).toMatchObject({ student_rating: 1224, rating_change: 24 });
    const stored = storedRating();
    expect(stored).toEqual({ value: "1224" });

    const again = training(await activity.retryTrainingItem());
    expect(again).toMatchObject({ student_rating: 1224, rating_change: null });
    const ended = await playBackRank(activity, ending);
    expect(ended).toMatchObject({ student_rating: 1224, rating_change: null });
    expect(ended.item).toMatchObject({ rating: 1400 });
    expect(storedRating()).toEqual(stored);
    expect(currentPuzzleRating(db)).toBe(1224);
  });

  it("does not win back the rating a missed first play lost", async () => {
    addPuzzle("r1", "fork", BACK_RANK, ["a1a8"], 1200);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const missed = training(await activity.trainingShowSolution());
    expect(missed).toMatchObject({ student_rating: 1184, rating_change: -16 });
    await activity.retryTrainingItem();
    const solved = training(await activity.trainingTry("a1a8"));
    expect(solved).toMatchObject({ status: "solved", student_rating: 1184, rating_change: null });
    expect(storedRating()).toEqual({ value: "1184" });
  });

  it.each(ENDINGS.filter((ending) => ending !== "solved"))(
    "makes no review card of a puzzle solved first try when the retry is %s",
    async (ending) => {
      addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
      const { activity } = setup();
      await activity.startTraining({ mode: "puzzles", motif: "fork" });
      await activity.trainingTry("a1a8");
      await activity.retryTrainingItem();
      await playBackRank(activity, ending);
      expect(cards()).toEqual([]);
    },
  );

  it.each(ENDINGS)(
    "leaves the card a missed first play made as it was when the retry is %s",
    async (ending) => {
      addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
      const clock = steppingClock();
      const { activity } = setup(clock);
      await activity.startTraining({ mode: "puzzles", motif: "fork" });
      await activity.trainingTry("a1a2");
      await activity.trainingTry("a1a8");
      const made = cards();
      expect(made).toMatchObject([
        { puzzle_id: "f1", played_uci: "a1a2", next_review_at: T0.toISOString() },
      ]);
      clock.advance(3600);
      await activity.retryTrainingItem();
      await playBackRank(activity, ending);
      expect(cards()).toEqual(made);
      expect(countOf("SELECT COUNT(*) AS n FROM srs_reviews")).toBe(0);
    },
  );

  it("keeps the first play's outcome in the run when a solved puzzle is retried and given up", async () => {
    addPuzzle("b1", "fork", BACK_RANK, ["a1a8"]);
    addPuzzle("b2", "fork", BACK_RANK, ["a1a8"]);
    const { activity, rows } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const solved = training(await activity.trainingTry("a1a8"));
    expect(solved.queue_outcomes).toEqual(["solved", "pending"]);
    const tally = tallyOfRun();
    expect(tally).toMatchObject({ size: 2, position: 0, solved: 1, failed: 0 });
    expect(tally).toMatchObject({ outcomes_json: JSON.stringify(["solved"]) });

    const again = training(await activity.retryTrainingItem());
    expect(again.queue_outcomes).toEqual(["solved", "pending"]);
    expect(again.item).toMatchObject({ position_in_queue: 1, queue_length: 2 });
    const given = training(await activity.trainingShowSolution());
    expect(given).toMatchObject({ status: "failed", queue_outcomes: ["solved", "pending"] });
    expect(tallyOfRun()).toEqual(tally);

    await activity.nextTrainingItem();
    await activity.trainingShowSolution();
    const ended = training(await activity.nextTrainingItem());
    expect(ended.summary).toEqual({ solved: 1, failed: 1 });
    expect(ended.queue_outcomes).toEqual(["solved", "failed"]);
    expect(rows().filter((row) => row.type === "training_summary")).toEqual([
      { type: "training_summary", mode: "puzzles", solved: 1, failed: 1 },
    ]);
  });

  it("keeps a missed first play missed in the run when the retry is solved", async () => {
    addPuzzle("b1", "fork", BACK_RANK, ["a1a8"]);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingShowSolution();
    const tally = tallyOfRun();
    expect(tally).toMatchObject({
      solved: 0,
      failed: 1,
      outcomes_json: JSON.stringify(["failed"]),
    });
    await activity.retryTrainingItem();
    const solved = training(await activity.trainingTry("a1a8"));
    expect(solved).toMatchObject({ status: "solved", queue_outcomes: ["failed"] });
    expect(tallyOfRun()).toEqual(tally);
    expect(training(await activity.nextTrainingItem()).summary).toEqual({ solved: 0, failed: 1 });
  });

  it.each(ENDINGS)(
    "tells the coach nothing when the retry of a missed puzzle is %s",
    async (ending) => {
      addPuzzle("f1", "fork", BACK_RANK, ["a1a8"]);
      const { activity, flushed, rows } = setup();
      await activity.startTraining({ mode: "puzzles", motif: "fork" });
      await activity.trainingTry("a1a2");
      const missed = training(await activity.trainingTry("a1a8"));
      expect(missed.coach_comment).toBeNull();
      const told = rows();
      expect(told).toMatchObject([{ type: "puzzle_result", first_try: false }]);
      expect(flushed).toHaveBeenCalledTimes(1);

      const again = training(await activity.retryTrainingItem());
      expect(again.coach_comment).toBeNull();
      const ended = await playBackRank(activity, ending);
      expect(ended.coach_comment).toBeNull();
      expect(rows()).toEqual(told);
      expect(flushed).toHaveBeenCalledTimes(1);
      expect(await code(activity.trainingAskCoach())).toBe("not_in_training");
      expect(rows()).toEqual(told);
    },
  );

  it.each(ENDINGS)(
    "leaves the comment a first-try solve left on offer when the retry is %s",
    async (ending) => {
      addPuzzle("b1", "pin", BACK_RANK, ["a1a8"]);
      const { activity, flushed, notes } = setup();
      await activity.startTraining({ mode: "puzzles", motif: "pin" });
      const solved = training(await activity.trainingTry("a1a8"));
      expect(solved.coach_comment).toBe("offered");

      const again = training(await activity.retryTrainingItem());
      expect(again.coach_comment).toBeNull();
      expect(await code(activity.trainingAskCoach())).toBe("not_in_training");
      const ended = await playBackRank(activity, ending);
      expect(ended.coach_comment).toBe("offered");
      expect(storedCurrent().coach_ask).toBe("offered");
      expect(notes()).toEqual([]);
      expect(flushed).not.toHaveBeenCalled();

      const asked = training(await activity.trainingAskCoach());
      expect(asked).toMatchObject({ coach_comment: "requested", status: ended.status });
      expect(storedCurrent().coach_ask).toBe("requested");
      expect(notes()).toHaveLength(1);
      expect(notes()[0]).toMatchObject({
        type: "puzzle_result",
        puzzle_id: "b1",
        requested: true,
        solved: true,
        first_try: true,
        tries: 0,
        gave_up: false,
        answered_uci: ["a1a8"],
        solution_san: ["Ra8#"],
        reasoning: { tries: [{ uci: "a1a8", correct: true }], gave_up: false, hint_at_ms: null },
      });
      expect(flushed).toHaveBeenCalledTimes(1);
      expect(await code(activity.trainingAskCoach())).toBe("already_requested");
    },
  );

  it("keeps a comment already asked for as asked through a retry, and writes nothing more", async () => {
    addPuzzle("b1", "fork", BACK_RANK, ["a1a8"]);
    const { activity, flushed, notes } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    await activity.trainingTry("a1a8");
    const asked = training(await activity.trainingAskCoach());
    expect(asked.coach_comment).toBe("requested");
    const told = notes();
    expect(told).toHaveLength(1);

    expect(training(await activity.retryTrainingItem()).coach_comment).toBeNull();
    const given = training(await activity.trainingShowSolution());
    expect(given.coach_comment).toBe("requested");
    expect(await code(activity.trainingAskCoach())).toBe("already_requested");
    expect(notes()).toEqual(told);
    expect(flushed).toHaveBeenCalledTimes(1);
  });

  it("leaves 1 solved, 1 attempt row and the first solve's rating after a second solve", async () => {
    addPuzzle("r1", "fork", BACK_RANK, ["a1a8"], 1400);
    const { activity } = setup();
    await activity.startTraining({ mode: "puzzles", motif: "fork" });
    const first = training(await activity.trainingTry("a1a8"));
    expect(first).toMatchObject({ status: "solved", student_rating: 1224, rating_change: 24 });
    await activity.retryTrainingItem();
    const second = training(await activity.trainingTry("a1a8"));
    expect(second).toMatchObject({
      status: "solved",
      retry: true,
      student_rating: 1224,
      rating_change: null,
      queue_outcomes: ["solved"],
    });
    expect(tallyOfRun()).toMatchObject({ solved: 1, failed: 0 });
    expect(attemptsOf("r1")).toBe(1);
    expect(storedRating()).toEqual({ value: "1224" });
    expect(cards()).toEqual([]);
    expect(training(await activity.nextTrainingItem()).summary).toEqual({ solved: 1, failed: 0 });
  });

  it("serves a single puzzle the coach picked again, with nothing kept but the ledger", async () => {
    addPuzzle("f1", "fork", BACK_RANK, ["a1a8"], 1400);
    const { activity } = setup();
    await activity.startTrainingItem({ kind: "puzzle", id: "f1" });
    await activity.trainingTry("a1a8");
    const again = training(await activity.retryTrainingItem());
    expect(again).toMatchObject({ status: "prompt", retry: true, student_rating: 1224 });
    const given = training(await activity.trainingShowSolution());
    expect(given).toMatchObject({ status: "failed", student_rating: 1224, rating_change: null });
    expect(attemptsOf("f1")).toBe(1);
    expect(cards()).toEqual([]);
    expect(servesOf("f1")).toHaveLength(2);
  });

  it("is what the Retry entry of AGENTS.md says", () => {
    const agents = readFileSync(join(import.meta.dirname, "../../../../AGENTS.md"), "utf8");
    const entry = (/- \*\*Retry:\*\*[\s\S]*?(?=\n- \*\*)/.exec(agents)?.[0] ?? "").replace(
      /\s+/g,
      " ",
    );
    for (const said of [
      "`retry_item {activity_id}`",
      "writes no `puzzle_attempts` row",
      "`item_finished`",
      "`invalid_state`",
      "`retry: true`",
      "`training_items`",
      "`queue_outcomes`",
      "`found_cards`",
      "`coach_comment`",
    ]) {
      expect(entry).toContain(said);
    }
  });
});
