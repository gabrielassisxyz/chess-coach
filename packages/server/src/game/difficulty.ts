import { MAX_ELO, MIN_ELO } from "../engine/play.js";

export type StudentOutcome = "win" | "draw" | "loss";

export const STREAK_STEP = 50;
export const STREAK_LENGTH = 2;

export interface StreakAdjustment {
  toElo: number;
  reason: "streak_up" | "streak_down";
}

/** `recent` is newest first. A draw breaks a streak; a streak that cannot move the level changes nothing. */
export function streakAdjustment(
  currentElo: number,
  recent: StudentOutcome[],
): StreakAdjustment | null {
  const lastTwo = recent.slice(0, STREAK_LENGTH);
  if (lastTwo.length < STREAK_LENGTH) return null;
  const up = lastTwo.every((outcome) => outcome === "win");
  const down = lastTwo.every((outcome) => outcome === "loss");
  if (!up && !down) return null;
  const target = currentElo + (up ? STREAK_STEP : -STREAK_STEP);
  const toElo = Math.min(MAX_ELO, Math.max(MIN_ELO, target));
  if (toElo === currentElo) return null;
  return { toElo, reason: up ? "streak_up" : "streak_down" };
}
