import { join } from "node:path";
import { Chess } from "chess.js";
import { z } from "zod";
import { loadPuzzleFiles } from "../content/puzzles.js";
import type { Database } from "../db/open.js";
import { applyUci } from "../engine/moves.js";

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

function toRow(id: string, entry: z.infer<typeof entrySchema>): PuzzleRow {
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
  };
}

// Every entry is checked before the first write, so one bad entry leaves the table untouched.
function validatedRows(contentRoot: string): PuzzleRow[] {
  const rows: PuzzleRow[] = [];
  for (const [file, entries] of loadPuzzleFiles(join(contentRoot, "puzzles"))) {
    const stem = file.replace(/\.json$/, "");
    entries.forEach((raw, index) => {
      try {
        const entry = entrySchema.parse(raw);
        assertLineIsPlayable(entry.fen, entry.solution_moves);
        rows.push(toRow(`${stem}:${index}`, entry));
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
] as const;

// Counts come from comparing with the stored row, so a reboot over unchanged files reports zero writes.
export function seedPuzzles(db: Database, contentRoot: string): SeedResult {
  const rows = validatedRows(contentRoot);
  const find = db.prepare("SELECT * FROM puzzles WHERE id = ?");
  const upsert = db.prepare(
    `INSERT INTO puzzles (id, ${COLUMNS.join(", ")})
     VALUES (@id, ${COLUMNS.map((column) => `@${column}`).join(", ")})
     ON CONFLICT(id) DO UPDATE SET ${COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}`,
  );
  const result: SeedResult = { inserted: 0, updated: 0, unchanged: 0 };
  db.transaction(() => {
    for (const row of rows) {
      const stored = find.get(row.id) as PuzzleRow | undefined;
      if (stored && COLUMNS.every((column) => stored[column] === row[column])) {
        result.unchanged += 1;
        continue;
      }
      upsert.run(row);
      if (stored) result.updated += 1;
      else result.inserted += 1;
    }
  })();
  return result;
}
