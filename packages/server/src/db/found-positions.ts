import type { PositionPhase } from "../openings/game-phase.js";
import type { PlayerColor } from "./games.js";
import type { Database } from "./open.js";

/** Which rules found a position this run, and whether it can be drilled. */
export interface FoundPositionVerdict {
  phase: PositionPhase;
  fromMistake: boolean;
  fromRepeat: boolean;
  fromDeparture: boolean;
  listed: boolean;
}

/** How often the student reached a position, and the game shown beside it. */
export interface FoundPositionCounts {
  reachedGames: number;
  bestGames: number;
  lastReachedAt: string;
  gameId: number;
  ply: number;
}

export interface FoundPosition extends FoundPositionVerdict, FoundPositionCounts {
  id: string;
  fen: string;
  color: PlayerColor;
  /** The moves the search accepts, best first; set when the position is first stored. */
  acceptedUci: string[];
  firstFoundAt: string;
}

interface FoundPositionRow {
  id: string;
  fen: string;
  color: PlayerColor;
  phase: PositionPhase;
  from_mistake: number;
  from_repeat: number;
  from_departure: number;
  accepted_uci: string;
  listed: number;
  reached_games: number;
  best_games: number;
  last_reached_at: string;
  game_id: number;
  ply: number;
  first_found_at: string;
}

function toFoundPosition(row: FoundPositionRow): FoundPosition {
  return {
    id: row.id,
    fen: row.fen,
    color: row.color,
    phase: row.phase,
    fromMistake: row.from_mistake === 1,
    fromRepeat: row.from_repeat === 1,
    fromDeparture: row.from_departure === 1,
    acceptedUci: JSON.parse(row.accepted_uci) as string[],
    listed: row.listed === 1,
    reachedGames: row.reached_games,
    bestGames: row.best_games,
    lastReachedAt: row.last_reached_at,
    gameId: row.game_id,
    ply: row.ply,
    firstFoundAt: row.first_found_at,
  };
}

export function getFoundPosition(db: Database, id: string): FoundPosition | null {
  const row = db.prepare("SELECT * FROM found_positions WHERE id = ?").get(id);
  return row ? toFoundPosition(row as FoundPositionRow) : null;
}

export function listFoundPositions(db: Database): FoundPosition[] {
  const rows = db.prepare("SELECT * FROM found_positions ORDER BY id").all();
  return (rows as FoundPositionRow[]).map(toFoundPosition);
}

/** What the From my games list and its drill narrow the positions to; each filter is optional. */
export interface FoundPositionFilter {
  color?: PlayerColor | undefined;
  phase?: PositionPhase | undefined;
  /** One position by its id; one that is not listed matches nothing. */
  position?: string | undefined;
  /**
   * One opening: a full name matches it exactly, a value with no colon matches the family
   * (the text before the first colon of the stored name) instead. An opening nothing stored
   * carries matches nothing.
   */
  opening?: string | undefined;
}

/** A listed position with its puzzle's header and the schedule the drill keeps for it. */
export interface ListedFoundPosition extends FoundPosition {
  motif: string;
  difficulty: string;
  openingName: string | null;
  /** When the drill asks for it again; null while no drill has rated it, which makes it new. */
  nextReviewAt: string | null;
}

interface ListedFoundPositionRow extends FoundPositionRow {
  motif: string;
  difficulty: string;
  opening_name: string | null;
  next_review_at: string | null;
}

const filterParams = (filter: FoundPositionFilter) => ({
  color: filter.color ?? null,
  phase: filter.phase ?? null,
  position: filter.position ?? null,
  opening: filter.opening ?? null,
});

// The family of a stored opening name, as `openingFamilyOf` reads it: the text before its first
// colon, trimmed, or the whole name when it holds none. Null stays null so it never matches.
const STORED_OPENING_FAMILY =
  "TRIM(SUBSTR(p.opening_name, 1, CASE WHEN INSTR(p.opening_name, ':') > 0 THEN INSTR(p.opening_name, ':') - 1 ELSE LENGTH(p.opening_name) END))";

// A full opening name matches it exactly; a value with no colon matches the family instead.
// The value reaches SQL only as the bound `@opening`.
const OPENING_MATCH = `(p.opening_name = @opening OR (INSTR(@opening, ':') = 0 AND p.opening_name IS NOT NULL AND ${STORED_OPENING_FAMILY} = @opening))`;

/**
 * The positions the list shows and the drill serves, read once for both so they never disagree.
 * A position is served through its puzzle, so one whose puzzle is gone is left out of both.
 */
export function listListedFoundPositions(
  db: Database,
  filter: FoundPositionFilter,
): ListedFoundPosition[] {
  const rows = db
    .prepare(
      `SELECT f.*, p.motif, p.difficulty, p.opening_name, c.next_review_at
       FROM found_positions f
       JOIN puzzles p ON p.id = f.id
       LEFT JOIN found_cards c ON c.position_id = f.id
       WHERE f.listed = 1 AND (@color IS NULL OR f.color = @color)
         AND (@phase IS NULL OR f.phase = @phase) AND (@position IS NULL OR f.id = @position)
         AND (@opening IS NULL OR ${OPENING_MATCH})
       ORDER BY f.id`,
    )
    .all(filterParams(filter)) as ListedFoundPositionRow[];
  return rows.map((row) => ({
    ...toFoundPosition(row),
    motif: row.motif,
    difficulty: row.difficulty,
    openingName: row.opening_name,
    nextReviewAt: row.next_review_at,
  }));
}

/** The candidates kept out of the list under the same filters: the ones with `listed = 0`. */
export function countUnlistedFoundPositions(
  db: Database,
  filter: Omit<FoundPositionFilter, "position">,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS unlisted FROM found_positions f LEFT JOIN puzzles p ON p.id = f.id
       WHERE f.listed = 0 AND (@color IS NULL OR f.color = @color) AND (@phase IS NULL OR f.phase = @phase)
         AND (@opening IS NULL OR ${OPENING_MATCH})`,
    )
    .get({
      color: filter.color ?? null,
      phase: filter.phase ?? null,
      opening: filter.opening ?? null,
    }) as { unlisted: number };
  return row.unlisted;
}

const verdictParams = (verdict: FoundPositionVerdict) => ({
  phase: verdict.phase,
  fromMistake: verdict.fromMistake ? 1 : 0,
  fromRepeat: verdict.fromRepeat ? 1 : 0,
  fromDeparture: verdict.fromDeparture ? 1 : 0,
  listed: verdict.listed ? 1 : 0,
});

export function insertFoundPosition(db: Database, position: FoundPosition): void {
  db.prepare(
    `INSERT INTO found_positions
       (id, fen, color, phase, from_mistake, from_repeat, from_departure, accepted_uci, listed,
        reached_games, best_games, last_reached_at, game_id, ply, first_found_at)
     VALUES (@id, @fen, @color, @phase, @fromMistake, @fromRepeat, @fromDeparture, @acceptedUci,
        @listed, @reachedGames, @bestGames, @lastReachedAt, @gameId, @ply, @firstFoundAt)`,
  ).run({
    ...position,
    ...verdictParams(position),
    acceptedUci: JSON.stringify(position.acceptedUci),
  });
}

/** Everything a run refreshes on a stored position; its fen and accepted moves stay as stored. */
export function refreshFoundPosition(
  db: Database,
  id: string,
  verdict: FoundPositionVerdict,
  counts: FoundPositionCounts | null,
): void {
  db.prepare(
    `UPDATE found_positions SET phase = @phase, from_mistake = @fromMistake,
       from_repeat = @fromRepeat, from_departure = @fromDeparture, listed = @listed
     WHERE id = @id`,
  ).run({ id, ...verdictParams(verdict) });
  if (!counts) return;
  db.prepare(
    `UPDATE found_positions SET reached_games = @reachedGames, best_games = @bestGames,
       last_reached_at = @lastReachedAt, game_id = @gameId, ply = @ply
     WHERE id = @id`,
  ).run({ id, ...counts });
}
