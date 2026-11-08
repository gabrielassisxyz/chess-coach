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
  // The library's difficulty rating; null for a puzzle generated without one (opening drills).
  rating: number | null;
}

export interface PuzzleFilter {
  motif?: string | undefined;
  difficulty?: string | undefined;
  theme?: string | undefined;
  limit?: number | undefined;
  ratingAround?: undefined;
}

// Sampling cannot honour a motif or a difficulty, because neither is in the index it seeks on.
export interface RatingSampleFilter {
  ratingAround: number;
  theme?: string | undefined;
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

// Must read exactly as in the partial index `puzzles_library`, or SQLite cannot use it.
const LIBRARY_ONLY = "p.source <> 'lichess-db'";
const RATING_STEP = 200;
const SEEKS_PER_PUZZLE = 4;
const DIRECT_READ_ROWS = 200;
const LICHESS_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LICHESS_ID_SPACE = LICHESS_ID_ALPHABET.length ** 5;

const POPULAR_ENOUGH = "(p.popularity IS NULL OR p.popularity >= 50)";
const NOT_OPENING_MATERIAL = `p.motif NOT LIKE 'opening-%'
  AND p.motif NOT IN ('opening', 'opening_trap')
  AND (p.themes IS NULL OR ' ' || p.themes || ' ' NOT LIKE '% opening %')`;
const NEVER_ATTEMPTED = "NOT EXISTS (SELECT 1 FROM puzzle_attempts a WHERE a.puzzle_id = p.id)";
const SUMMARY_COLUMNS = "p.id, p.motif, p.difficulty, p.fen, p.explanation";

// What a sampled queue reads from: the index it seeks on, and who in it may be served.
interface SampleSource {
  table: string;
  ratingColumn: string;
  idColumn: string;
  scope: string;
  eligible: string;
  params: Record<string, string>;
}

function sampleSourceFor(theme: string | undefined): SampleSource {
  if (theme === undefined) {
    return {
      table: "puzzles",
      ratingColumn: "difficulty_rating",
      idColumn: "id",
      scope: "s.difficulty_rating IS NOT NULL",
      eligible: `${POPULAR_ENOUGH} AND ${NOT_OPENING_MATERIAL}`,
      params: {},
    };
  }
  return {
    table: "puzzle_themes",
    ratingColumn: "rating",
    idColumn: "puzzle_id",
    scope: "s.theme = @theme",
    eligible: POPULAR_ENOUGH,
    params: { theme },
  };
}

interface RatingWindow {
  low: number;
  high: number;
}

// Two subqueries, because one MIN with one MAX in a single SELECT scans the whole index.
function ratedRange(db: Database, source: SampleSource): RatingWindow | null {
  const { table, ratingColumn, scope, params } = source;
  const row = db
    .prepare(
      `SELECT (SELECT MIN(s.${ratingColumn}) FROM ${table} s WHERE ${scope}) AS low,
              (SELECT MAX(s.${ratingColumn}) FROM ${table} s WHERE ${scope}) AS high`,
    )
    .get(params) as { low: number | null; high: number | null };
  return row.low === null || row.high === null ? null : { low: row.low, high: row.high };
}

function randomLichessId(randomSource: PuzzleShuffleRandom): string {
  let rest = Math.floor(randomSource() * LICHESS_ID_SPACE);
  let id = "";
  for (let i = 0; i < 5; i++) {
    id = (LICHESS_ID_ALPHABET[rest % LICHESS_ID_ALPHABET.length] as string) + id;
    rest = Math.floor(rest / LICHESS_ID_ALPHABET.length);
  }
  return id;
}

/**
 * One pick is a rating drawn from the window and an id drawn from the id space, and the seek stays
 * on that exact rating. Walking on to the next rating, or past rows that may not be served, would
 * hand a puzzle the draws of every empty key before it. A draw that lands on nothing, or on a row
 * that may not be served, is a miss and is thrown away.
 */
function seekUnattempted(
  db: Database,
  source: SampleSource,
  window: RatingWindow,
  picked: Map<string, PuzzleSummary>,
  limit: number,
  randomSource: PuzzleShuffleRandom,
): void {
  const { table, ratingColumn, idColumn, scope, eligible, params } = source;
  const seek = db.prepare(
    `SELECT s.${idColumn} AS id FROM ${table} s
     WHERE ${scope} AND s.${ratingColumn} = @rating AND s.${idColumn} >= @from
     ORDER BY s.${idColumn} LIMIT 1`,
  );
  const candidate = db.prepare(
    `SELECT ${SUMMARY_COLUMNS}, 0 AS attempts, 0 AS solved FROM puzzles p
     WHERE p.id = @id AND ${eligible} AND ${NEVER_ATTEMPTED}`,
  );
  const span = window.high - window.low + 1;
  for (let seeks = (limit - picked.size) * SEEKS_PER_PUZZLE; seeks > 0; seeks--) {
    if (picked.size >= limit) return;
    const rating = window.low + Math.floor(randomSource() * span);
    const from = randomLichessId(randomSource);
    const hit = seek.get({ ...params, rating, from }) as { id: string } | undefined;
    if (!hit || picked.has(hit.id)) continue;
    const summary = candidate.get({ id: hit.id }) as PuzzleSummary | undefined;
    if (summary) picked.set(summary.id, summary);
  }
}

// The direct reads are bounded rather than complete: the seek only misses this often when a window
// is sparse, so 200 rows is all of it, and a window that does hold more loses only its upper part.
function readUnattempted(
  db: Database,
  source: SampleSource,
  window: RatingWindow,
): PuzzleSummary[] {
  const { table, ratingColumn, idColumn, scope, eligible, params } = source;
  return db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS}, 0 AS attempts, 0 AS solved
       FROM ${table} s CROSS JOIN puzzles p ON p.id = s.${idColumn}
       WHERE ${scope} AND s.${ratingColumn} BETWEEN @low AND @high
         AND ${eligible} AND ${NEVER_ATTEMPTED}
       LIMIT ${DIRECT_READ_ROWS}`,
    )
    .all({ ...params, ...window }) as PuzzleSummary[];
}

// Driven from the attempts, so the cost follows the student's history and not the window's size.
function readAttempted(db: Database, source: SampleSource, window: RatingWindow): PuzzleSummary[] {
  const { table, ratingColumn, idColumn, scope, eligible, params } = source;
  return db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS}, COUNT(a.id) AS attempts, COALESCE(SUM(a.solved), 0) AS solved
       FROM puzzle_attempts a CROSS JOIN puzzles p ON p.id = a.puzzle_id
       WHERE p.difficulty_rating BETWEEN @low AND @high AND ${eligible}
         AND EXISTS (SELECT 1 FROM ${table} s
                     WHERE ${scope} AND s.${ratingColumn} = p.difficulty_rating AND s.${idColumn} = p.id)
       GROUP BY p.id
       ORDER BY attempts ASC, p.id ASC
       LIMIT ${DIRECT_READ_ROWS}`,
    )
    .all({ ...params, ...window }) as PuzzleSummary[];
}

function takeUntilFull(
  picked: Map<string, PuzzleSummary>,
  limit: number,
  rows: PuzzleSummary[],
  randomSource: PuzzleShuffleRandom,
): void {
  for (const row of shufflePuzzlesWithinAttempts(rows, randomSource)) {
    if (picked.size >= limit) return;
    if (!picked.has(row.id)) picked.set(row.id, row);
  }
}

// A wider window comes only after this one is used up, repeats included, so closeness to the
// student's rating outranks novelty. No count anywhere: counting a window reads all of it.
function sampleAroundRating(
  db: Database,
  filter: RatingSampleFilter,
  randomSource: PuzzleShuffleRandom,
): PuzzleSummary[] {
  const limit = clampLimit(filter.limit);
  const source = sampleSourceFor(filter.theme);
  const range = ratedRange(db, source);
  if (!range) return [];
  const picked = new Map<string, PuzzleSummary>();
  for (let reach = RATING_STEP; ; reach += RATING_STEP) {
    const low = filter.ratingAround - reach;
    const high = filter.ratingAround + reach;
    const window = { low: Math.max(low, range.low), high: Math.min(high, range.high) };
    if (window.low <= window.high) {
      seekUnattempted(db, source, window, picked, limit, randomSource);
      if (picked.size < limit) {
        takeUntilFull(picked, limit, readUnattempted(db, source, window), randomSource);
      }
      if (picked.size < limit) {
        takeUntilFull(picked, limit, readAttempted(db, source, window), randomSource);
      }
    }
    const moreOutside = low > range.low || high < range.high;
    if (picked.size >= limit || !moreOutside) return [...picked.values()];
  }
}

// Fewest attempts first, so unseen puzzles lead, shuffled within equal counts; `total`
// is the whole matching inventory, not the page. This path reads every matching row, so it never
// sees imported Lichess puzzles. With `ratingAround` the list is sampled instead, and `total` is
// the size of the sample, because the inventory cannot be counted cheaply.
export function listPuzzles(
  db: Database,
  filter: PuzzleFilter | RatingSampleFilter = {},
  randomSource: PuzzleShuffleRandom = Math.random,
): PuzzleListing {
  if (filter.ratingAround !== undefined) {
    const puzzles = sampleAroundRating(db, filter, randomSource);
    return { total: puzzles.length, puzzles };
  }
  const where: string[] = [LIBRARY_ONLY];
  const params: string[] = [];
  if (filter.motif !== undefined) {
    where.push("p.motif = ?");
    params.push(filter.motif);
  }
  if (filter.difficulty !== undefined) {
    where.push("p.difficulty = ?");
    params.push(filter.difficulty);
  }
  if (filter.theme !== undefined) {
    where.push("p.id IN (SELECT puzzle_id FROM puzzle_themes WHERE theme = ?)");
    params.push(filter.theme);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const ranked = db
    .prepare(
      `SELECT p.id, p.motif, p.difficulty, p.fen, p.explanation,
              COUNT(a.id) AS attempts, COALESCE(SUM(a.solved), 0) AS solved
       FROM puzzles p INDEXED BY puzzles_library LEFT JOIN puzzle_attempts a ON a.puzzle_id = p.id
       ${clause}
       GROUP BY p.id
       ORDER BY attempts ASC, p.id ASC`,
    )
    .all(...params) as PuzzleSummary[];
  const puzzles = shufflePuzzlesWithinAttempts(ranked, randomSource).slice(
    0,
    clampLimit(filter.limit),
  );
  const counted = db
    .prepare(`SELECT COUNT(*) AS n FROM puzzles p INDEXED BY puzzles_library ${clause}`)
    .get(...params) as {
    n: number;
  };
  return { total: counted.n, puzzles };
}

export function getPuzzle(db: Database, id: string): StoredPuzzle | null {
  const row = db
    .prepare("SELECT id, fen, solution_uci, difficulty_rating FROM puzzles WHERE id = ?")
    .get(id) as
    | { id: string; fen: string; solution_uci: string; difficulty_rating: number | null }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    fen: row.fen,
    solution: JSON.parse(row.solution_uci) as string[],
    rating: row.difficulty_rating,
  };
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
    .prepare(
      `SELECT motif, COUNT(*) AS count FROM puzzles p INDEXED BY puzzles_library
       WHERE ${LIBRARY_ONLY} GROUP BY motif ORDER BY motif`,
    )
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
