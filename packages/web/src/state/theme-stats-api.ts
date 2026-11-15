import {
  isGoalOrLengthTheme,
  type PuzzleRatingWindow,
  puzzleThemeInfo,
  type ThemeStatsEntry,
  type ThemeStatsResponse,
  ThemeStatsResponseSchema,
} from "@chess-coach/shared";
import { motifLabel } from "./practice.js";

export type FetchThemeStats = (days: PuzzleRatingWindow) => Promise<ThemeStatsResponse>;

export const fetchThemeStatsFromServer: FetchThemeStats = async (days) => {
  const response = await fetch(`/api/puzzles/themes/stats?days=${encodeURIComponent(days)}`);
  if (!response.ok) throw new Error(`theme stats: ${response.status}`);
  return ThemeStatsResponseSchema.parse(await response.json());
};

export const THEME_WINDOW_OPTIONS: readonly { value: PuzzleRatingWindow; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "all", label: "All" },
];

export const DEFAULT_THEME_WINDOW: PuzzleRatingWindow = "30";

/** Return the UI name and one-line description for a Lichess theme key. */
export function themeDisplayOf(theme: string): { name: string; description: string } {
  return puzzleThemeInfo(theme) ?? { name: motifLabel(theme), description: "" };
}

/** Pick the most played rankable theme, falling back to any played theme if none is rankable. */
export function mostPlayedThemeOf(themes: readonly ThemeStatsEntry[]): ThemeStatsEntry | null {
  return themes.find((entry) => !isGoalOrLengthTheme(entry.theme)) ?? themes[0] ?? null;
}

export function firstTryPercentOf(entry: Pick<ThemeStatsEntry, "played" | "first_try">): number {
  if (entry.played <= 0) return 0;
  return Math.round((entry.first_try / entry.played) * 100);
}

export type FirstTryBarTone = "good" | "mid" | "low";

export function firstTryBarToneOf(percent: number): FirstTryBarTone {
  if (percent >= 70) return "good";
  if (percent >= 55) return "mid";
  return "low";
}

export type ThemeStatsKind = "improvement-areas" | "strengths";

/** Join ordered theme keys (`improvement_areas` or `strengths`) against `themes`, optionally capped. */
export function themeRowsOf(
  kind: ThemeStatsKind,
  data: ThemeStatsResponse,
  limit?: number,
): ThemeStatsEntry[] {
  const byTheme = new Map(data.themes.map((entry) => [entry.theme, entry]));
  const keys = kind === "improvement-areas" ? data.improvement_areas : data.strengths;
  const selected = limit === undefined ? keys : keys.slice(0, limit);
  return selected
    .map((key) => byTheme.get(key))
    .filter((entry): entry is ThemeStatsEntry => entry !== undefined);
}
