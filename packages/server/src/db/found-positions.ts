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
