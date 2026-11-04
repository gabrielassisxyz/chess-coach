import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Puzzle {
  fen: string;
  solution_moves: string[];
  solution_san: string[];
  motif: string;
  difficulty: string;
  explanation: string;
  source: string;
  difficulty_rating?: number;
  lichess_id?: string;
  lichess_themes?: string[];
}

export const REQUIRED_PUZZLE_KEYS = [
  "fen",
  "solution_moves",
  "solution_san",
  "motif",
  "difficulty",
  "explanation",
  "source",
] as const;

function findRepositoryRoot(startDir: string): string {
  let dir = startDir;
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`pnpm-workspace.yaml not found above ${startDir}`);
    dir = parent;
  }
  return dir;
}

export function defaultPuzzlesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(findRepositoryRoot(here), "content", "puzzles");
}

export function loadPuzzleFiles(dir: string = defaultPuzzlesDir()): Map<string, Puzzle[]> {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  return new Map(
    files.map((name) => [name, JSON.parse(readFileSync(join(dir, name), "utf8")) as Puzzle[]]),
  );
}
