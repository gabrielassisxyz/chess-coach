import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../db/open.js";
import { computeCoachProgress, computeProgress, timeClassOf } from "./compute.js";

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-progress-"));
  db = openDatabase(tmp);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// Every fixture time is local noon of a June 2026 day, so the local-day streak cannot depend on TZ.
const at = (day: number, hour = 12): string => new Date(2026, 5, day, hour).toISOString();
const clockOn = (day: number) => ({ now: () => new Date(2026, 5, day, 12) });

function insertGame(opts: {
  source: "coach" | "chesscom";
  day: number;
  rating?: number;
  timeControl?: string;
  finished?: boolean;
}): number {
  const finished = opts.finished ?? true;
  const row = db
    .prepare(
      `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase, result,
         pgn, source, source_id, student_rating, time_control, played_at)
       VALUES (?, ?, 'white', 1200, 'fen', ?, ?, '', ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      at(opts.day),
      finished ? at(opts.day, 13) : null,
      finished ? "finished" : "player_turn",
      finished ? "1-0" : null,
      opts.source,
      opts.source === "chesscom" ? `uuid-${opts.day}` : null,
      opts.rating ?? null,
      opts.timeControl ?? null,
      opts.source === "chesscom" ? at(opts.day) : null,
    ) as { id: number };
  return row.id;
}

function insertMoves(gameId: number, student: [number, string][], opponentCpLoss?: number): void {
  const insert = db.prepare(
    `INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after, is_player, cp_loss, classification)
     VALUES (?, ?, 'e4', 'e2e4', 'a', 'b', ?, ?, ?)`,
  );
  student.forEach(([cpLoss, classification], index) => {
    insert.run(gameId, index * 2 + 1, 1, cpLoss, classification);
    if (opponentCpLoss !== undefined)
      insert.run(gameId, index * 2 + 2, 0, opponentCpLoss, "blunder");
  });
}

function insertAttempt(motif: string, puzzleId: string, solved: boolean, day: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
     VALUES (?, 'test', ?, 'easy', 'fen', 'e2e4', 'e4', 'x')`,
  ).run(puzzleId, motif);
  db.prepare(
    `INSERT INTO puzzle_attempts (puzzle_id, attempted_at, solved, answered_uci) VALUES (?, ?, ?, 'e2e4')`,
  ).run(puzzleId, at(day), solved ? 1 : 0);
}

function insertCard(nextReviewAt: string): number {
  const row = db
    .prepare(
      `INSERT INTO srs_cards (source_kind, prompt_fen, student_color, expected_uci, created_at, next_review_at)
       VALUES ('teaching', 'f', 'white', 'd2d4', 't', ?) RETURNING id`,
    )
    .get(nextReviewAt) as { id: number };
  return row.id;
}

function insertReview(cardId: number, day: number, correct: boolean): void {
  db.prepare(
    `INSERT INTO srs_reviews (card_id, reviewed_at, quality, answered_uci, correct) VALUES (?, ?, 4, 'd2d4', ?)`,
  ).run(cardId, at(day), correct ? 1 : 0);
}

function insertUserMessage(day: number, role: "user" | "assistant" = "user"): void {
  const session =
    (db.prepare("SELECT id FROM coach_sessions LIMIT 1").get() as { id: number } | undefined)?.id ??
    (
      db
        .prepare(
          "INSERT INTO coach_sessions (started_at, prompt_version) VALUES (?, 'v') RETURNING id",
        )
        .get(at(1)) as { id: number }
    ).id;
  const seq = (db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number }).n;
  db.prepare(
    `INSERT INTO chat_messages (coach_session_id, seq, role, kind, content_json, created_at)
     VALUES (?, ?, ?, 'text', '{}', ?)`,
  ).run(session, seq, role, at(day));
}

function seedFixture(): void {
  const a = insertGame({ source: "chesscom", day: 1, rating: 412, timeControl: "600" });
  const b = insertGame({ source: "chesscom", day: 3, rating: 425, timeControl: "180" });
  insertGame({ source: "chesscom", day: 5, rating: 419, timeControl: "60" });
  const coachOne = insertGame({ source: "coach", day: 8 });
  insertGame({ source: "coach", day: 9 });
  // Student plies only: the opponent's 999 cp loss must not reach accuracy or the blunder count.
  insertMoves(
    a,
    [
      [0, "best"],
      [20, "great"],
      [30, "great"],
      [100, "inaccuracy"],
    ],
    999,
  );
  insertMoves(b, [
    [10, "great"],
    [400, "blunder"],
    [200, "mistake"],
    [31, "good"],
  ]);
  insertMoves(coachOne, [
    [0, "best"],
    [0, "best"],
  ]);

  // fork: 5 attempts, 3 solved; pin: 3 attempts, 1 solved.
  [true, true, false, true, false].forEach((solved, i) => {
    insertAttempt("fork", `fork-${i}`, solved, i < 2 ? 10 : 9);
  });
  [true, false, false].forEach((solved, i) => {
    insertAttempt("pin", `pin-${i}`, solved, i === 0 ? 8 : 4);
  });

  const due1 = insertCard(at(9));
  const due2 = insertCard(at(10));
  insertCard(at(11));
  insertCard(at(20));
  insertCard(at(30));
  insertReview(due1, 9, true);
  insertReview(due2, 8, false);
  insertReview(due1, 1, true);
  insertUserMessage(10);
  db.exec("UPDATE settings SET value = '700' WHERE key = 'current_elo'");
  db.exec(`INSERT INTO difficulty_changes (changed_at, from_elo, to_elo, reason)
           VALUES ('${at(9)}', 600, 700, 'streak_up')`);
}

describe("computeProgress on a fixture database", () => {
  it("returns the six sections with hand-computed values", () => {
    seedFixture();
    const progress = computeProgress(db, clockOn(10));

    expect(progress.rating_history).toEqual([
      { played_at: at(1), rating: 412, time_class: "rapid" },
      { played_at: at(3), rating: 425, time_class: "blitz" },
      { played_at: at(5), rating: 419, time_class: "bullet" },
    ]);

    expect(progress.games.map((g) => [g.source, g.played_at])).toEqual([
      ["coach", at(9)],
      ["coach", at(8)],
      ["chesscom", at(5)],
      ["chesscom", at(3)],
      ["chesscom", at(1)],
    ]);
    const byDay = (day: number) => progress.games.find((g) => g.played_at === at(day));
    expect(byDay(9)).toMatchObject({ accuracy: null, blunders: 0, mistakes: 0 });
    expect(byDay(8)).toMatchObject({ accuracy: 1, blunders: 0, mistakes: 0 });
    expect(byDay(5)).toMatchObject({ accuracy: null, blunders: 0, mistakes: 0 });
    expect(byDay(3)).toMatchObject({ accuracy: 0.25, blunders: 1, mistakes: 1 });
    expect(byDay(1)).toMatchObject({ accuracy: 0.75, blunders: 0, mistakes: 0 });

    expect(progress.puzzles_by_motif).toEqual([
      { motif: "fork", attempts: 5, solved: 3, success_rate: 0.6 },
      { motif: "pin", attempts: 3, solved: 1, success_rate: 1 / 3 },
    ]);

    expect(progress.cards).toEqual({ total: 5, due_now: 2, reviewed_7d: 2, correct_rate_7d: 0.5 });
    expect(progress.streak_days).toBe(3);
    expect(progress.difficulty).toEqual({
      current_elo: 700,
      last_change: { to_elo: 700, reason: "streak_up", changed_at: at(9) },
    });
  });

  it("counts an unfinished game out of the list and leaves an empty database at zero", () => {
    insertGame({ source: "coach", day: 9, finished: false });
    const progress = computeProgress(db, clockOn(10));
    expect(progress.games).toEqual([]);
    expect(progress.cards).toEqual({ total: 0, due_now: 0, reviewed_7d: 0, correct_rate_7d: null });
    expect(progress.puzzles_by_motif).toEqual([]);
    expect(progress.difficulty).toEqual({ current_elo: 600, last_change: null });
  });

  it("caps the game list at fifty, newest first", () => {
    for (let i = 0; i < 55; i += 1) {
      db.prepare(
        `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase, pgn)
         VALUES (?, ?, 'white', 1200, 'f', 'finished', '')`,
      ).run(new Date(2026, 0, 1 + i).toISOString(), new Date(2026, 0, 1 + i).toISOString());
    }
    const { games } = computeProgress(db, clockOn(10));
    expect(games).toHaveLength(50);
    expect(games[0]?.played_at).toBe(new Date(2026, 0, 55).toISOString());
  });
});

describe("accuracy", () => {
  it("is null for a game with no graded plies and ignores ungraded ones", () => {
    const id = insertGame({ source: "coach", day: 9 });
    insertMoves(id, [[0, "best"]]);
    db.prepare(
      `INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after, is_player)
       VALUES (?, 9, 'e4', 'e2e4', 'a', 'b', 1)`,
    ).run(id);
    expect(computeProgress(db, clockOn(10)).games[0]?.accuracy).toBe(1);
    db.prepare("UPDATE moves SET cp_loss = NULL").run();
    expect(computeProgress(db, clockOn(10)).games[0]?.accuracy).toBeNull();
  });
});

describe("streak_days", () => {
  it("is 0 with no activity at all", () => {
    expect(computeProgress(db, clockOn(10)).streak_days).toBe(0);
  });

  it("is 0 when only yesterday had activity", () => {
    insertAttempt("fork", "f1", true, 9);
    insertAttempt("fork", "f2", true, 8);
    expect(computeProgress(db, clockOn(10)).streak_days).toBe(0);
  });

  it("counts back from today across every kind of activity and stops at a one-day gap", () => {
    insertAttempt("fork", "f1", true, 10);
    insertReview(insertCard(at(20)), 9, true);
    insertUserMessage(8);
    insertGame({ source: "coach", day: 7 });
    insertAttempt("fork", "f2", true, 5);
    expect(computeProgress(db, clockOn(10)).streak_days).toBe(4);
  });

  it("does not count the coach's own messages as the student's activity", () => {
    insertUserMessage(10, "assistant");
    expect(computeProgress(db, clockOn(10)).streak_days).toBe(0);
  });

  it("crosses a month boundary", () => {
    insertAttempt("fork", "f1", true, 1);
    db.prepare(
      "INSERT INTO puzzle_attempts (puzzle_id, attempted_at, solved, answered_uci) VALUES ('f1', ?, 1, 'x')",
    ).run(new Date(2026, 4, 31, 12).toISOString());
    expect(computeProgress(db, clockOn(1)).streak_days).toBe(2);
  });
});

describe("timeClassOf", () => {
  it("buckets by estimated duration and recognises daily", () => {
    expect(timeClassOf("60")).toBe("bullet");
    expect(timeClassOf("120+1")).toBe("bullet");
    expect(timeClassOf("180")).toBe("blitz");
    expect(timeClassOf("300+5")).toBe("blitz");
    expect(timeClassOf("600")).toBe("rapid");
    expect(timeClassOf("1/86400")).toBe("daily");
    expect(timeClassOf(null)).toBeNull();
  });
});

describe("computeCoachProgress", () => {
  it("drops the game list and adds the count of every stored game", () => {
    seedFixture();
    insertGame({ source: "coach", day: 9, finished: false });
    const coach = computeCoachProgress(db, clockOn(10));
    expect(coach).not.toHaveProperty("games");
    expect(coach.games_played).toBe(6);
    expect(coach.streak_days).toBe(3);
  });
});
