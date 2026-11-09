import type { Database } from "better-sqlite3";
import type { Classification, PlayerMoveEvaluation } from "../engine/evaluate.js";

export type PlayerColor = "white" | "black";
export type GamePhase = "player_turn" | "evaluating" | "engine_turn" | "finished";
export type GameResult = "1-0" | "0-1" | "1/2-1/2";
export type Termination = "checkmate" | "stalemate" | "draw" | "resign" | "abort";
export type GameSource = "coach" | "chesscom" | "lichess" | "pgn";
export type GradingState = "pending" | "running" | "done" | "failed";

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
  source: GameSource;
  sourceId: string | null;
  sourceUrl: string | null;
  opponent: string | null;
  studentRating: number | null;
  opponentRating: number | null;
  timeControl: string | null;
  playedAt: string | null;
  grading: GradingState;
}

export interface NewMove {
  ply: number;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  isPlayer: boolean;
  /** When the ply was played; imported games carry none. */
  createdAt?: string;
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
  /** Runs inside the same transaction, after the turn is written; a throw rolls the turn back too. */
  notify?: (db: Database) => void;
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
  source: GameSource;
  source_id: string | null;
  source_url: string | null;
  opponent: string | null;
  student_rating: number | null;
  opponent_rating: number | null;
  time_control: string | null;
  played_at: string | null;
  grading: GradingState;
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
    source: row.source,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    opponent: row.opponent,
    studentRating: row.student_rating,
    opponentRating: row.opponent_rating,
    timeControl: row.time_control,
    playedAt: row.played_at,
    grading: row.grading,
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

// Imported games are born finished, so "the game in play" is the unfinished one and nothing else.
export function findUnfinishedGame(db: Database): GameRecord | undefined {
  const row = db
    .prepare("SELECT * FROM games WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1")
    .get();
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
    `INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after, is_player, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (game_id, ply) DO NOTHING`,
  ).run(
    gameId,
    move.ply,
    move.san,
    move.uci,
    move.fenBefore,
    move.fenAfter,
    move.isPlayer ? 1 : 0,
    move.createdAt ?? null,
  );
}

export function setPhase(db: Database, gameId: number, phase: GamePhase): void {
  db.transaction(() => requireUnfinished(db, gameId, phase))();
}

/** Persists the student's ply and flips to `evaluating` together; a duplicate ply throws. */
export function recordPlayerMove(db: Database, gameId: number, move: NewMove, pgn: string): void {
  db.transaction(() => {
    requireUnfinished(db, gameId, "evaluating");
    db.prepare(
      `INSERT INTO moves (game_id, ply, san, uci, fen_before, fen_after, is_player, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(
      gameId,
      move.ply,
      move.san,
      move.uci,
      move.fenBefore,
      move.fenAfter,
      move.createdAt ?? null,
    );
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
    input.notify?.(db);
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

export function finishGame(
  db: Database,
  gameId: number,
  finish: Finish,
  pgn: string,
  notify?: (db: Database) => void,
): void {
  db.transaction(() => {
    requireUnfinished(db, gameId, "finished");
    db.prepare("UPDATE games SET pgn = ? WHERE id = ?").run(pgn, gameId);
    writeFinish(db, gameId, finish);
    notify?.(db);
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

export interface WorstMoment {
  ply: number;
  san: string;
  cpLoss: number;
  classification: Classification;
}

export interface GameSummaryRow {
  game: GameRecord;
  moveCount: number;
  gradedStudentMoves: number;
  accurateStudentMoves: number;
  worstMoment: WorstMoment | null;
  cardsCount: number;
  mistakesCount: number;
}

// A move counts as accurate at a cp loss of 30 or less; the counts stay raw so the caller owns the ratio.
export const ACCURATE_CP_LOSS = 30;

type SummarySqlRow = GameRow & {
  move_count: number;
  graded: number;
  accurate: number;
  worst: string | null;
  cards: number;
  mistakes: number;
};

// One statement per list so each game costs no extra query; the worst moment is the student ply with
// the largest loss, the earliest on a tie.
const SUMMARY_SELECT = `SELECT g.*,
    (SELECT COUNT(*) FROM moves m WHERE m.game_id = g.id) AS move_count,
    (SELECT COUNT(*) FROM moves m
      WHERE m.game_id = g.id AND m.is_player = 1 AND m.cp_loss IS NOT NULL) AS graded,
    (SELECT COUNT(*) FROM moves m
      WHERE m.game_id = g.id AND m.is_player = 1 AND m.cp_loss <= ?) AS accurate,
    (SELECT json_object('ply', m.ply, 'san', m.san, 'cp_loss', m.cp_loss,
        'classification', m.classification)
      FROM moves m WHERE m.game_id = g.id AND m.is_player = 1 AND m.cp_loss IS NOT NULL
      ORDER BY m.cp_loss DESC, m.ply ASC LIMIT 1) AS worst,
    (SELECT COUNT(*) FROM srs_cards c WHERE c.source_game_id = g.id) AS cards,
    (SELECT COUNT(*) FROM moves m
      WHERE m.game_id = g.id AND m.is_player = 1
        AND m.classification IN ('mistake', 'blunder')) AS mistakes
  FROM games g`;

function toSummary(row: SummarySqlRow): GameSummaryRow {
  const worst = row.worst
    ? (JSON.parse(row.worst) as {
        ply: number;
        san: string;
        cp_loss: number;
        classification: Classification;
      })
    : null;
  return {
    game: toGame(row),
    moveCount: row.move_count,
    gradedStudentMoves: row.graded,
    accurateStudentMoves: row.accurate,
    worstMoment: worst && {
      ply: worst.ply,
      san: worst.san,
      cpLoss: worst.cp_loss,
      classification: worst.classification,
    },
    cardsCount: row.cards,
    mistakesCount: row.mistakes,
  };
}

export function listFinishedGames(db: Database, limit: number): GameSummaryRow[] {
  const rows = db
    .prepare(`${SUMMARY_SELECT} WHERE g.finished_at IS NOT NULL ORDER BY g.id DESC LIMIT ?`)
    .all(ACCURATE_CP_LOSS, limit);
  return (rows as SummarySqlRow[]).map(toSummary);
}

export function getGameSummary(db: Database, id: number): GameSummaryRow | undefined {
  const row = db.prepare(`${SUMMARY_SELECT} WHERE g.id = ?`).get(ACCURATE_CP_LOSS, id);
  return row ? toSummary(row as SummarySqlRow) : undefined;
}

export interface ImportedGame {
  playerColor: PlayerColor;
  targetElo: number;
  initialFen: string;
  startedAt: string;
  finish: Finish;
  pgn: string;
  moves: NewMove[];
  source: Exclude<GameSource, "coach">;
  sourceId: string;
  sourceUrl: string | null;
  opponent: string | null;
  studentRating: number | null;
  opponentRating: number | null;
  timeControl: string | null;
  playedAt: string | null;
}

/** Stores a finished game and all its plies in one transaction; returns null when `sourceId` is known. */
export function insertImportedGame(db: Database, game: ImportedGame): number | null {
  return db.transaction((): number | null => {
    const row = db
      .prepare(
        `INSERT INTO games (started_at, finished_at, player_color, target_elo, initial_fen, phase, result,
           termination, pgn, source, source_id, source_url, opponent, student_rating, opponent_rating,
           time_control, played_at, grading)
         VALUES (?, ?, ?, ?, ?, 'finished', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
         ON CONFLICT DO NOTHING RETURNING id`,
      )
      .get(
        game.startedAt,
        game.finish.finishedAt,
        game.playerColor,
        game.targetElo,
        game.initialFen,
        game.finish.result,
        game.finish.termination,
        game.pgn,
        game.source,
        game.sourceId,
        game.sourceUrl,
        game.opponent,
        game.studentRating,
        game.opponentRating,
        game.timeControl,
        game.playedAt,
      ) as { id: number } | undefined;
    if (!row) return null;
    for (const move of game.moves) insertMove(db, row.id, move);
    return row.id;
  })();
}

export function recordMoveEvaluation(
  db: Database,
  moveId: number,
  value: PlayerMoveEvaluation,
): void {
  db.prepare(
    `UPDATE moves SET eval_before_cp = ?, eval_after_cp = ?, cp_loss = ?, classification = ?,
       best_move_uci = ?, best_move_san = ? WHERE id = ?`,
  ).run(
    value.evalBeforeCp,
    value.evalAfterCp,
    value.cpLoss,
    value.classification,
    value.bestMoveUci,
    value.bestMoveSan,
    moveId,
  );
}

export function setGrading(db: Database, gameId: number, grading: GradingState): void {
  db.prepare("UPDATE games SET grading = ? WHERE id = ?").run(grading, gameId);
}

/** The game the grader works on next: one interrupted mid-way first, then the oldest pending one. */
export function findGameToGrade(db: Database): GameRecord | undefined {
  const row = db
    .prepare(
      `SELECT * FROM games WHERE grading IN ('running', 'pending')
       ORDER BY grading = 'running' DESC, id ASC LIMIT 1`,
    )
    .get();
  return row ? toGame(row as GameRow) : undefined;
}

export interface GradingProgress {
  pending: number;
  failed: number;
  running: { gameId: number; gradedPlies: number; totalPlies: number } | null;
}

export function gradingProgress(db: Database): GradingProgress {
  const count = (state: GradingState): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM games WHERE grading = ?").get(state) as { n: number }).n;
  const running = db.prepare("SELECT id FROM games WHERE grading = 'running' LIMIT 1").get() as
    | { id: number }
    | undefined;
  const plies = (id: number) =>
    db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(cp_loss) AS graded FROM moves
         WHERE game_id = ? AND is_player = 1`,
      )
      .get(id) as { total: number; graded: number };
  const detail = running ? plies(running.id) : null;
  return {
    pending: count("pending"),
    failed: count("failed"),
    running:
      running && detail
        ? { gameId: running.id, gradedPlies: detail.graded, totalPlies: detail.total }
        : null,
  };
}

/** Which of these source ids are already stored, so a listing can mark them. */
export function getIdsBySource(db: Database, source: GameSource, ids: string[]): Set<string> {
  const find = db.prepare("SELECT 1 FROM games WHERE source = ? AND source_id = ?");
  return new Set(ids.filter((id) => find.get(source, id) !== undefined));
}
