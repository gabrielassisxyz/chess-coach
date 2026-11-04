import type { Database } from "better-sqlite3";
import type { Classification, PlayerMoveEvaluation } from "../engine/evaluate.js";

export type PlayerColor = "white" | "black";
export type GamePhase = "player_turn" | "evaluating" | "engine_turn" | "finished";
export type GameResult = "1-0" | "0-1" | "1/2-1/2";
export type Termination = "checkmate" | "stalemate" | "draw" | "resign" | "abort";

export interface GameRecord {
  id: number;
  coachSessionId: number | null;
  startedAt: string;
  finishedAt: string | null;
  playerColor: PlayerColor;
  targetElo: number;
  initialFen: string;
  phase: GamePhase;
  result: GameResult | null;
  termination: Termination | null;
  pgn: string;
}

export interface NewMove {
  ply: number;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  isPlayer: boolean;
}

export interface MoveRecord extends NewMove {
  id: number;
  gameId: number;
  evalBeforeCp: number | null;
  evalAfterCp: number | null;
  cpLoss: number | null;
  classification: Classification | null;
  bestMoveUci: string | null;
  bestMoveSan: string | null;
}

export interface Finish {
  result: GameResult | null;
  termination: Termination;
  finishedAt: string;
}

export interface TurnCompletion {
  gameId: number;
  evaluation: { ply: number; value: PlayerMoveEvaluation } | null;
  engineMove: NewMove | null;
  pgn: string;
  finish: Finish | null;
}

interface GameRow {
  id: number;
  coach_session_id: number | null;
  started_at: string;
  finished_at: string | null;
  player_color: PlayerColor;
  target_elo: number;
  initial_fen: string;
  phase: GamePhase;
  result: GameResult | null;
  termination: Termination | null;
  pgn: string;
}

interface MoveRow {
  id: number;
  game_id: number;
  ply: number;
  san: string;
  uci: string;
  fen_before: string;
  fen_after: string;
  is_player: number;
  eval_before_cp: number | null;
  eval_after_cp: number | null;
  cp_loss: number | null;
  classification: Classification | null;
  best_move_uci: string | null;
  best_move_san: string | null;
}

function toGame(row: GameRow): GameRecord {
  return {
    id: row.id,
    coachSessionId: row.coach_session_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    playerColor: row.player_color,
    targetElo: row.target_elo,
    initialFen: row.initial_fen,
    phase: row.phase,
    result: row.result,
    termination: row.termination,
    pgn: row.pgn,
  };
}

function toMove(row: MoveRow): MoveRecord {
  return {
    id: row.id,
    gameId: row.game_id,
    ply: row.ply,
    san: row.san,
    uci: row.uci,
    fenBefore: row.fen_before,
    fenAfter: row.fen_after,
    isPlayer: row.is_player === 1,
    evalBeforeCp: row.eval_before_cp,
    evalAfterCp: row.eval_after_cp,
    cpLoss: row.cp_loss,
    classification: row.classification,
    bestMoveUci: row.best_move_uci,
    bestMoveSan: row.best_move_san,
  };
}

export function createGame(
  db: Database,
  input: {
    playerColor: PlayerColor;
    targetElo: number;
    initialFen: string;
    phase: GamePhase;
    startedAt: string;
    coachSessionId?: number;
  },
): GameRecord {
  const row = db
    .prepare(
      `INSERT INTO games (coach_session_id, started_at, player_color, target_elo, initial_fen, phase)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.coachSessionId ?? null,
      input.startedAt,
      input.playerColor,
      input.targetElo,
      input.initialFen,
      input.phase,
    );
  return toGame(row as GameRow);
}

export function getGame(db: Database, id: number): GameRecord | undefined {
  const row = db.prepare("SELECT * FROM games WHERE id = ?").get(id);
  return row ? toGame(row as GameRow) : undefined;
}

export function findLatestGame(db: Database): GameRecord | undefined {
  const row = db.prepare("SELECT * FROM games ORDER BY id DESC LIMIT 1").get();
  return row ? toGame(row as GameRow) : undefined;
}

export function listMoves(db: Database, gameId: number): MoveRecord[] {
  const rows = db.prepare("SELECT * FROM moves WHERE game_id = ? ORDER BY ply ASC").all(gameId);
  return (rows as MoveRow[]).map(toMove);
}

// Every mutation opens with this guard so a finished game rejects the whole transaction, not one statement.
function requireUnfinished(db: Database, gameId: number, phase: GamePhase): void {
  const changed = db
    .prepare("UPDATE games SET phase = ? WHERE id = ? AND finished_at IS NULL")
    .run(phase, gameId).changes;
  if (changed !== 1) throw new Error(`game ${gameId} is finished or missing`);
}

function insertMove(db: Database, gameId: number, move: NewMove): void {
  db.prepare(
    `INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after, is_player)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (game_id, ply) DO NOTHING`,
  ).run(gameId, move.ply, move.san, move.uci, move.fenBefore, move.fenAfter, move.isPlayer ? 1 : 0);
}

export function setPhase(db: Database, gameId: number, phase: GamePhase): void {
  db.transaction(() => requireUnfinished(db, gameId, phase))();
}

/** Persists the student's ply and flips to `evaluating` together; a duplicate ply throws. */
export function recordPlayerMove(db: Database, gameId: number, move: NewMove, pgn: string): void {
  db.transaction(() => {
    requireUnfinished(db, gameId, "evaluating");
    db.prepare(
      `INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after, is_player)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(gameId, move.ply, move.san, move.uci, move.fenBefore, move.fenAfter);
    db.prepare("UPDATE games SET pgn = ? WHERE id = ?").run(pgn, gameId);
  })();
}

export function completeTurn(db: Database, input: TurnCompletion): void {
  db.transaction(() => {
    requireUnfinished(db, input.gameId, input.finish ? "finished" : "player_turn");
    if (input.evaluation) {
      const { ply, value } = input.evaluation;
      db.prepare(
        `UPDATE moves SET eval_before_cp = ?, eval_after_cp = ?, cp_loss = ?, classification = ?,
           best_move_uci = ?, best_move_san = ? WHERE game_id = ? AND ply = ?`,
      ).run(
        value.evalBeforeCp,
        value.evalAfterCp,
        value.cpLoss,
        value.classification,
        value.bestMoveUci,
        value.bestMoveSan,
        input.gameId,
        ply,
      );
    }
    if (input.engineMove) insertMove(db, input.gameId, input.engineMove);
    db.prepare("UPDATE games SET pgn = ? WHERE id = ?").run(input.pgn, input.gameId);
    if (input.finish) writeFinish(db, input.gameId, input.finish);
  })();
}

function writeFinish(db: Database, gameId: number, finish: Finish): void {
  db.prepare("UPDATE games SET finished_at = ?, result = ?, termination = ? WHERE id = ?").run(
    finish.finishedAt,
    finish.result,
    finish.termination,
    gameId,
  );
}

export function finishGame(db: Database, gameId: number, finish: Finish, pgn: string): void {
  db.transaction(() => {
    requireUnfinished(db, gameId, "finished");
    db.prepare("UPDATE games SET pgn = ? WHERE id = ?").run(pgn, gameId);
    writeFinish(db, gameId, finish);
  })();
}

/** Drops the last `count` plies and returns the game to `player_turn`. */
export function removeLastPlies(db: Database, gameId: number, count: number, pgn: string): void {
  db.transaction(() => {
    requireUnfinished(db, gameId, "player_turn");
    db.prepare(
      `DELETE FROM moves WHERE game_id = ? AND ply > (SELECT MAX(ply) FROM moves WHERE game_id = ?) - ?`,
    ).run(gameId, gameId, count);
    db.prepare("UPDATE games SET pgn = ? WHERE id = ?").run(pgn, gameId);
  })();
}
