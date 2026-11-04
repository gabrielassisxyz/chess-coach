import type { Database } from "./open.js";

export const DEFAULT_PUZZLE_LIMIT = 10;
export const MAX_PUZZLE_LIMIT = 50;

export interface PuzzleSummary {
  id: string;
  motif: string;
  difficulty: string;
  fen: string;
  explanation: string;
  attempts: number;
  solved: number;
}

export interface PuzzleListing {
  total: number;
  puzzles: PuzzleSummary[];
}

export interface StoredPuzzle {
  id: string;
  fen: string;
  solution: string[];
}

export interface PuzzleFilter {
  motif?: string | undefined;
  difficulty?: string | undefined;
  limit?: number | undefined;
}

export function clampLimit(limit: number | undefined, max: number = MAX_PUZZLE_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit)) return Math.min(DEFAULT_PUZZLE_LIMIT, max);
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

// Fewest attempts first, so unseen puzzles lead; `total` is the whole matching inventory, not the page.
export function listPuzzles(db: Database, filter: PuzzleFilter = {}): PuzzleListing {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.motif !== undefined) {
    where.push("p.motif = ?");
    params.push(filter.motif);
  }
  if (filter.difficulty !== undefined) {
    where.push("p.difficulty = ?");
    params.push(filter.difficulty);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const puzzles = db
    .prepare(
      `SELECT p.id, p.motif, p.difficulty, p.fen, p.explanation,
              COUNT(a.id) AS attempts, COALESCE(SUM(a.solved), 0) AS solved
       FROM puzzles p LEFT JOIN puzzle_attempts a ON a.puzzle_id = p.id
       ${clause}
       GROUP BY p.id
       ORDER BY attempts ASC, p.id ASC
       LIMIT ?`,
    )
    .all(...params, clampLimit(filter.limit)) as PuzzleSummary[];
  const counted = db.prepare(`SELECT COUNT(*) AS n FROM puzzles p ${clause}`).get(...params) as {
    n: number;
  };
  return { total: counted.n, puzzles };
}

export function getPuzzle(db: Database, id: string): StoredPuzzle | null {
  const row = db.prepare("SELECT id, fen, solution_uci FROM puzzles WHERE id = ?").get(id) as
    | { id: string; fen: string; solution_uci: string }
    | undefined;
  if (!row) return null;
  return { id: row.id, fen: row.fen, solution: JSON.parse(row.solution_uci) as string[] };
}

export interface AttemptRecord {
  puzzleId: string;
  attemptedAt: string;
  solved: boolean;
  answered: readonly string[];
  failedPly: number | null;
}

export function recordPuzzleAttempt(db: Database, attempt: AttemptRecord): void {
  db.prepare(
    `INSERT INTO puzzle_attempts (puzzle_id, attempted_at, solved, answered_uci, failed_ply)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    attempt.puzzleId,
    attempt.attemptedAt,
    attempt.solved ? 1 : 0,
    JSON.stringify(attempt.answered),
    attempt.failedPly,
  );
}

export interface MotifCount {
  motif: string;
  count: number;
}

export function listMotifs(db: Database): MotifCount[] {
  return db
    .prepare("SELECT motif, COUNT(*) AS count FROM puzzles GROUP BY motif ORDER BY motif")
    .all() as MotifCount[];
}
