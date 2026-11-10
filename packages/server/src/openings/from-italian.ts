import { createHash } from "node:crypto";
import { Chess } from "chess.js";
import type { Database } from "../db/open.js";
import { insertGeneratedPuzzle } from "../db/puzzles.js";
import { EVALUATION_DEPTH } from "../engine/evaluate.js";
import { applyUci } from "../engine/moves.js";
import type { Searcher } from "../engine/uci.js";
import {
  CachedExplorer,
  EXPLORER_BAND_LABEL,
  EXPLORER_RATINGS,
  type ExplorerClock,
  ExplorerError,
  type ExplorerFetcher,
  type ExplorerPosition,
  gamesOf,
  ITALIAN_WHITE_RATINGS,
} from "./explorer-client.js";
import type { ExplorerResult } from "./from-explorer.js";
import { chooseReplies, MAX_OPPONENT_REPLIES, MIN_POSITION_GAMES } from "./from-explorer.js";
import { positionKey } from "./from-games.js";
import type { OpeningNames } from "./names.js";

export const ITALIAN_SOURCE = "italian-explorer";
export const ITALIAN_MOTIF = "opening-italian";
export const ITALIAN_MAX_PLY = 24;
export const ITALIAN_CP_MARGIN = 50;

const ITALIAN_SETUP_UCI_BY_TURN: Record<number, string> = {
  1: "e2e4",
  2: "g1f3",
  3: "f1c4",
};

export interface ItalianOptions {
  maxPly?: number;
  minGames?: number;
  maxReplies?: number;
  maxRequests?: number;
}

interface ItalianStep {
  fen: string;
  ply: number;
  line: string[];
  share: number | null;
  openingName: string | null;
}

export const italianPuzzleId = (key: string): string =>
  `italian:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

const italianTurnOf = (ply: number): number => Math.ceil(ply / 2);

const italianLineText = (plies: string[]): string =>
  plies.map((san, index) => (index % 2 === 0 ? `${index / 2 + 1}. ${san}` : san)).join(" ");

function italianLegalUci(
  fen: string,
  uci: string,
): { uci: string; san: string; after: string } | null {
  const game = new Chess(fen);
  try {
    const move = applyUci(game, uci);
    return { uci, san: move.san, after: game.fen() };
  } catch {
    return null;
  }
}

function italianPlaySan(fen: string, san: string): { uci: string; after: string } | null {
  const game = new Chess(fen);
  try {
    const move = game.move(san);
    return { uci: `${move.from}${move.to}${move.promotion ?? ""}`, after: game.fen() };
  } catch {
    return null;
  }
}

/**
 * The White move for one Italian node: the most played 1800-2499 candidate within
 * 50 cp of the engine best, with the setup move preferred on turns 1-3, else the best.
 */
export function pickItalianWhiteUci(
  fen: string,
  position: ExplorerPosition,
  lines: Array<{ moves: string[]; score: number }>,
  turn: number,
): string | null {
  const first = lines[0];
  const best = first?.moves[0];
  if (!first || !best) return null;
  const bestScore = first.score;
  const scoreByUci = new Map<string, number>();
  for (const line of lines) {
    const uci = line.moves[0];
    if (uci && !scoreByUci.has(uci)) scoreByUci.set(uci, line.score);
  }
  const withinMargin = (uci: string): boolean => {
    const score = scoreByUci.get(uci);
    return score !== undefined && bestScore - score <= ITALIAN_CP_MARGIN;
  };
  const setup = ITALIAN_SETUP_UCI_BY_TURN[turn];
  if (setup && italianLegalUci(fen, setup) && withinMargin(setup)) return setup;
  const ranked = [...position.moves].sort((a, b) => gamesOf(b) - gamesOf(a));
  for (const candidate of ranked) {
    const played = italianPlaySan(fen, candidate.san);
    if (!played) continue;
    if (withinMargin(played.uci)) return played.uci;
  }
  return best;
}

const italianExplanation = (line: string[], share: number | null, san: string): string => {
  if (line.length === 0) return `Italian Opening from the start. Best: ${san}.`;
  const played =
    share === null ? "" : ` Played by ${share}% of opponents at ${EXPLORER_BAND_LABEL}.`;
  return `Italian Opening after ${italianLineText(line)}.${played} Best: ${san}.`;
};

class ItalianWalk {
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

  constructor(
    private readonly db: Database,
    private readonly engine: Searcher,
    private readonly explorer: CachedExplorer,
    options: ItalianOptions,
    private readonly names?: OpeningNames,
  ) {
    this.minGames = options.minGames ?? MIN_POSITION_GAMES;
    this.maxPly = options.maxPly ?? ITALIAN_MAX_PLY;
    this.maxReplies = options.maxReplies ?? MAX_OPPONENT_REPLIES;
  }

  async run(): Promise<void> {
    await this.visit({ fen: new Chess().fen(), ply: 1, line: [], share: null, openingName: null });
  }

  private async visit(step: ItalianStep): Promise<void> {
    if (step.ply > this.maxPly) return;
    const named = {
      ...step,
      openingName: this.names?.ofPosition(step.fen)?.name ?? step.openingName,
    };
    if (step.ply % 2 === 1) await this.visitWhite(named);
    else await this.visitBlack(named);
  }

  private async visitBlack(step: ItalianStep): Promise<void> {
    const position = await this.explorer.position(step.fen, EXPLORER_RATINGS);
    const total = gamesOf(position);
    for (const reply of chooseReplies(position, this.maxReplies, this.minGames)) {
      const played = italianPlaySan(step.fen, reply.san);
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

  private async visitWhite(step: ItalianStep): Promise<void> {
    const position = await this.explorer.position(step.fen, ITALIAN_WHITE_RATINGS);
    this.result.positions += 1;
    const searched = await this.engine.search({
      fen: step.fen,
      depth: EVALUATION_DEPTH,
      multipv: 5,
    });
    const choice = pickItalianWhiteUci(step.fen, position, searched.lines, italianTurnOf(step.ply));
    if (!choice) return;
    const move = italianLegalUci(step.fen, choice);
    if (!move) return;
    this.store(step, move.san, choice);
    await this.visit({
      fen: move.after,
      ply: step.ply + 1,
      line: [...step.line, move.san],
      share: step.share,
      openingName: step.openingName,
    });
  }

  private store(step: ItalianStep, san: string, best: string): void {
    const key = positionKey(step.fen);
    const inserted = insertGeneratedPuzzle(this.db, {
      id: italianPuzzleId(key),
      source: ITALIAN_SOURCE,
      motif: ITALIAN_MOTIF,
      difficulty: "beginner",
      fen: step.fen,
      solutionUci: [best],
      solutionSan: [san],
      explanation: italianExplanation(step.line, step.share, san),
      openingName: step.openingName,
    });
    if (inserted) this.result.created += 1;
  }
}

/**
 * Builds the White Italian tree from the start against the replies most played at
 * 0-1199, keeping every White node whose popular 1800-2499 move stays within 50 cp.
 */
export async function generateItalianPuzzles(
  db: Database,
  engine: Searcher,
  fetcher: ExplorerFetcher,
  cacheDir: string,
  clock: ExplorerClock,
  options: ItalianOptions = {},
  names?: OpeningNames,
): Promise<ExplorerResult> {
  const explorer = new CachedExplorer(fetcher, cacheDir, clock, options.maxRequests);
  const walk = new ItalianWalk(db, engine, explorer, options, names);
  try {
    await walk.run();
  } catch (error) {
    if (!(error instanceof ExplorerError && error.code === "budget")) throw error;
    walk.result.truncated = true;
  }
  walk.result.requests = explorer.requests;
  walk.result.cacheHits = explorer.cacheHits;
  return walk.result;
}
