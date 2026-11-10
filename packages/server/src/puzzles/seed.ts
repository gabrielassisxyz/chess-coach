import { join } from "node:path";
import { Chess } from "chess.js";
import { z } from "zod";
import { loadPuzzleFiles } from "../content/puzzles.js";
import type { Database } from "../db/open.js";
import { applyUci } from "../engine/moves.js";
import { NO_OPENING_NAMES, type OpeningNames } from "../openings/names.js";

const entrySchema = z.object({
  fen: z.string().min(1),
  solution_moves: z.array(z.string().min(4)).min(1),
  solution_san: z.array(z.string()),
  motif: z.string().min(1),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]),
  explanation: z.string(),
  source: z.string().min(1),
  difficulty_rating: z.number().int().optional(),
  lichess_id: z.string().optional(),
});

export interface SeedResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

interface PuzzleRow {
  id: string;
  source: string;
  motif: string;
  difficulty: string;
  fen: string;
  solution_uci: string;
  solution_san: string;
  explanation: string;
  lichess_id: string | null;
  difficulty_rating: number | null;
  opening_name: string | null;
}

export class PuzzleSeedError extends Error {}

function describeIssue(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

function assertLineIsPlayable(fen: string, line: readonly string[]): void {
  const board = new Chess(fen);
  for (const uci of line) applyUci(board, uci);
}

function toRow(id: string, entry: z.infer<typeof entrySchema>, names: OpeningNames): PuzzleRow {
  return {
    id,
    source: entry.source,
    motif: entry.motif,
    difficulty: entry.difficulty,
    fen: entry.fen,
    solution_uci: JSON.stringify(entry.solution_moves),
    solution_san: JSON.stringify(entry.solution_san),
    explanation: entry.explanation,
    lichess_id: entry.lichess_id ?? null,
    difficulty_rating: entry.difficulty_rating ?? null,
    opening_name:
      entry.source === "opening_db" ? (names.ofPosition(entry.fen)?.name ?? null) : null,
  };
}

// Every entry is checked before the first write, so one bad entry leaves the table untouched.
function validatedRows(contentRoot: string, names: OpeningNames): PuzzleRow[] {
  const rows: PuzzleRow[] = [];
  for (const [file, entries] of loadPuzzleFiles(join(contentRoot, "puzzles"))) {
    const stem = file.replace(/\.json$/, "");
    entries.forEach((raw, index) => {
      try {
        const entry = entrySchema.parse(raw);
        assertLineIsPlayable(entry.fen, entry.solution_moves);
        rows.push(toRow(`${stem}:${index}`, entry, names));
      } catch (error) {
        throw new PuzzleSeedError(`${file}:${index}: ${describeIssue(error)}`);
      }
    });
  }
  return rows;
}

const COLUMNS = [
  "source",
  "motif",
  "difficulty",
  "fen",
  "solution_uci",
  "solution_san",
  "explanation",
  "lichess_id",
  "difficulty_rating",
  "opening_name",
] as const;

const THEMED_MOTIFS: ReadonlySet<string> = new Set(["fork", "pin", "skewer"]);

function isThemed(row: Pick<PuzzleRow, "motif" | "difficulty_rating">): boolean {
  return row.difficulty_rating !== null && THEMED_MOTIFS.has(row.motif);
}

// Counts come from comparing with the stored row, so a reboot over unchanged files reports zero writes.
export function seedPuzzles(
  db: Database,
  contentRoot: string,
  openingNames: OpeningNames = NO_OPENING_NAMES,
): SeedResult {
  const rows = validatedRows(contentRoot, openingNames);
  const find = db.prepare("SELECT * FROM puzzles WHERE id = ?");
  const upsert = db.prepare(
    `INSERT INTO puzzles (id, ${COLUMNS.join(", ")})
     VALUES (@id, ${COLUMNS.map((column) => `@${column}`).join(", ")})
     ON CONFLICT(id) DO UPDATE SET ${COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}`,
  );
  // The key starts at the theme, so the stored row has to name the old entry: looking one up by
  // puzzle id alone would scan the table, which holds millions of rows after a Lichess import.
  const dropTheme = db.prepare(
    "DELETE FROM puzzle_themes WHERE theme = ? AND rating = ? AND puzzle_id = ?",
  );
  const addTheme = db.prepare(
    "INSERT INTO puzzle_themes (theme, rating, puzzle_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  );
  const result: SeedResult = { inserted: 0, updated: 0, unchanged: 0 };
  db.transaction(() => {
    for (const row of rows) {
      const stored = find.get(row.id) as PuzzleRow | undefined;
      // Unchanged rows pass here too: the table starts empty on a database that holds the puzzles.
      if (isThemed(row)) addTheme.run(row.motif, row.difficulty_rating, row.id);
      if (stored && COLUMNS.every((column) => stored[column] === row[column])) {
        result.unchanged += 1;
        continue;
      }
      if (stored && isThemed(stored)) {
        const moved =
          stored.motif !== row.motif || stored.difficulty_rating !== row.difficulty_rating;
        if (moved) dropTheme.run(stored.motif, stored.difficulty_rating, stored.id);
      }
      upsert.run(row);
      if (stored) result.updated += 1;
      else result.inserted += 1;
    }
  })();
  return result;
}
