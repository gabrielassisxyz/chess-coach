import { createHash } from "node:crypto";
import { Chess } from "chess.js";
import type { Database } from "../db/open.js";
import { getPuzzleExplanation, insertGeneratedPuzzle } from "../db/puzzles.js";
import { EVALUATION_DEPTH } from "../engine/evaluate.js";
import { applyUci } from "../engine/moves.js";
import type { Searcher } from "../engine/uci.js";
import {
  CachedExplorer,
  EXPLORER_BAND_LABEL,
  type ExplorerClock,
  ExplorerError,
  type ExplorerFetcher,
  type ExplorerMove,
  type ExplorerPosition,
  gamesOf,
} from "./explorer-client.js";
import { MAX_OPENING_PLY, MIN_CLEAR_GAP_CP, positionKey, puzzleId } from "./from-games.js";
import type { OpeningNames } from "./names.js";

export const EXPLORER_SOURCE = "lichess-explorer";
export const REPERTOIRE_TURNS = 3;
export const MIN_POSITION_GAMES = 200;
export const MAX_OPPONENT_REPLIES = 3;
const REPLY_COVERAGE = 0.6;

type Color = "white" | "black";

export interface ExplorerOptions {
  /** Both colours when absent. */
  color?: Color;
  repertoireTurns?: number;
  maxPly?: number;
  minGames?: number;
  maxReplies?: number;
  /** Requests allowed to reach the network in this run. */
  maxRequests?: number;
}

export interface ExplorerResult {
  positions: number;
  created: number;
  skippedOwn: number;
  requests: number;
  cacheHits: number;
  /** True when the request budget ended the run early; running again resumes from the cache. */
  truncated: boolean;
}

interface Repertoire {
  byPosition: Map<string, string>;
  byTurn: Map<number, string>;
}

interface Step {
  fen: string;
  ply: number;
  line: string[];
  /** Share of the opponent's last move among its siblings, in percent; null before any opponent move. */
  share: number | null;
  openingName: string | null;
}

const explorerPuzzleId = (key: string): string =>
  `explorer:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

const turnOf = (ply: number): number => Math.ceil(ply / 2);

function mostPlayed(counts: Map<string, number>): string | undefined {
  let best: [string, number] | undefined;
  for (const entry of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best?.[0];
}

function tally(into: Map<string, Map<string, number>>, key: string, uci: string): void {
  const counts = into.get(key) ?? new Map<string, number>();
  counts.set(uci, (counts.get(uci) ?? 0) + 1);
  into.set(key, counts);
}

/** The student's habitual first moves: per position where seen, per turn number as the fallback. */
export function deriveRepertoire(db: Database, color: Color, turns: number): Repertoire {
  const rows = db
    .prepare(
      `SELECT m.fen_before, m.uci, m.ply
       FROM moves m JOIN games g ON g.id = m.game_id
       WHERE g.grading = 'done' AND m.is_player = 1 AND g.player_color = ? AND m.ply <= ?`,
    )
    .all(color, turns * 2) as Array<{ fen_before: string; uci: string; ply: number }>;
  const position = new Map<string, Map<string, number>>();
  const turn = new Map<string, Map<string, number>>();
  for (const row of rows) {
    tally(position, positionKey(row.fen_before), row.uci);
    tally(turn, String(turnOf(row.ply)), row.uci);
  }
  const pick = (source: Map<string, Map<string, number>>) =>
    new Map(
      [...source].flatMap(([key, counts]) => {
        const best = mostPlayed(counts);
        return best ? [[key, best] as [string, string]] : [];
      }),
    );
  const byTurn = new Map(
    [...pick(turn)].map(([key, uci]) => [Number(key), uci] as [number, string]),
  );
  return { byPosition: pick(position), byTurn };
}

function legalUci(fen: string, uci: string): { uci: string; san: string; after: string } | null {
  const game = new Chess(fen);
  try {
    const move = applyUci(game, uci);
    return { uci, san: move.san, after: game.fen() };
  } catch {
    return null;
  }
}

function playSan(fen: string, san: string): { uci: string; after: string } | null {
  const game = new Chess(fen);
  try {
    const move = game.move(san);
    return { uci: `${move.from}${move.to}${move.promotion ?? ""}`, after: game.fen() };
  } catch {
    return null;
  }
}

/** Most played replies until they cover 60 percent of the games, at most `limit`, none under the floor. */
export function chooseReplies(
  position: ExplorerPosition,
  limit: number,
  minGames: number,
): ExplorerMove[] {
  const total = gamesOf(position);
  const ranked = [...position.moves]
    .filter((move) => gamesOf(move) >= minGames)
    .sort((a, b) => gamesOf(b) - gamesOf(a));
  const chosen: ExplorerMove[] = [];
  let covered = 0;
  for (const move of ranked) {
    if (chosen.length >= limit || covered >= REPLY_COVERAGE * total) break;
    chosen.push(move);
    covered += gamesOf(move);
  }
  return chosen;
}

const lineText = (plies: string[]): string =>
  plies.map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}. ${san}` : san)).join(" ");

class ExplorerWalk {
  readonly result: ExplorerResult = {
    positions: 0,
    created: 0,
    skippedOwn: 0,
    requests: 0,
    cacheHits: 0,
    truncated: false,
  };
  private readonly minGames: number;
  private readonly maxPly: number;
  private readonly maxReplies: number;
  private readonly turns: number;
  private repertoire: Repertoire = { byPosition: new Map(), byTurn: new Map() };

  constructor(
    private readonly db: Database,
    private readonly engine: Searcher,
    private readonly explorer: CachedExplorer,
    private readonly color: Color,
    options: ExplorerOptions,
    private readonly names?: OpeningNames,
  ) {
    this.minGames = options.minGames ?? MIN_POSITION_GAMES;
    this.maxPly = options.maxPly ?? MAX_OPENING_PLY;
    this.maxReplies = options.maxReplies ?? MAX_OPPONENT_REPLIES;
    this.turns = options.repertoireTurns ?? REPERTOIRE_TURNS;
  }

  async run(): Promise<void> {
    this.repertoire = deriveRepertoire(this.db, this.color, this.turns);
    // No repertoire, no tree: the drill never teaches an opening the student does not play.
    if (this.repertoire.byTurn.size === 0) return;
    const start = new Chess().fen();
    await this.visit({ fen: start, ply: 1, line: [], share: null, openingName: null });
  }

  private async visit(step: Step): Promise<void> {
    if (step.ply > this.maxPly) return;
    const named = {
      ...step,
      openingName: this.names?.ofPosition(step.fen)?.name ?? step.openingName,
    };
    const key = positionKey(step.fen);
    const studentToMove = (step.ply % 2 === 1) === (this.color === "white");
    if (studentToMove) await this.visitStudent(named, key);
    else await this.visitOpponent(named);
  }

  private async visitOpponent(step: Step): Promise<void> {
    const position = await this.explorer.position(step.fen);
    const total = gamesOf(position);
    for (const reply of chooseReplies(position, this.maxReplies, this.minGames)) {
      const played = playSan(step.fen, reply.san);
      if (!played) continue;
      await this.visit({
        fen: played.after,
        ply: step.ply + 1,
        line: [...step.line, reply.san],
        share: Math.round((gamesOf(reply) / total) * 100),
        openingName: step.openingName,
      });
    }
  }

  private async visitStudent(step: Step, key: string): Promise<void> {
    const inRepertoire = turnOf(step.ply) <= this.turns;
    const choice = inRepertoire
      ? this.repertoireMove(step.ply, key)
      : await this.engineMove(step, key);
    if (!choice) return;
    const move = legalUci(step.fen, choice);
    if (!move) return;
    await this.visit({
      fen: move.after,
      ply: step.ply + 1,
      line: [...step.line, move.san],
      share: null,
      openingName: step.openingName,
    });
  }

  private repertoireMove(ply: number, key: string): string | null {
    return this.repertoire.byPosition.get(key) ?? this.repertoire.byTurn.get(turnOf(ply)) ?? null;
  }

  private async engineMove(step: Step, key: string): Promise<string | null> {
    this.result.positions += 1;
    const searched = await this.engine.search({
      fen: step.fen,
      depth: EVALUATION_DEPTH,
      multipv: 2,
    });
    const [first, second] = searched.lines;
    const best = first?.moves[0];
    if (!first || !best) return null;
    if (second && first.score - second.score >= MIN_CLEAR_GAP_CP && step.share !== null) {
      this.store(step, key, best);
    }
    return best;
  }

  private store(step: Step, key: string, best: string): void {
    if (getPuzzleExplanation(this.db, puzzleId(key)) !== null) {
      this.result.skippedOwn += 1;
      return;
    }
    const move = legalUci(step.fen, best);
    if (!move) return;
    const inserted = insertGeneratedPuzzle(this.db, {
      id: explorerPuzzleId(key),
      source: EXPLORER_SOURCE,
      motif: `opening-${this.color}`,
      difficulty: "beginner",
      fen: step.fen,
      solutionUci: [best],
      solutionSan: [move.san],
      explanation: `Played by ${step.share}% of opponents at ${EXPLORER_BAND_LABEL} after ${lineText(step.line)}. Best: ${move.san}.`,
      openingName: step.openingName,
    });
    if (inserted) this.result.created += 1;
  }
}

/**
 * Expands the student's habitual first moves into the replies most played at the student's rating,
 * and stores a "find the best move" puzzle at every student-to-move node with a clear engine answer.
 * Each puzzle commits on its own, so a run cut short by the request budget resumes from the cache.
 */
export async function generateExplorerPuzzles(
  db: Database,
  engine: Searcher,
  fetcher: ExplorerFetcher,
  cacheDir: string,
  clock: ExplorerClock,
  options: ExplorerOptions = {},
  names?: OpeningNames,
): Promise<ExplorerResult> {
  const explorer = new CachedExplorer(fetcher, cacheDir, clock, options.maxRequests);
  const colors: Color[] = options.color ? [options.color] : ["white", "black"];
  const total: ExplorerResult = {
    positions: 0,
    created: 0,
    skippedOwn: 0,
    requests: 0,
    cacheHits: 0,
    truncated: false,
  };
  for (const color of colors) {
    const walk = new ExplorerWalk(db, engine, explorer, color, options, names);
    try {
      await walk.run();
    } catch (error) {
      if (!(error instanceof ExplorerError && error.code === "budget")) throw error;
      total.truncated = true;
    }
    total.positions += walk.result.positions;
    total.created += walk.result.created;
    total.skippedOwn += walk.result.skippedOwn;
    if (total.truncated) break;
  }
  total.requests = explorer.requests;
  total.cacheHits = explorer.cacheHits;
  return total;
}
