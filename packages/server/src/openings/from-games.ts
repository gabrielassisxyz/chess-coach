import { createHash } from "node:crypto";
import { Chess } from "chess.js";
import { type Clock, systemClock } from "../clock.js";
import {
  type FoundPosition,
  type FoundPositionCounts,
  type FoundPositionVerdict,
  getFoundPosition,
  insertFoundPosition,
  listFoundPositions,
  refreshFoundPosition,
} from "../db/found-positions.js";
import type { PlayerColor } from "../db/games.js";
import type { Database } from "../db/open.js";
import { insertGeneratedPuzzle } from "../db/puzzles.js";
import { type Classification, EVALUATION_DEPTH } from "../engine/evaluate.js";
import { applyUci } from "../engine/moves.js";
import type { Searcher } from "../engine/uci.js";
import { type PositionPhase, positionPhaseOf } from "./game-phase.js";
import type { OpeningNames } from "./names.js";

export const OPENING_SOURCE = "own-games";
export const MAX_OPENING_PLY = 30;
/**
 * A drill asks one question with one answer: the runner-up must trail by at least this much. A line
 * closer to the best than this is as good an answer, so a position of the student's games accepts
 * its move too.
 */
export const MIN_CLEAR_GAP_CP = 30;
const FOUND_SEARCH_LINES = 5;
// A search with no cap fails 5 s past its limit, and one failure would end every rerun at the same
// position.
const FOUND_SEARCH_CAP_MS = 10_000;
// Five accepted moves is all the search returns, so there may be more good moves than it lists and
// no try could fairly be marked wrong.
const MAX_LISTED_ACCEPTED = 4;
// The opponent's 15th move at the latest, so the student answers it inside the opening.
const DEPARTURE_LAST_PLY = 29;
const MISTAKE_CLASSES: ReadonlySet<Classification> = new Set(["inaccuracy", "mistake", "blunder"]);

/** What one run over the graded games found; each count is of this run's candidates. */
export interface GenerationResult {
  /** Positions at least one rule found, stored before or not. */
  candidates: number;
  /** Those that can be drilled. */
  listed: number;
  fromMistake: number;
  fromRepeat: number;
  fromDeparture: number;
  /** Engine searches, one per candidate stored for the first time. */
  searched: number;
  /** `own:` puzzles written. */
  created: number;
}

export const noPositionsFound = (): GenerationResult => ({
  candidates: 0,
  listed: 0,
  fromMistake: 0,
  fromRepeat: 0,
  fromDeparture: 0,
  searched: 0,
  created: 0,
});

/** One time a graded game reached a position with the student to move. */
interface PositionVisit {
  gameId: number;
  /** The ply of the student's move from the position, whether the game went on to play it or not. */
  ply: number;
  fen: string;
  reachedAt: string;
  /** Null when the game ended there. */
  playedUci: string | null;
  classification: Classification | null;
  bestMoveUci: string | null;
  openingName: string | null;
}

interface GradedMoveRow {
  game_id: number;
  ply: number;
  uci: string;
  fen_before: string;
  fen_after: string;
  is_player: number;
  classification: Classification | null;
  best_move_uci: string | null;
  reached_at: string;
}

interface FoundCandidate {
  id: string;
  /** In game order, the first game first. */
  visits: PositionVisit[];
  fromMistake: boolean;
  fromRepeat: boolean;
  fromDeparture: boolean;
}

// Placement, side, castling and en passant: the move counters differ between games reaching one position.
export const positionKey = (fen: string): string => fen.split(" ").slice(0, 4).join(" ");

export const puzzleId = (key: string): string =>
  `own:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

const idOfFen = (fen: string): string => puzzleId(positionKey(fen));

const isMistakeVisit = (visit: PositionVisit): boolean =>
  visit.classification !== null && MISTAKE_CLASSES.has(visit.classification);

function readGradedMoves(db: Database): GradedMoveRow[] {
  return db
    .prepare(
      `SELECT m.game_id, m.ply, m.uci, m.fen_before, m.fen_after, m.is_player, m.classification,
              m.best_move_uci, COALESCE(g.played_at, g.finished_at, g.started_at) AS reached_at
       FROM moves m JOIN games g ON g.id = m.game_id
       WHERE g.grading = 'done' AND g.finished_at IS NOT NULL
       ORDER BY m.game_id, m.ply`,
    )
    .all() as GradedMoveRow[];
}

// The position before ply 1 is where the game starts, so it is never a visit. A game that ended on
// the opponent's move left the student to move in its last position.
function visitsOfGame(moves: readonly GradedMoveRow[], names?: OpeningNames): PositionVisit[] {
  const visits: PositionVisit[] = [];
  let openingName: string | null = null;
  const visit = (row: GradedMoveRow, fen: string, ply: number, played: boolean): PositionVisit => ({
    gameId: row.game_id,
    ply,
    fen,
    reachedAt: row.reached_at,
    playedUci: played ? row.uci : null,
    classification: played ? row.classification : null,
    bestMoveUci: played ? row.best_move_uci : null,
    openingName,
  });
  for (const row of moves) {
    openingName = names?.ofPosition(row.fen_before)?.name ?? openingName;
    if (row.is_player && row.ply >= 2) visits.push(visit(row, row.fen_before, row.ply, true));
  }
  const last = moves.at(-1);
  if (last && !last.is_player) {
    openingName = names?.ofPosition(last.fen_after)?.name ?? openingName;
    visits.push(visit(last, last.fen_after, last.ply + 1, false));
  }
  return visits;
}

function collectVisits(db: Database, names?: OpeningNames): Map<string, PositionVisit[]> {
  const byGame = new Map<number, GradedMoveRow[]>();
  for (const row of readGradedMoves(db)) {
    const moves = byGame.get(row.game_id) ?? [];
    moves.push(row);
    byGame.set(row.game_id, moves);
  }
  const byId = new Map<string, PositionVisit[]>();
  for (const moves of byGame.values()) {
    for (const visit of visitsOfGame(moves, names)) {
      const id = idOfFen(visit.fen);
      const visits = byId.get(id);
      if (visits) visits.push(visit);
      else byId.set(id, [visit]);
    }
  }
  return byId;
}

// The opponent's move left a stored unit when the walk ended on a Black move before the variation
// started, or on a Black reply the unit lacks. A Black game has no unit to leave. A walk that ended
// on the student's own move needs no check of the ply here: it leaves Black to move, a position no
// White game visits.
function readDepartureIds(db: Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT m.fen_after FROM repertoire_game_reviews r
       JOIN games g ON g.id = r.game_id
       JOIN moves m ON m.game_id = r.game_id AND m.ply = r.left_ply
       WHERE g.player_color = 'white' AND g.grading = 'done' AND g.finished_at IS NOT NULL
         AND r.left_ply <= ? AND r.outcome IN ('not_reached', 'reply_added', 'reply_not_stored')`,
    )
    .all(DEPARTURE_LAST_PLY) as Array<{ fen_after: string }>;
  return new Set(rows.map((row) => idOfFen(row.fen_after)));
}

function collectCandidates(
  visitsById: ReadonlyMap<string, PositionVisit[]>,
  departures: ReadonlySet<string>,
): FoundCandidate[] {
  const candidates: FoundCandidate[] = [];
  for (const [id, visits] of visitsById) {
    const fromMistake = visits.some(isMistakeVisit);
    const fromRepeat = new Set(visits.map((visit) => visit.gameId)).size >= 2;
    const fromDeparture = departures.has(id);
    if (fromMistake || fromRepeat || fromDeparture) {
      candidates.push({ id, visits, fromMistake, fromRepeat, fromDeparture });
    }
  }
  return candidates;
}

// The position's phase and its stored FEN come from its earliest ply, the first game on a tie.
function earliestVisit(visits: readonly PositionVisit[]): PositionVisit {
  return visits.reduce((earliest, visit) => (visit.ply < earliest.ply ? visit : earliest));
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The latest game first, the later import on the same date, and the earlier ply inside one game.
const byRecency = (a: PositionVisit, b: PositionVisit): number =>
  byText(b.reachedAt, a.reachedAt) || b.gameId - a.gameId || a.ply - b.ply;

function countsOf(visits: readonly PositionVisit[]): FoundPositionCounts {
  const recentFirst = [...visits].sort(byRecency);
  const latest = recentFirst[0] as PositionVisit;
  const shown = recentFirst.find(isMistakeVisit) ?? latest;
  const gamesWhere = (keep: (visit: PositionVisit) => boolean): number =>
    new Set(visits.filter(keep).map((visit) => visit.gameId)).size;
  return {
    reachedGames: gamesWhere(() => true),
    bestGames: gamesWhere((visit) => visit.classification === "best"),
    lastReachedAt: latest.reachedAt,
    gameId: shown.gameId,
    ply: shown.ply,
  };
}

// The search has to agree with the grading: every best move stored there is accepted, and no move
// the student played there as a mistake is.
function agreesWithGrading(visits: readonly PositionVisit[], accepted: readonly string[]): boolean {
  return visits.every((visit) => {
    if (visit.bestMoveUci !== null && !accepted.includes(visit.bestMoveUci)) return false;
    return !(
      isMistakeVisit(visit) &&
      visit.playedUci !== null &&
      accepted.includes(visit.playedUci)
    );
  });
}

// A repeat skips the checks, since the first moves of a game, where many moves are good, are kept.
function isListed(candidate: FoundCandidate, accepted: readonly string[]): boolean {
  if (accepted.length === 0) return false;
  if (candidate.fromRepeat) return true;
  return accepted.length <= MAX_LISTED_ACCEPTED && agreesWithGrading(candidate.visits, accepted);
}

function verdictOf(candidate: FoundCandidate, accepted: readonly string[]): FoundPositionVerdict {
  const earliest = earliestVisit(candidate.visits);
  return {
    phase: positionPhaseOf(earliest.fen, earliest.ply),
    fromMistake: candidate.fromMistake,
    fromRepeat: candidate.fromRepeat,
    fromDeparture: candidate.fromDeparture,
    listed: isListed(candidate, accepted),
  };
}

function sanOf(fen: string, uci: string): string | null {
  try {
    return applyUci(new Chess(fen), uci).san;
  } catch {
    return null;
  }
}

/** The first moves of the lines less than the clear gap below the best line, the best first. */
async function searchAcceptedMoves(engine: Searcher, fen: string): Promise<string[]> {
  const result = await engine.search({
    fen,
    depth: EVALUATION_DEPTH,
    multipv: FOUND_SEARCH_LINES,
    capMs: FOUND_SEARCH_CAP_MS,
  });
  const best = result.lines[0];
  const accepted: string[] = [];
  for (const line of result.lines) {
    const move = line.moves[0];
    if (!best || !move || best.score - line.score >= MIN_CLEAR_GAP_CP) continue;
    if (!accepted.includes(move) && sanOf(fen, move) !== null) accepted.push(move);
  }
  return accepted;
}

const colorOf = (fen: string): PlayerColor => (fen.split(" ")[1] === "w" ? "white" : "black");

function explanationFor(fen: string, accepted: readonly string[]): string {
  const [best, ...others] = accepted.map((uci) => sanOf(fen, uci));
  const also = others.length > 0 ? ` Also good: ${others.join(", ")}.` : "";
  return `From your games. Best: ${best}.${also}`;
}

// A puzzle already stored under the id, by the rule before this one included, keeps its row.
function insertListedPuzzle(
  db: Database,
  position: Pick<FoundPosition, "id" | "fen" | "acceptedUci">,
  phase: PositionPhase,
  openingName: string | null,
): boolean {
  const [best] = position.acceptedUci;
  const san = best === undefined ? null : sanOf(position.fen, best);
  if (best === undefined || san === null) return false;
  return insertGeneratedPuzzle(db, {
    id: position.id,
    source: OPENING_SOURCE,
    motif: `${phase}-${colorOf(position.fen)}`,
    difficulty: "beginner",
    fen: position.fen,
    solutionUci: [best],
    solutionSan: [san],
    explanation: explanationFor(position.fen, position.acceptedUci),
    openingName,
  });
}

interface FoundRun {
  db: Database;
  engine: Searcher;
  clock: Clock;
  result: GenerationResult;
}

function tally(result: GenerationResult, verdict: FoundPositionVerdict): void {
  result.candidates += 1;
  if (verdict.listed) result.listed += 1;
  if (verdict.fromMistake) result.fromMistake += 1;
  if (verdict.fromRepeat) result.fromRepeat += 1;
  if (verdict.fromDeparture) result.fromDeparture += 1;
}

// A stored position keeps its FEN and accepted moves, so it is searched once whatever the later games.
async function settleCandidate(run: FoundRun, candidate: FoundCandidate): Promise<void> {
  const { db } = run;
  const earliest = earliestVisit(candidate.visits);
  let searched: string[] | null = null;
  if (!getFoundPosition(db, candidate.id)) {
    searched = await searchAcceptedMoves(run.engine, earliest.fen);
    run.result.searched += 1;
  }
  const counts = countsOf(candidate.visits);
  const verdict = db.transaction((): FoundPositionVerdict => {
    // A run that overlapped this one may have stored the position during the search; its moves stand.
    const stored = getFoundPosition(db, candidate.id);
    const position = stored ?? {
      id: candidate.id,
      fen: earliest.fen,
      acceptedUci: searched ?? [],
    };
    const decided = verdictOf(candidate, position.acceptedUci);
    if (stored) refreshFoundPosition(db, candidate.id, decided, counts);
    else {
      insertFoundPosition(db, {
        ...position,
        ...decided,
        ...counts,
        color: colorOf(earliest.fen),
        firstFoundAt: run.clock.now().toISOString(),
      });
    }
    if (decided.listed && insertListedPuzzle(db, position, decided.phase, earliest.openingName)) {
      run.result.created += 1;
    }
    return decided;
  })();
  tally(run.result, verdict);
}

// A stored position that no rule finds any more, after a game was deleted by hand or reviewed again,
// stays stored with its search and leaves the list; its counts follow the games that still reach it.
function settleNoLongerFound(
  db: Database,
  found: ReadonlySet<string>,
  visitsById: ReadonlyMap<string, PositionVisit[]>,
): void {
  for (const stored of listFoundPositions(db)) {
    if (found.has(stored.id)) continue;
    if (!stored.fromMistake && !stored.fromRepeat && !stored.fromDeparture && !stored.listed)
      continue;
    const visits = visitsById.get(stored.id);
    const unflagged: FoundPositionVerdict = {
      phase: stored.phase,
      fromMistake: false,
      fromRepeat: false,
      fromDeparture: false,
      listed: false,
    };
    refreshFoundPosition(db, stored.id, unflagged, visits ? countsOf(visits) : null);
  }
}

/**
 * Records the positions worth practising from the student's graded games: the one before each of the
 * student's inaccuracies, mistakes and blunders, any position two games reached with the student to
 * move, and the one after the opponent's move that left a stored White unit. A new one is searched
 * once for the moves it accepts and, when it can be drilled, becomes a one-move `own:` puzzle. Each
 * position is committed on its own, so an interrupted run resumes by running again.
 */
export async function generateOpeningPuzzles(
  db: Database,
  engine: Searcher,
  names?: OpeningNames,
  clock: Clock = systemClock,
): Promise<GenerationResult> {
  const visitsById = collectVisits(db, names);
  const candidates = collectCandidates(visitsById, readDepartureIds(db));
  const run: FoundRun = { db, engine, clock, result: noPositionsFound() };
  for (const candidate of candidates) await settleCandidate(run, candidate);
  settleNoLongerFound(db, new Set(candidates.map((candidate) => candidate.id)), visitsById);
  return run.result;
}
