import type {
  PuzzleRatingWindow,
  ThemeStatsEntry,
  ThemeStatsResponse,
  TrainingMode,
} from "@chess-coach/shared";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { Loaded } from "../hooks/useLoaded.js";
import { NEEDS_ENGINE_TEXT } from "../state/practice.js";
import { signedCount } from "../state/practice-item.js";
import {
  DEFAULT_THEME_WINDOW,
  type FetchThemeStats,
  fetchThemeStatsFromServer,
  firstTryBarToneOf,
  firstTryPercentOf,
  mostPlayedThemeOf,
  THEME_WINDOW_OPTIONS,
  themeDisplayOf,
} from "../state/theme-stats-api.js";

export type ThemeStatsPageKind = "improvement-areas" | "strengths";

export interface ThemeStatsStarting {
  mode: TrainingMode;
  motif: string;
}

export interface PracticeThemeStatsProps {
  kind: ThemeStatsPageKind;
  shown: boolean;
  fetchThemeStats?: FetchThemeStats | undefined;
  starting: ThemeStatsStarting | null;
  engineMissing: boolean;
  onStart(mode: TrainingMode, motif: string): void;
  failure: ReactNode;
}

const ANY_MOTIF = "";

const PAGE_TITLE: Readonly<Record<ThemeStatsPageKind, string>> = {
  "improvement-areas": "Improvement areas",
  strengths: "Strengths",
};

function subtitleOf(kind: ThemeStatsPageKind, overallRating: number | null): string {
  const yardstick = overallRating === null ? "rating" : String(overallRating);
  if (kind === "improvement-areas") {
    return `Themes where your rating is furthest below your overall ${yardstick}. Train these first. Up to 8 themes, each with 8 or more played.`;
  }
  return `Themes where your rating is furthest above your overall ${yardstick}. Up to 8 themes, each with 8 or more played.`;
}

/** Empty-state guidance shared by Dashboard cards, the Improvement areas / Strengths pages and the Overview weakness card. */
export function emptyThemeMessageOf(kind: ThemeStatsPageKind, data: ThemeStatsResponse): string {
  if (data.overall.played === 0 || data.themes.length === 0) {
    return "No puzzle played in this period yet.";
  }
  if (data.themes.some((entry) => entry.ranked)) {
    return kind === "improvement-areas"
      ? "No ranked theme sits below your overall rating yet."
      : "No ranked theme sits above your overall rating yet.";
  }
  const closest = mostPlayedThemeOf(data.themes);
  if (!closest) {
    return "No theme is ranked yet. A theme is ranked once you have played 8 puzzles of it.";
  }
  const { name } = themeDisplayOf(closest.theme);
  return `No theme is ranked yet. A theme is ranked once you have played 8 puzzles of it; your most played theme, ${name}, has ${closest.played}.`;
}

// The name the Overview weakness card imports; same copy as the Dashboard cards use.
export const emptyMessageOf = emptyThemeMessageOf;

/** Tracks lazy page activation and the selected time window (`7`, `30`, `90`, `all`). */
export function useActivatedWindow(shown: boolean): {
  activated: boolean;
  days: PuzzleRatingWindow;
  selectWindow(next: PuzzleRatingWindow): void;
} {
  const [activated, setActivated] = useState(shown);
  const [days, setDays] = useState<PuzzleRatingWindow>(DEFAULT_THEME_WINDOW);

  useEffect(() => {
    if (shown) setActivated(true);
  }, [shown]);

  const selectWindow = useCallback((next: PuzzleRatingWindow): void => {
    setDays((current) => (current === next ? current : next));
  }, []);

  return { activated, days, selectWindow };
}

/** Lazy-loads a windowed resource once activated, refetching when `days` changes or `retry` runs. */
export function useWindowedResource<T>(
  activated: boolean,
  days: PuzzleRatingWindow,
  fetcher: (days: PuzzleRatingWindow) => Promise<T>,
): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback((): void => {
    setLoaded({ status: "loading" });
    setAttempt((count) => count + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger
  useEffect(() => {
    if (!activated) return;
    let live = true;
    setLoaded((current) => (current.status === "failed" ? { status: "loading" } : current));
    fetcher(days).then(
      (value) => live && setLoaded({ status: "ready", value }),
      () => live && setLoaded({ status: "failed", retry }),
    );
    return () => {
      live = false;
    };
  }, [activated, days, attempt, fetcher, retry]);

  return loaded;
}

/** Windowed period selector (`7 days`, `30 days`, `90 days`, `All`). */
export function ThemeTimeWindow({
  days,
  onSelect,
}: {
  days: PuzzleRatingWindow;
  onSelect(next: PuzzleRatingWindow): void;
}) {
  return (
    <fieldset className="practice-themes__period" aria-label="Time window">
      {THEME_WINDOW_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="practice-themes__period-button"
          aria-pressed={option.value === days}
          onClick={() => onSelect(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

/** Column header row shared by Dashboard theme cards and theme detail pages. */
export function ThemeTableHeader({
  showTrain = true,
  solvedLabel = "Solved first try",
}: {
  showTrain?: boolean;
  solvedLabel?: string;
}) {
  return (
    <div className="practice-themes__table-head" aria-hidden="true">
      <span>Theme</span>
      <span className="practice-themes__played-col">Played</span>
      <span className="practice-themes__rating-head">Rating</span>
      <span>{solvedLabel}</span>
      {showTrain ? <span /> : null}
    </div>
  );
}

/** Theme statistics row showing name/description, volume, rating delta, solved-first-try bar, and optional Train button. */
export function ThemeRow({
  entry,
  overallRating,
  starting,
  engineMissing,
  onTrain,
}: {
  entry: ThemeStatsEntry;
  overallRating: number | null;
  starting: ThemeStatsStarting | null;
  engineMissing: boolean;
  onTrain?: (theme: string) => void;
}) {
  const { name, description } = themeDisplayOf(entry.theme);
  const delta = overallRating === null ? null : entry.performance - overallRating;
  const pct = firstTryPercentOf(entry);
  const tone = firstTryBarToneOf(pct);
  const isStartingMine = starting?.mode === "puzzles" && starting.motif === entry.theme;

  return (
    <li className="practice-themes__row" data-theme={entry.theme}>
      <div className="practice-themes__name-col">
        <span className="practice-themes__name">{name}</span>
        {description ? <span className="practice-themes__desc">{description}</span> : null}
      </div>
      <span className="practice-themes__played">{entry.played}</span>
      <div className="practice-themes__rating-col">
        <span className="practice-themes__rating">{entry.performance}</span>
        {delta !== null ? (
          <span className="practice-themes__delta" data-direction={delta >= 0 ? "up" : "down"}>
            {signedCount(delta)}
          </span>
        ) : null}
      </div>
      <div className="practice-themes__solved-col">
        <span className="practice-themes__bar" aria-hidden="true">
          <span
            className="practice-themes__bar-fill"
            data-tone={tone}
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className="practice-themes__pct">{`${pct}%`}</span>
      </div>
      {onTrain ? (
        <button
          type="button"
          className="button practice-themes__train"
          disabled={starting !== null || engineMissing}
          onClick={() => onTrain(entry.theme)}
        >
          {isStartingMine ? "Starting" : "Train"}
        </button>
      ) : null}
    </li>
  );
}

/** Ranked theme statistics page: either Improvement areas or Strengths, selectable by window. */
export function PracticeThemeStats({
  kind,
  shown,
  fetchThemeStats = fetchThemeStatsFromServer,
  starting,
  engineMissing,
  onStart,
  failure,
}: PracticeThemeStatsProps) {
  const { activated, days, selectWindow } = useActivatedWindow(shown);
  const loaded = useWindowedResource(activated, days, fetchThemeStats);
  const title = PAGE_TITLE[kind];
  const overallRating = loaded.status === "ready" ? loaded.value.overall.performance : null;
  const subtitle = subtitleOf(kind, overallRating);

  let rows: ThemeStatsEntry[] = [];
  if (loaded.status === "ready") {
    const byTheme = new Map(loaded.value.themes.map((entry) => [entry.theme, entry]));
    const keys =
      kind === "improvement-areas" ? loaded.value.improvement_areas : loaded.value.strengths;
    rows = keys
      .map((key) => byTheme.get(key))
      .filter((entry): entry is ThemeStatsEntry => entry !== undefined);
  }

  const isStartingMix = starting?.mode === "puzzles" && starting.motif === ANY_MOTIF;

  return (
    <>
      <div className="practice-themes__top">
        <div className="practice-themes__heading">
          <h2 className="screen__title">{title}</h2>
          <p className="screen__note">{subtitle}</p>
        </div>
        <ThemeTimeWindow days={days} onSelect={selectWindow} />
      </div>
      {failure}
      <div className="practice-themes__panel">
        {loaded.status === "loading" ? (
          <p className="practice-themes__state" role="status">
            Loading your theme statistics.
          </p>
        ) : null}
        {loaded.status === "failed" ? (
          <div className="practice-themes__state-box">
            <p className="practice__failure" role="alert">
              Your theme statistics could not be loaded.
            </p>
            <button type="button" className="button" onClick={loaded.retry}>
              Try again
            </button>
          </div>
        ) : null}
        {loaded.status === "ready" ? (
          <>
            <ThemeTableHeader />
            {rows.length > 0 ? (
              <ul className="practice-themes__list" aria-label={title}>
                {rows.map((entry) => (
                  <ThemeRow
                    key={entry.theme}
                    entry={entry}
                    overallRating={overallRating}
                    starting={starting}
                    engineMissing={engineMissing}
                    onTrain={(theme) => onStart("puzzles", theme)}
                  />
                ))}
              </ul>
            ) : (
              <div className="practice-themes__empty">
                <p className="practice-themes__message">
                  {emptyThemeMessageOf(kind, loaded.value)}
                </p>
                <button
                  type="button"
                  className="button"
                  disabled={starting !== null || engineMissing}
                  onClick={() => onStart("puzzles", ANY_MOTIF)}
                >
                  {isStartingMix ? "Starting" : "Start a healthy mix"}
                </button>
              </div>
            )}
          </>
        ) : null}
      </div>
      {loaded.status === "ready" && rows.length > 0 ? (
        <p className="practice-themes__footnote">
          {`${loaded.value.unranked} of the ${loaded.value.themes.length} themes you played have fewer than 8 puzzles and are not ranked yet.`}
        </p>
      ) : null}
      {engineMissing ? <p className="practice__card-note">{NEEDS_ENGINE_TEXT}</p> : null}
    </>
  );
}
