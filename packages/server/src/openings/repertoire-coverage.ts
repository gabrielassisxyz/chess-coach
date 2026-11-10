import type {
  CoverageGap,
  CoveragePosition,
  CoverageReply,
  CoverageScores,
  CoverageStatus,
  RepertoireCoverage,
} from "@chess-coach/shared";
import { Chess } from "chess.js";
import type { Database } from "../db/open.js";
import { findDrillRepertoire } from "../db/repertoire-cards.js";
import type { RepertoireMoveSource, RepertoireResultCounts } from "../db/repertoires.js";
import { applyUci } from "../engine/moves.js";
import { EXPLORER_BAND_LABEL } from "./explorer-client.js";
import { MIN_POSITION_GAMES } from "./from-explorer.js";
import { positionKey } from "./from-games.js";
import { REPERTOIRE_MIN_REACH } from "./from-repertoire.js";

/** Centipawns a White move may give up before it counts against the line it is in. */
export const CONCESSION_ALLOWANCE_CP = 10;
/** The mean concession at which soundness bottoms out; a line that concedes nothing scores the top. */
export const SOUNDNESS_FLOOR_CONCESSION_CP = 200;
const SOUNDNESS_TOP = 99;
const SOUNDNESS_BOTTOM = 1;
const GOAL_ONE_IN = Math.round(1 / REPERTOIRE_MIN_REACH);
const START_KEY = positionKey(new Chess().fen());

interface StoredOwn {
  id: number;
  positionKey: string;
  line: string[];
  uci: string;
  san: string;
  reach: number;
  cpLoss: number;
  results: RepertoireResultCounts | null;
}

interface StoredReply {
  id: number;
  uci: string;
  san: string;
  reach: number;
  source: RepertoireMoveSource;
}

interface StoredTree {
  /** The White move stored for each position it is played in. */
  ownAt: Map<string, StoredOwn>;
  /** Black's replies by the position they are played in, which is the one after White's move. */
  repliesAt: Map<string, StoredReply[]>;
}

interface StoredRowSql {
  id: number;
  kind: "own" | "reply";
  position_key: string;
  line_san: string;
  move_uci: string;
  move_san: string;
  reach: number;
  source: RepertoireMoveSource;
  cp_loss: number | null;
  wins: number | null;
  draws: number | null;
  losses: number | null;
}

function loadStoredTree(db: Database, repertoireId: number): StoredTree {
  const rows = db
    .prepare(
      `SELECT id, kind, position_key, line_san, move_uci, move_san, reach, source, cp_loss,
              wins, draws, losses
       FROM repertoire_positions WHERE repertoire_id = ? ORDER BY id`,
    )
    .all(repertoireId) as StoredRowSql[];
  const tree: StoredTree = { ownAt: new Map(), repliesAt: new Map() };
  for (const row of rows) {
    if (row.kind === "own") {
      tree.ownAt.set(row.position_key, storedOwnOf(row));
      continue;
    }
    const listed = tree.repliesAt.get(row.position_key) ?? [];
    listed.push({
      id: row.id,
      uci: row.move_uci,
      san: row.move_san,
      reach: row.reach,
      source: row.source,
    });
    tree.repliesAt.set(row.position_key, listed);
  }
  return tree;
}

function storedOwnOf(row: StoredRowSql): StoredOwn {
  const counted = row.wins !== null && row.draws !== null && row.losses !== null;
  return {
    id: row.id,
    positionKey: row.position_key,
    line: JSON.parse(row.line_san) as string[],
    uci: row.move_uci,
    san: row.move_san,
    reach: row.reach,
    cpLoss: row.cp_loss ?? 0,
    results: counted
      ? { wins: row.wins ?? 0, draws: row.draws ?? 0, losses: row.losses ?? 0 }
      : null,
  };
}

// The key of the position a move leads to. Keys drop the move counters, so a position is rebuilt
// with fresh ones; null for a move that no longer plays, which leaves that branch unanswered.
function keyAfter(key: string, uci: string): string | null {
  try {
    const board = new Chess(`${key} 0 1`);
    applyUci(board, uci);
    return positionKey(board.fen());
  } catch {
    return null;
  }
}

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

const gamesIn = (results: RepertoireResultCounts | null): number =>
  results ? results.wins + results.draws + results.losses : 0;

// Rarer than the goal, a reply needs no answer; at the goal or likelier, it does.
const needsAnswer = (incidence: number): boolean => incidence >= REPERTOIRE_MIN_REACH;

function statusOf(next: number | null, incidence: number): CoverageStatus {
  if (next !== null) return "covered";
  return needsAnswer(incidence) ? "gap" : "not_required";
}

interface WalkNode {
  own: StoredOwn;
  parent: number | null;
  /** Centipawns conceded beyond the allowance by White's moves from move 1 through this one. */
  concession: number;
  replies: CoverageReply[];
  /** The positions White answers into that the walk had finished by then, so a way back is left out. */
  answered: number[];
  /** Enough games here or below: a line through this move still has a position to end at. */
  lineEnd: boolean;
  /** Too few games here, and a line below leads to its end through moves with too few as well. */
  weakToEnd: boolean;
}

interface Answer {
  index: number;
  finished: boolean;
}

const orderedByIncidence = (replies: readonly StoredReply[]): StoredReply[] =>
  [...replies].sort((a, b) => b.reach - a.reach || a.id - b.id);

// Walks the stored moves from the first one, in the order a student would meet them. A position
// reached by two move orders is walked once, by the first the walk meets, and the other reply
// points at it; the same goes for a way back to a position the walk is still inside.
class StoredTreeWalk {
  private readonly nodes: WalkNode[] = [];
  private readonly indexOf = new Map<number, number>();
  private readonly insideNow = new Set<number>();

  constructor(private readonly tree: StoredTree) {}

  run(): WalkNode[] {
    const first = this.tree.ownAt.get(START_KEY);
    if (first) this.visit(first, null, 0);
    return this.nodes;
  }

  private visit(own: StoredOwn, parent: number | null, conceded: number): number {
    const index = this.nodes.length;
    const node: WalkNode = {
      own,
      parent,
      concession: conceded + Math.max(0, own.cpLoss - CONCESSION_ALLOWANCE_CP),
      replies: [],
      answered: [],
      lineEnd: false,
      weakToEnd: false,
    };
    this.nodes.push(node);
    this.indexOf.set(own.id, index);
    this.insideNow.add(own.id);
    const afterWhite = keyAfter(own.positionKey, own.uci);
    if (afterWhite !== null) this.visitReplies(node, index, afterWhite);
    this.insideNow.delete(own.id);
    this.settle(node);
    return index;
  }

  private visitReplies(node: WalkNode, index: number, afterWhite: string): void {
    for (const reply of orderedByIncidence(this.tree.repliesAt.get(afterWhite) ?? [])) {
      const answer = this.answerTo(afterWhite, reply, index, node.concession);
      node.replies.push(coverageReplyOf(reply, answer?.index ?? null));
      if (answer?.finished) node.answered.push(answer.index);
    }
  }

  private answerTo(
    afterWhite: string,
    reply: StoredReply,
    from: number,
    conceded: number,
  ): Answer | null {
    const key = keyAfter(afterWhite, reply.uci);
    const answer = key === null ? undefined : this.tree.ownAt.get(key);
    if (!answer) return null;
    const known = this.indexOf.get(answer.id);
    if (known !== undefined) return { index: known, finished: !this.insideNow.has(answer.id) };
    return { index: this.visit(answer, from, conceded), finished: true };
  }

  // A line ends at the deepest White move whose position has enough games. This move is that end
  // for some line when it has enough games and a line leaves it only through moves that do not.
  private settle(node: WalkNode): void {
    const enough = gamesIn(node.own.results) >= MIN_POSITION_GAMES;
    const reachesEnd =
      node.answered.length === 0 || node.answered.some((index) => this.nodes[index]?.weakToEnd);
    node.lineEnd = enough && reachesEnd;
    node.weakToEnd = !enough && reachesEnd;
  }
}

function coverageReplyOf(reply: StoredReply, next: number | null): CoverageReply {
  const incidence = clampUnit(reply.reach);
  return {
    san: reply.san,
    incidence,
    status: statusOf(next, incidence),
    source: reply.source,
    next,
  };
}

const positionLine = (node: WalkNode): string[] => [...node.own.line, node.own.san];

function gapsOf(nodes: readonly WalkNode[]): CoverageGap[] {
  const gaps = nodes.flatMap((node, position) =>
    node.replies
      .filter((reply) => reply.status === "gap")
      .map((reply) => ({
        line: [...positionLine(node), reply.san],
        incidence: reply.incidence,
        position,
      })),
  );
  return gaps.sort((a, b) => b.incidence - a.incidence || a.line.length - b.line.length);
}

const roundTo = (value: number, decimals: number): number => {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
};

// The share of the games that stay above the goal and end in a prepared line rather than in a gap.
// A prepared line ends at a move reached at least as often as the goal that has no reply to
// prepare for left: what Black plays rarer than the goal is not required, so it counts for nothing
// either way. Each position counts once, by the chance a game reaches it.
function coveredPercentOf(nodes: readonly WalkNode[], gaps: readonly CoverageGap[]): number | null {
  const prepared = nodes
    .filter(
      (node) =>
        needsAnswer(clampUnit(node.own.reach)) &&
        !node.replies.some((reply) => needsAnswer(reply.incidence)),
    )
    .reduce((sum, node) => sum + clampUnit(node.own.reach), 0);
  const lost = gaps.reduce((sum, gap) => sum + gap.incidence, 0);
  return prepared + lost > 0 ? roundTo((100 * prepared) / (prepared + lost), 1) : null;
}

/**
 * Maps the mean concession of a variation's lines to the 1 to 99 scale: nothing conceded is 99,
 * `SOUNDNESS_FLOOR_CONCESSION_CP` or more is 1, and the scale is linear between.
 */
export function soundnessFromConcession(meanConcessionCp: number): number {
  const span = SOUNDNESS_TOP - SOUNDNESS_BOTTOM;
  const mapped = SOUNDNESS_TOP - (span * meanConcessionCp) / SOUNDNESS_FLOOR_CONCESSION_CP;
  return Math.min(SOUNDNESS_TOP, Math.max(SOUNDNESS_BOTTOM, mapped));
}

interface LineEndScore {
  reach: number;
  /** White's result in the games at the student's rating, 0 to 1. */
  result: number;
  concession: number;
}

function lineEndScoreOf(node: WalkNode): LineEndScore {
  const results = node.own.results;
  const games = gamesIn(results);
  return {
    reach: clampUnit(node.own.reach),
    result: results && games > 0 ? (results.wins + results.draws / 2) / games : 0,
    concession: node.concession,
  };
}

// Reads the counts and centipawn losses the generator stored on White's moves, nothing else: the
// explorer and the engine are never asked, so the numbers cost no network and move with no run.
function scoresOf(nodes: readonly WalkNode[]): CoverageScores {
  const ends = nodes.filter((node) => node.lineEnd).map(lineEndScoreOf);
  const weight = ends.reduce((sum, end) => sum + end.reach, 0);
  if (weight <= 0) return { line_ends: ends.length, expected_score: null, soundness: null };
  const weighted = (pick: (end: LineEndScore) => number): number =>
    ends.reduce((sum, end) => sum + end.reach * pick(end), 0) / weight;
  return {
    line_ends: ends.length,
    expected_score: roundTo(weighted((end) => end.result) * 100, 1),
    soundness: Math.round(soundnessFromConcession(weighted((end) => end.concession))),
  };
}

// The first position where Black's replies are not all fixed by the opening, which is where the
// student starts choosing; a variation stored only as far as its opening opens on its last position.
function startOf(nodes: readonly WalkNode[]): number {
  const first = nodes.findIndex((node) => node.replies.some((reply) => reply.source !== "setup"));
  return first >= 0 ? first : Math.max(0, nodes.length - 1);
}

function positionOf(node: WalkNode): CoveragePosition {
  return {
    line: positionLine(node),
    incidence: clampUnit(node.own.reach),
    parent: node.parent,
    replies: node.replies,
  };
}

/**
 * What a stored variation covers: the share of the games that end in a prepared line, the replies
 * that need an answer and have none, every position with Black's replies in it, and the two
 * scores. Null when there is no such variation. Read-only over the stored moves.
 */
export function repertoireCoverage(db: Database, repertoireId: number): RepertoireCoverage | null {
  if (!findDrillRepertoire(db, repertoireId)) return null;
  const nodes = new StoredTreeWalk(loadStoredTree(db, repertoireId)).run();
  const gaps = gapsOf(nodes);
  return {
    repertoire_id: repertoireId,
    goal_one_in: GOAL_ONE_IN,
    rating_band: EXPLORER_BAND_LABEL,
    covered_percent: coveredPercentOf(nodes, gaps),
    gaps,
    largest_gap: gaps[0] ?? null,
    scores: scoresOf(nodes),
    start: startOf(nodes),
    positions: nodes.map(positionOf),
  };
}
