import type { Clock } from "../clock.js";
import { type StudentOutcome, streakAdjustment } from "../game/difficulty.js";
import type { Database } from "./open.js";

export type DifficultyReason = "streak_up" | "streak_down" | "coach" | "student";

export interface DifficultyChange {
  from_elo: number;
  to_elo: number;
  reason: DifficultyReason;
  changed_at: string;
  game_id: number | null;
}

export function getCurrentElo(db: Database): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'current_elo'").get() as
    | { value: string }
    | undefined;
  if (!row) throw new Error("settings has no current_elo row");
  return Number(row.value);
}

/** Moves the level and logs why; a no-op move is not a change and writes nothing. */
export function changeDifficulty(
  db: Database,
  input: { toElo: number; reason: DifficultyReason; gameId?: number; note?: string },
  clock: Clock,
): DifficultyChange | null {
  return db.transaction((): DifficultyChange | null => {
    const fromElo = getCurrentElo(db);
    if (fromElo === input.toElo) return null;
    const changedAt = clock.now().toISOString();
    db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'current_elo'").run(
      String(input.toElo),
      changedAt,
    );
    db.prepare(
      `INSERT INTO difficulty_changes (changed_at, from_elo, to_elo, reason, game_id, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(changedAt, fromElo, input.toElo, input.reason, input.gameId ?? null, input.note ?? null);
    return {
      from_elo: fromElo,
      to_elo: input.toElo,
      reason: input.reason,
      changed_at: changedAt,
      game_id: input.gameId ?? null,
    };
  })();
}

export function lastDifficultyChange(
  db: Database,
): { to_elo: number; reason: DifficultyReason; changed_at: string } | null {
  const row = db
    .prepare("SELECT to_elo, reason, changed_at FROM difficulty_changes ORDER BY id DESC LIMIT 1")
    .get() as { to_elo: number; reason: DifficultyReason; changed_at: string } | undefined;
  return row ?? null;
}

// Games against the engine only: imported games say nothing about the engine's level, and an
// aborted game has no result.
function recentOutcomes(db: Database, limit: number): StudentOutcome[] {
  const rows = db
    .prepare(
      `SELECT result, player_color FROM games
       WHERE source = 'coach' AND finished_at IS NOT NULL AND result IS NOT NULL
       ORDER BY finished_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as { result: string; player_color: "white" | "black" }[];
  return rows.map((row) => {
    if (row.result === "1/2-1/2") return "draw";
    const whiteWon = row.result === "1-0";
    return whiteWon === (row.player_color === "white") ? "win" : "loss";
  });
}

/** Call inside the finish transaction, after the game's own result is written. */
export function applyStreakAdjustment(
  db: Database,
  gameId: number,
  clock: Clock,
): DifficultyChange | null {
  const adjustment = streakAdjustment(getCurrentElo(db), recentOutcomes(db, 2));
  if (!adjustment) return null;
  return changeDifficulty(
    db,
    { toElo: adjustment.toElo, reason: adjustment.reason, gameId },
    clock,
  );
}
