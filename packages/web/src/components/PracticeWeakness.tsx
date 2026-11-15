import {
  MIX_PRACTICE_MOTIF,
  type ThemeStatsEntry,
  type ThemeStatsResponse,
  type TrainingMode,
} from "@chess-coach/shared";
import { useState } from "react";
import type { Loaded } from "../hooks/useLoaded.js";
import { NEEDS_ENGINE_TEXT } from "../state/practice.js";
import { firstTryBarToneOf, firstTryPercentOf, themeDisplayOf } from "../state/theme-stats-api.js";
import { emptyThemeMessageOf, type ThemeStatsStarting } from "./PracticeThemeStats.js";

export interface PracticeWeaknessProps {
  themeStats: Loaded<ThemeStatsResponse> | undefined;
  starting: ThemeStatsStarting | null;
  engineMissing: boolean;
  onStart(mode: TrainingMode, motif: string): void;
}

const WEAKNESS_ROWS = 5;

// A puzzle start with no motif is the healthy mix.
const HEALTHY_MIX_MOTIF = "";

function weakestThemesOf(stats: ThemeStatsResponse): ThemeStatsEntry[] {
  const byTheme = new Map(stats.themes.map((entry) => [entry.theme, entry]));
  return stats.improvement_areas
    .slice(0, WEAKNESS_ROWS)
    .map((key) => byTheme.get(key))
    .filter((entry): entry is ThemeStatsEntry => entry !== undefined);
}

function noteOf(themeStats: Loaded<ThemeStatsResponse> | undefined): string {
  const overall = themeStats?.status === "ready" ? themeStats.value.overall.performance : null;
  const yardstick = overall === null ? "rating" : String(overall);
  return `Your rating per theme vs your overall ${yardstick} · last 30 days · only themes with 8 or more played`;
}

function WeaknessRow({
  entry,
  selected,
  onPick,
}: {
  entry: ThemeStatsEntry;
  selected: boolean;
  onPick(theme: string): void;
}) {
  const { name } = themeDisplayOf(entry.theme);
  const percent = firstTryPercentOf(entry);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of the card is a button; the radio semantics say that one of them is chosen
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${name}, rating ${entry.performance}, ${percent}% solved first try`}
      className="practice-weakness__row"
      onClick={() => onPick(entry.theme)}
    >
      <span className="practice-weakness__name">{name}</span>
      <span className="practice-weakness__rating">{entry.performance}</span>
      <span className="practice-weakness__bar" aria-hidden="true">
        <span
          className="practice-weakness__bar-fill"
          data-tone={firstTryBarToneOf(percent)}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="practice-weakness__percent">{`${percent}%`}</span>
    </button>
  );
}

function WeaknessActions({
  chosen,
  starting,
  engineMissing,
  onStart,
}: PracticeWeaknessProps & { chosen: ThemeStatsEntry }) {
  const busy = starting !== null || engineMissing;
  const isStarting = (motif: string): boolean =>
    starting?.mode === "puzzles" && starting.motif === motif;
  const { name } = themeDisplayOf(chosen.theme);
  return (
    <div className="practice-weakness__actions">
      <button
        type="button"
        className="button button--primary"
        disabled={busy}
        onClick={() => onStart("puzzles", chosen.theme)}
      >
        {isStarting(chosen.theme) ? "Starting" : `Train ${name.toLowerCase()}`}
      </button>
      <button
        type="button"
        className="button"
        disabled={busy}
        onClick={() => onStart("puzzles", MIX_PRACTICE_MOTIF)}
      >
        {isStarting(MIX_PRACTICE_MOTIF) ? "Starting" : "Mix practice"}
      </button>
    </div>
  );
}

function WeaknessEmpty({
  stats,
  starting,
  engineMissing,
  onStart,
}: PracticeWeaknessProps & { stats: ThemeStatsResponse }) {
  const mixing = starting?.mode === "puzzles" && starting.motif === HEALTHY_MIX_MOTIF;
  return (
    <>
      <p className="practice__card-note">{emptyThemeMessageOf("improvement-areas", stats)}</p>
      <button
        type="button"
        className="button"
        disabled={starting !== null || engineMissing}
        onClick={() => onStart("puzzles", HEALTHY_MIX_MOTIF)}
      >
        {mixing ? "Starting" : "Start a healthy mix"}
      </button>
    </>
  );
}

function WeaknessRows(props: PracticeWeaknessProps & { rows: ThemeStatsEntry[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const { rows } = props;
  const chosen = rows.find((entry) => entry.theme === picked) ?? (rows[0] as ThemeStatsEntry);
  return (
    <>
      <div className="practice-weakness__table">
        <div className="practice-weakness__head" aria-hidden="true">
          <span>Theme</span>
          <span className="practice-weakness__head-rating">Rating</span>
          <span>Solved</span>
          <span />
        </div>
        <div className="practice-weakness__rows" role="radiogroup" aria-label="Theme to train">
          {rows.map((entry) => (
            <WeaknessRow
              key={entry.theme}
              entry={entry}
              selected={entry.theme === chosen.theme}
              onPick={setPicked}
            />
          ))}
        </div>
      </div>
      <WeaknessActions {...props} chosen={chosen} />
    </>
  );
}

function WeaknessBody(props: PracticeWeaknessProps) {
  const { themeStats } = props;
  if (themeStats === undefined || themeStats.status === "loading") {
    return (
      <p className="practice__card-note" role="status">
        Loading your theme statistics.
      </p>
    );
  }
  if (themeStats.status === "failed") {
    return (
      <>
        <p className="practice__failure" role="alert">
          Your theme statistics could not be loaded.
        </p>
        <button type="button" className="button" onClick={themeStats.retry}>
          Try again
        </button>
      </>
    );
  }
  const rows = weakestThemesOf(themeStats.value);
  if (rows.length === 0) return <WeaknessEmpty {...props} stats={themeStats.value} />;
  return <WeaknessRows {...props} rows={rows} />;
}

/** The Overview's card of the student's weakest themes of the last 30 days, and what trains them. */
export function PracticeWeakness(props: PracticeWeaknessProps) {
  return (
    <section className="practice__card practice-weakness" aria-label="Puzzles by weakness">
      <h3 className="practice__card-title">Puzzles by weakness</h3>
      <p className="practice__card-note">{noteOf(props.themeStats)}</p>
      <WeaknessBody {...props} />
      {props.engineMissing ? <p className="practice__card-note">{NEEDS_ENGINE_TEXT}</p> : null}
    </section>
  );
}
