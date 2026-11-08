import { Chess } from "chess.js";
import type { Clock } from "../clock.js";
import type { Database } from "../db/open.js";
import { applyUci } from "../engine/moves.js";
import type { Log } from "../log.js";

export const IMPORT_BATCH_SIZE = 5000;
export const PROGRESS_EVERY = 100_000;
const SOURCE = "lichess-db";
const FALLBACK_MOTIF = "tactics";
const FIELD_COUNT = 11;

// Rarest first: a puzzle is filed under the first of these it qualifies for.
const MOTIF_BY_THEME: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["skewer", ["skewer"]],
  ["back_rank_mate", ["backRankMate"]],
  ["promotion", ["promotion", "underPromotion"]],
  ["pin", ["pin"]],
  ["fork", ["fork"]],
  ["opening", ["opening"]],
  ["checkmate", ["mate"]],
  ["endgame", ["endgame"]],
];

const EXPLANATION_BY_MOTIF: Readonly<Record<string, string>> = {
  skewer: "Attack the more valuable piece so it must move and exposes the one behind it.",
  back_rank_mate: "The king is boxed in on its first rank, so a check along that rank is mate.",
  promotion: "Push the pawn to the last rank and pick the piece that wins.",
  pin: "A piece that cannot move without exposing a more valuable one is a target.",
  fork: "One piece attacks two targets at once, and only one of them can be saved.",
  opening: "Find the strongest move while the pieces are still developing.",
  checkmate: "Look for the forcing line that ends in checkmate.",
  endgame: "With few pieces left, the accurate move decides the game.",
  [FALLBACK_MOTIF]: "Find the best move in this position.",
};

export function pickMotif(themes: readonly string[]): string {
  for (const [motif, accepted] of MOTIF_BY_THEME) {
    if (themes.some((theme) => accepted.includes(theme))) return motif;
  }
  return FALLBACK_MOTIF;
}

function difficultyOf(rating: number): string {
  if (rating < 1200) return "beginner";
  if (rating < 1800) return "intermediate";
  return "advanced";
}

// The Lichess file has no quoted fields today, but a quoted comma must not shift every column after it.
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (quoted) {
      if (char !== '"') field += char;
      else if (line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      fields.push(field);
      field = "";
    } else field += char;
  }
  fields.push(field);
  return fields;
}

export interface ImportResult {
  added: number;
  skipped: number;
  failed: number;
}

interface ImportRow {
  puzzleId: string;
  fen: string;
  solutionUci: string[];
  solutionSan: string[];
  rating: number;
  ratingDeviation: number;
  popularity: number;
  plays: number;
  themes: string;
  themeList: string[];
  openingTags: string;
  gameUrl: string;
  motif: string;
}

function integerField(value: string | undefined): number {
  const parsed = Number(value);
  if (value === undefined || value === "" || !Number.isInteger(parsed)) {
    throw new Error(`not an integer: ${value}`);
  }
  return parsed;
}

// The first move is the opponent's, so the student sees the position after it.
function replay(
  fen: string,
  moves: readonly string[],
): { fen: string; uci: string[]; san: string[] } {
  if (moves.length < 2) throw new Error("fewer than two moves");
  const board = new Chess(fen);
  applyUci(board, moves[0] as string);
  const shown = board.fen();
  const solution = moves.slice(1);
  const san = solution.map((uci) => applyUci(board, uci).san);
  return { fen: shown, uci: solution, san };
}

function toImportRow(line: string): ImportRow {
  const fields = parseCsvLine(line);
  if (fields.length !== FIELD_COUNT) throw new Error(`expected ${FIELD_COUNT} fields`);
  const [puzzleId, fen, moves, rating, deviation, popularity, plays, themes, gameUrl, tags] =
    fields;
  const played = replay(fen as string, (moves as string).split(" "));
  const themeList = (themes as string).split(" ").filter((theme) => theme !== "");
  return {
    puzzleId: puzzleId as string,
    fen: played.fen,
    solutionUci: played.uci,
    solutionSan: played.san,
    rating: integerField(rating),
    ratingDeviation: integerField(deviation),
    popularity: integerField(popularity),
    plays: integerField(plays),
    themes: themes as string,
    themeList,
    openingTags: tags as string,
    gameUrl: gameUrl as string,
    motif: pickMotif(themeList),
  };
}

function prepareWriters(db: Database) {
  const insertPuzzle = db.prepare(
    `INSERT OR IGNORE INTO puzzles
       (id, source, motif, difficulty, fen, solution_uci, solution_san, explanation, lichess_id,
        difficulty_rating, popularity, plays, rating_deviation, themes, opening_tags, game_url)
     VALUES
       (@id, @source, @motif, @difficulty, @fen, @solution_uci, @solution_san, @explanation, @lichess_id,
        @difficulty_rating, @popularity, @plays, @rating_deviation, @themes, @opening_tags, @game_url)`,
  );
  const insertTheme = db.prepare(
    "INSERT OR IGNORE INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, ?, ?)",
  );
  return (rows: readonly ImportRow[]): { added: number; skipped: number } => {
    let added = 0;
    db.transaction(() => {
      for (const row of rows) {
        const id = `${SOURCE}:${row.puzzleId}`;
        const written = insertPuzzle.run({
          id,
          source: SOURCE,
          motif: row.motif,
          difficulty: difficultyOf(row.rating),
          fen: row.fen,
          solution_uci: JSON.stringify(row.solutionUci),
          solution_san: JSON.stringify(row.solutionSan),
          explanation: EXPLANATION_BY_MOTIF[row.motif],
          lichess_id: row.puzzleId,
          difficulty_rating: row.rating,
          popularity: row.popularity,
          plays: row.plays,
          rating_deviation: row.ratingDeviation,
          themes: row.themes,
          opening_tags: row.openingTags,
          game_url: row.gameUrl,
        });
        if (written.changes === 0) continue;
        added += 1;
        for (const theme of row.themeList) insertTheme.run(theme, row.rating, id);
      }
    })();
    return { added, skipped: rows.length - added };
  };
}

export interface ImportOptions {
  lines: AsyncIterable<string>;
  db: Database;
  clock: Clock;
  log: Log;
  batchSize?: number;
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function existingLichessIds(db: Database): Set<string> {
  const ids = db.prepare("SELECT lichess_id FROM puzzles WHERE lichess_id IS NOT NULL").pluck();
  return new Set(ids.all() as string[]);
}

export async function importLichessPuzzles(options: ImportOptions): Promise<ImportResult> {
  const { lines, db, clock, log } = options;
  const batchSize = Math.min(options.batchSize ?? IMPORT_BATCH_SIZE, IMPORT_BATCH_SIZE);
  const write = prepareWriters(db);
  const known = existingLichessIds(db);
  const startedAt = clock.now().getTime();
  const result: ImportResult = { added: 0, skipped: 0, failed: 0 };
  let batch: ImportRow[] = [];
  let rows = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const written = write(batch);
    result.added += written.added;
    result.skipped += written.skipped;
    batch = [];
    // Between transactions the running service gets its turn at the WAL.
    await yieldToEventLoop();
  };

  for await (const line of lines) {
    if (line === "" || line.startsWith("PuzzleId,")) continue;
    rows += 1;
    try {
      const row = toImportRow(line);
      if (known.has(row.puzzleId)) result.skipped += 1;
      else {
        known.add(row.puzzleId);
        batch.push(row);
      }
    } catch {
      result.failed += 1;
    }
    if (batch.length >= batchSize) await flush();
    if (rows % PROGRESS_EVERY === 0) {
      await flush();
      log.info("import_lichess.progress", {
        rows,
        ...result,
        duration_ms: clock.now().getTime() - startedAt,
      });
    }
  }
  await flush();
  log.info("import_lichess.done", {
    rows,
    ...result,
    duration_ms: clock.now().getTime() - startedAt,
  });
  return result;
}
