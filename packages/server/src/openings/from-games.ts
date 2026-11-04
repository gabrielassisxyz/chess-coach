import { createHash } from "node:crypto";
import { Chess } from "chess.js";
import type { Database } from "../db/open.js";
import {
  getPuzzleExplanation,
  insertGeneratedPuzzle,
  setPuzzleExplanation,
} from "../db/puzzles.js";
import { EVALUATION_DEPTH } from "../engine/evaluate.js";
import { applyUci } from "../engine/moves.js";
import type { Searcher } from "../engine/uci.js";

export const OPENING_SOURCE = "own-games";
export const MAX_OPENING_PLY = 30;
/** A drill asks one question with one answer: the runner-up must trail by at least this much. */
export const MIN_CLEAR_GAP_CP = 30;
const PV_PLIES_SHOWN = 3;

export interface GenerationResult {
  positions: number;
  created: number;
  updated: number;
}

interface OpeningPosition {
  key: string;
  fen: string;
  color: "white" | "black";
  bestMoveUci: string | null;
  games: Set<number>;
}

interface StudentPlyRow {
  game_id: number;
  fen_before: string;
  best_move_uci: string | null;
  player_color: "white" | "black";
}

// Placement, side, castling and en passant: the move counters differ between games reaching one position.
export const positionKey = (fen: string): string => fen.split(" ").slice(0, 4).join(" ");

export const puzzleId = (key: string): string =>
  `own:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

function collectPositions(db: Database): OpeningPosition[] {
  const rows = db
    .prepare(
      `SELECT m.game_id, m.fen_before, m.best_move_uci, g.player_color
       FROM moves m JOIN games g ON g.id = m.game_id
       WHERE g.grading = 'done' AND m.is_player = 1 AND m.ply <= ?
       ORDER BY m.game_id, m.ply`,
    )
    .all(MAX_OPENING_PLY) as StudentPlyRow[];
  const byKey = new Map<string, OpeningPosition>();
  for (const row of rows) {
    const key = positionKey(row.fen_before);
    const seen = byKey.get(key);
    if (seen) {
      seen.games.add(row.game_id);
      seen.bestMoveUci ??= row.best_move_uci;
      continue;
    }
    byKey.set(key, {
      key,
      fen: row.fen_before,
      color: row.player_color,
      bestMoveUci: row.best_move_uci,
      games: new Set([row.game_id]),
    });
  }
  return [...byKey.values()];
}

const explanationFor = (games: number, san: string, line: string): string =>
  `From ${games} of your games. Best: ${san}. Engine line: ${line}.`;

const GAME_COUNT_PREFIX = /^From \d+ of your games\./;

function pvSan(fen: string, moves: string[]): string {
  const position = new Chess(fen);
  const shown: string[] = [];
  for (const uci of moves.slice(0, PV_PLIES_SHOWN)) shown.push(applyUci(position, uci).san);
  return shown.join(" ");
}

// A position already stored keeps its engine verdict: only the game count moves, so a re-run costs no search.
function refreshCount(db: Database, position: OpeningPosition, stored: string): boolean {
  const text = stored.replace(GAME_COUNT_PREFIX, `From ${position.games.size} of your games.`);
  if (text === stored) return false;
  setPuzzleExplanation(db, puzzleId(position.key), text);
  return true;
}

async function clearBestMove(
  engine: Searcher,
  position: OpeningPosition,
): Promise<{ best: string; line: string } | null> {
  const result = await engine.search({
    fen: position.fen,
    depth: EVALUATION_DEPTH,
    multipv: 2,
  });
  const [first, second] = result.lines;
  const best = first?.moves[0];
  if (!first || !second || !best) return null;
  if (position.bestMoveUci && position.bestMoveUci !== best) return null;
  if (first.score - second.score < MIN_CLEAR_GAP_CP) return null;
  return { best, line: pvSan(position.fen, first.moves) };
}

/**
 * Turns the early positions of the student's graded games into "find the best move" puzzles.
 * Each position is committed on its own, so an interrupted run resumes by running again.
 */
export async function generateOpeningPuzzles(
  db: Database,
  engine: Searcher,
): Promise<GenerationResult> {
  const positions = collectPositions(db);
  const result: GenerationResult = { positions: positions.length, created: 0, updated: 0 };
  for (const position of positions) {
    const id = puzzleId(position.key);
    const stored = getPuzzleExplanation(db, id);
    if (stored !== null) {
      if (refreshCount(db, position, stored)) result.updated += 1;
      continue;
    }
    const found = await clearBestMove(engine, position);
    if (!found) continue;
    const san = applyUci(new Chess(position.fen), found.best).san;
    const inserted = insertGeneratedPuzzle(db, {
      id,
      source: OPENING_SOURCE,
      motif: `opening-${position.color}`,
      difficulty: "beginner",
      fen: position.fen,
      solutionUci: [found.best],
      solutionSan: [san],
      explanation: explanationFor(position.games.size, san, found.line),
    });
    if (inserted) result.created += 1;
  }
  return result;
}
