import type {
  CoachProgress,
  ProgressGame,
  ProgressResponse,
  RatingPoint,
} from "@chess-coach/shared";
import type { Clock } from "../clock.js";
import type { Database } from "../db/open.js";
import { getCurrentElo, lastDifficultyChange } from "../db/settings.js";

const GAME_LIST_LIMIT = 50;
const CLEAN_CP_LOSS = 30;
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const MONTH_MS = 30 * 24 * HOUR_MS;

type TimeClass = RatingPoint["time_class"];

// Chess.com buckets by estimated duration (base + 40 * increment): "600+5" is rapid, "1/86400" daily.
export function timeClassOf(timeControl: string | null): TimeClass {
  if (!timeControl) return null;
  if (timeControl.includes("/")) return "daily";
  const [base, increment] = timeControl.split("+").map(Number);
  if (base === undefined || Number.isNaN(base)) return null;
  const estimated = base + 40 * (increment ?? 0);
  if (estimated < 180) return "bullet";
  if (estimated < 600) return "blitz";
  return "rapid";
}

function ratingHistory(db: Database): RatingPoint[] {
  const rows = db
    .prepare(
      `SELECT played_at, student_rating AS rating, time_control FROM games
       WHERE source = 'chesscom' AND student_rating IS NOT NULL AND played_at IS NOT NULL
       ORDER BY played_at ASC, id ASC`,
    )
    .all() as { played_at: string; rating: number; time_control: string | null }[];
  return rows.map((row) => ({
    played_at: row.played_at,
    rating: row.rating,
    time_class: timeClassOf(row.time_control),
  }));
}

function recentGames(db: Database): ProgressGame[] {
  const rows = db
    .prepare(
      `SELECT g.id, COALESCE(g.played_at, g.started_at) AS played_at, g.source, g.result,
         COUNT(m.cp_loss) AS graded,
         COALESCE(SUM(m.cp_loss <= ?), 0) AS clean,
         COALESCE(SUM(m.classification = 'blunder'), 0) AS blunders,
         COALESCE(SUM(m.classification = 'mistake'), 0) AS mistakes
       FROM games g LEFT JOIN moves m ON m.game_id = g.id AND m.is_player = 1
       WHERE g.finished_at IS NOT NULL
       GROUP BY g.id
       ORDER BY played_at DESC, g.id DESC LIMIT ?`,
    )
    .all(CLEAN_CP_LOSS, GAME_LIST_LIMIT) as (Omit<ProgressGame, "accuracy"> & {
    graded: number;
    clean: number;
  })[];
  return rows.map(({ graded, clean, ...game }) => ({
    ...game,
    accuracy: graded === 0 ? null : clean / graded,
  }));
}

function puzzlesByMotif(db: Database, now: Date): ProgressResponse["puzzles_by_motif"] {
  const from = new Date(now.getTime() - MONTH_MS).toISOString();
  const to = now.toISOString();
  const rows = db
    .prepare(
      `SELECT p.motif, COUNT(*) AS attempts, SUM(a.solved) AS solved,
         COALESCE(SUM(a.attempted_at >= ? AND a.attempted_at <= ?), 0) AS attempts_30d,
         COALESCE(SUM(a.solved AND a.attempted_at >= ? AND a.attempted_at <= ?), 0) AS solved_30d
       FROM puzzle_attempts a JOIN puzzles p ON p.id = a.puzzle_id
       GROUP BY p.motif ORDER BY p.motif`,
    )
    .all(from, to, from, to) as {
    motif: string;
    attempts: number;
    solved: number;
    attempts_30d: number;
    solved_30d: number;
  }[];
  return rows.map((row) => ({
    ...row,
    success_rate: row.solved / row.attempts,
    success_rate_30d: row.attempts_30d === 0 ? null : row.solved_30d / row.attempts_30d,
  }));
}

function correctRate(
  db: Database,
  from: Date,
  to: Date,
): { reviewed: number; rate: number | null } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS reviewed, COALESCE(SUM(correct), 0) AS correct FROM srs_reviews
       WHERE reviewed_at >= ? AND reviewed_at <= ?`,
    )
    .get(from.toISOString(), to.toISOString()) as { reviewed: number; correct: number };
  return { reviewed: row.reviewed, rate: row.reviewed === 0 ? null : row.correct / row.reviewed };
}

function dueBreakdown(
  db: Database,
  now: Date,
): Pick<ProgressResponse["cards"], "due_by_classification" | "due_from_games"> {
  const rows = db
    .prepare(
      `SELECT COALESCE(classification, 'teaching') AS classification, COUNT(*) AS n
       FROM srs_cards WHERE next_review_at <= ? GROUP BY 1`,
    )
    .all(now.toISOString()) as { classification: string; n: number }[];
  const games = db
    .prepare(`SELECT COUNT(DISTINCT source_game_id) AS n FROM srs_cards WHERE next_review_at <= ?`)
    .get(now.toISOString()) as { n: number };
  return {
    due_by_classification: Object.fromEntries(rows.map((row) => [row.classification, row.n])),
    due_from_games: games.n,
  };
}

function nextDue(
  db: Database,
  now: Date,
): Pick<ProgressResponse["cards"], "next_due_at" | "next_due_count"> {
  const next = db
    .prepare("SELECT MIN(next_review_at) AS at FROM srs_cards WHERE next_review_at > ?")
    .get(now.toISOString()) as { at: string | null };
  if (next.at === null) return { next_due_at: null, next_due_count: 0 };
  const horizon = new Date(new Date(next.at).getTime() + HOUR_MS).toISOString();
  const batch = db
    .prepare("SELECT COUNT(*) AS n FROM srs_cards WHERE next_review_at > ? AND next_review_at <= ?")
    .get(now.toISOString(), horizon) as { n: number };
  return { next_due_at: next.at, next_due_count: batch.n };
}

function cardProgress(db: Database, now: Date): ProgressResponse["cards"] {
  const cards = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(next_review_at <= ?), 0) AS due_now FROM srs_cards`,
    )
    .get(now.toISOString()) as { total: number; due_now: number };
  const week = correctRate(db, new Date(now.getTime() - WEEK_MS), now);
  const month = correctRate(db, new Date(now.getTime() - MONTH_MS), now);
  return {
    ...cards,
    reviewed_7d: week.reviewed,
    correct_rate_7d: week.rate,
    ...dueBreakdown(db, now),
    ...nextDue(db, now),
    correct_rate_30d: month.rate,
  };
}

function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// A day without activity today breaks the streak outright: yesterday alone does not keep it alive.
function streakDays(db: Database, now: Date): number {
  const stamps = db
    .prepare(
      `SELECT started_at AS at FROM games
       UNION ALL SELECT attempted_at FROM puzzle_attempts
       UNION ALL SELECT reviewed_at FROM srs_reviews
       UNION ALL SELECT created_at FROM chat_messages WHERE role = 'user'`,
    )
    .all() as { at: string }[];
  const days = new Set(stamps.map((row) => localDay(new Date(row.at))));
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  let streak = 0;
  while (days.has(localDay(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function computeProgress(db: Database, clock: Clock): ProgressResponse {
  const now = clock.now();
  return {
    rating_history: ratingHistory(db),
    games: recentGames(db),
    puzzles_by_motif: puzzlesByMotif(db, now),
    cards: cardProgress(db, now),
    streak_days: streakDays(db, now),
    difficulty: { current_elo: getCurrentElo(db), last_change: lastDifficultyChange(db) },
  };
}

export function computeCoachProgress(db: Database, clock: Clock): CoachProgress {
  const { games, ...rest } = computeProgress(db, clock);
  const row = db.prepare("SELECT COUNT(*) AS n FROM games").get() as { n: number };
  return { ...rest, games_played: row.n };
}
