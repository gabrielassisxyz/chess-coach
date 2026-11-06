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

// Injected shuffle source, so tests stay deterministic while production shuffles.
export type PuzzleShuffleRandom = () => number;

export function clampLimit(limit: number | undefined, max: number = MAX_PUZZLE_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit)) return Math.min(DEFAULT_PUZZLE_LIMIT, max);
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

// Least-attempted groups stay in order; inside one group the id order is shuffled, so an
// Any-motif queue does not repeat the same fixed sequence. Fisher-Yates with the injected source.
function shufflePuzzlesWithinAttempts(
  ranked: PuzzleSummary[],
  randomSource: PuzzleShuffleRandom,
): PuzzleSummary[] {
  const out: PuzzleSummary[] = [];
  let start = 0;
  while (start < ranked.length) {
    let end = start + 1;
    while (end < ranked.length && ranked[end]?.attempts === ranked[start]?.attempts) end += 1;
    const group = ranked.slice(start, end);
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(randomSource() * (i + 1));
      const current = group[i] as PuzzleSummary;
      group[i] = group[j] as PuzzleSummary;
      group[j] = current;
    }
    out.push(...group);
    start = end;
  }
  return out;
}

// Fewest attempts first, so unseen puzzles lead, shuffled within equal counts; `total`
// is the whole matching inventory, not the page.
export function listPuzzles(
  db: Database,
  filter: PuzzleFilter = {},
  randomSource: PuzzleShuffleRandom = Math.random,
): PuzzleListing {
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
  const ranked = db
    .prepare(
      `SELECT p.id, p.motif, p.difficulty, p.fen, p.explanation,
              COUNT(a.id) AS attempts, COALESCE(SUM(a.solved), 0) AS solved
       FROM puzzles p LEFT JOIN puzzle_attempts a ON a.puzzle_id = p.id
       ${clause}
       GROUP BY p.id
       ORDER BY attempts ASC, p.id ASC`,
    )
    .all(...params) as PuzzleSummary[];
  const puzzles = shufflePuzzlesWithinAttempts(ranked, randomSource).slice(
    0,
    clampLimit(filter.limit),
  );
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

export interface PuzzleHeader {
  motif: string;
  difficulty: string;
  explanation: string;
}

export function getPuzzleHeader(db: Database, id: string): PuzzleHeader | null {
  const row = db.prepare("SELECT motif, difficulty, explanation FROM puzzles WHERE id = ?").get(id);
  return (row as PuzzleHeader | undefined) ?? null;
}

export interface AttemptRecord {
  puzzleId: string;
  attemptedAt: string;
  solved: boolean;
  answered: readonly string[];
  failedPly: number | null;
  /** Solved with no wrong try on any step. */
  firstTry: boolean;
  /** How many wrong tries the attempt took. */
  tries: number;
  gaveUp: boolean;
  /** A hint was used, so the item never counts as solved first try. */
  hinted?: boolean | undefined;
}

export function recordPuzzleAttempt(db: Database, attempt: AttemptRecord): void {
  db.prepare(
    `INSERT INTO puzzle_attempts
       (puzzle_id, attempted_at, solved, answered_uci, failed_ply, first_try, tries, gave_up, hinted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attempt.puzzleId,
    attempt.attemptedAt,
    attempt.solved ? 1 : 0,
    JSON.stringify(attempt.answered),
    attempt.failedPly,
    attempt.firstTry ? 1 : 0,
    attempt.tries,
    attempt.gaveUp ? 1 : 0,
    attempt.hinted ? 1 : 0,
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

export interface GeneratedPuzzle {
  id: string;
  source: string;
  motif: string;
  difficulty: string;
  fen: string;
  solutionUci: string[];
  solutionSan: string[];
  explanation: string;
}

export function getPuzzleExplanation(db: Database, id: string): string | null {
  const row = db.prepare("SELECT explanation FROM puzzles WHERE id = ?").get(id) as
    | { explanation: string }
    | undefined;
  return row?.explanation ?? null;
}

// False when the id already exists, so two overlapping generator runs cannot collide.
export function insertGeneratedPuzzle(db: Database, puzzle: GeneratedPuzzle): boolean {
  const info = db
    .prepare(
      `INSERT INTO puzzles (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      puzzle.id,
      puzzle.source,
      puzzle.motif,
      puzzle.difficulty,
      puzzle.fen,
      JSON.stringify(puzzle.solutionUci),
      JSON.stringify(puzzle.solutionSan),
      puzzle.explanation,
    );
  return info.changes === 1;
}

// The row keeps its id, so the attempts that point at it survive a refresh.
export function setPuzzleExplanation(db: Database, id: string, explanation: string): void {
  db.prepare("UPDATE puzzles SET explanation = ? WHERE id = ?").run(explanation, id);
}
