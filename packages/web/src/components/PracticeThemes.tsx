import {
  PUZZLE_THEME_GROUPS,
  PUZZLE_THEMES,
  type PuzzleThemeEntry,
  type PuzzleThemeGroup,
  type ThemeStatsResponse,
  type TrainingMode,
} from "@chess-coach/shared";
import { type Ref, useId } from "react";
import type { Loaded } from "../hooks/useLoaded.js";
import { NEEDS_ENGINE_TEXT } from "../state/practice.js";
import {
  type FirstTryBarTone,
  firstTryBarToneOf,
  firstTryPercentOf,
} from "../state/theme-stats-api.js";
import type { ThemeStatsStarting } from "./PracticeThemeStats.js";

export interface PracticeThemesProps {
  themeStats: Loaded<ThemeStatsResponse> | undefined;
  starting: ThemeStatsStarting | null;
  engineMissing: boolean;
  onStart(mode: TrainingMode, motif: string): void;
  // The section, which the Puzzle themes entry of the navigation scrolls into view.
  themesRef: Ref<HTMLElement>;
}

// A puzzle start with no motif is the healthy mix.
const HEALTHY_MIX_MOTIF = "";

const HEALTHY_MIX_TEXT =
  "A bit of everything at your level, with more from your improvement areas. No hint of what is coming, like a real game.";

const TABLE_THEME_KEYS: ReadonlySet<string> = new Set(PUZZLE_THEMES.map((entry) => entry.theme));

const THEMES_OF_GROUP: ReadonlyMap<PuzzleThemeGroup, readonly PuzzleThemeEntry[]> = new Map(
  PUZZLE_THEME_GROUPS.map((group) => [
    group,
    PUZZLE_THEMES.filter((entry) => entry.group === group),
  ]),
);

// What a tile says of its theme: its first-try share, "new" for a theme the answer does not list,
// and nothing while the answer is not known, since no figure would be true then.
type ThemeFigure = { kind: "rate"; percent: number; tone: FirstTryBarTone } | { kind: "new" };

function figuresOf(stats: ThemeStatsResponse | null): ReadonlyMap<string, ThemeFigure> {
  const figures = new Map<string, ThemeFigure>();
  if (stats === null) return figures;
  for (const entry of stats.themes) {
    const percent = firstTryPercentOf(entry);
    figures.set(entry.theme, { kind: "rate", percent, tone: firstTryBarToneOf(percent) });
  }
  return figures;
}

function noteOf(stats: ThemeStatsResponse | null): string {
  const note = "Your first-try rate per theme, last 30 days · grey: not tried yet";
  if (stats === null) return note;
  const tried = stats.themes.filter((entry) => TABLE_THEME_KEYS.has(entry.theme)).length;
  return `${note} · ${tried} of ${PUZZLE_THEMES.length} themes tried`;
}

type StartControls = Pick<PracticeThemesProps, "starting" | "engineMissing" | "onStart">;

const isStarting = (starting: ThemeStatsStarting | null, motif: string): boolean =>
  starting?.mode === "puzzles" && starting.motif === motif;

function HealthyMix({
  stats,
  starting,
  engineMissing,
  onStart,
}: StartControls & { stats: ThemeStatsResponse | null }) {
  const played = stats?.overall.played ?? 0;
  return (
    <button
      type="button"
      className="healthy-mix"
      disabled={starting !== null || engineMissing}
      onClick={() => onStart("puzzles", HEALTHY_MIX_MOTIF)}
    >
      <span className="healthy-mix__text">
        <span className="healthy-mix__title">Healthy mix</span>{" "}
        <span className="healthy-mix__desc">{HEALTHY_MIX_TEXT}</span>
      </span>{" "}
      {stats !== null && played > 0 ? (
        <>
          <span className="healthy-mix__rate">{`${firstTryPercentOf(stats.overall)}%`}</span>{" "}
        </>
      ) : null}
      <span className="healthy-mix__start">
        {isStarting(starting, HEALTHY_MIX_MOTIF) ? "Starting" : "Start"}
      </span>
    </button>
  );
}

function TileStat({ figure, starting }: { figure: ThemeFigure | undefined; starting: boolean }) {
  if (starting) return <span className="theme-tile__stat">Starting</span>;
  if (figure?.kind === "rate") {
    return (
      <span className="theme-tile__stat" data-tone={figure.tone}>
        {`${figure.percent}%`}
      </span>
    );
  }
  if (figure?.kind === "new") {
    return (
      <span className="theme-tile__stat" data-tone="new">
        new
      </span>
    );
  }
  return null;
}

function ThemeTile({
  theme,
  figure,
  starting,
  engineMissing,
  onStart,
}: StartControls & { theme: PuzzleThemeEntry; figure: ThemeFigure | undefined }) {
  return (
    <button
      type="button"
      className="theme-tile"
      data-theme={theme.theme}
      disabled={starting !== null || engineMissing}
      onClick={() => onStart("puzzles", theme.theme)}
    >
      <span className="theme-tile__name">{theme.name}</span>{" "}
      <TileStat figure={figure} starting={isStarting(starting, theme.theme)} />{" "}
      <span className="theme-tile__desc">{theme.description}</span>
    </button>
  );
}

function ThemeGroup({
  group,
  figures,
  ...controls
}: StartControls & { group: PuzzleThemeGroup; figures: ReadonlyMap<string, ThemeFigure> | null }) {
  const headingId = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: these are the themes of one kind, not form fields; a fieldset would present them as a form
    <div className="theme-tiles__group" role="group" aria-labelledby={headingId}>
      <h4 className="theme-tiles__group-title" id={headingId}>
        {group}
      </h4>
      <div className="theme-tiles__grid">
        {(THEMES_OF_GROUP.get(group) ?? []).map((theme) => (
          <ThemeTile
            key={theme.theme}
            theme={theme}
            figure={figures === null ? undefined : (figures.get(theme.theme) ?? { kind: "new" })}
            {...controls}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The Overview's Puzzle themes section: the healthy mix and one tile for each of the 54 themes of
 * the table, grouped as the table groups them, each starting its own queue.
 */
export function PracticeThemes({
  themeStats,
  starting,
  engineMissing,
  onStart,
  themesRef,
}: PracticeThemesProps) {
  const titleId = useId();
  const stats = themeStats?.status === "ready" ? themeStats.value : null;
  const figures = stats === null ? null : figuresOf(stats);
  const controls = { starting, engineMissing, onStart };
  return (
    <section className="practice-page__section" aria-labelledby={titleId} ref={themesRef}>
      <div className="theme-tiles__head">
        <h3 className="practice-page__section-title" id={titleId}>
          Puzzle themes
        </h3>
        <p className="theme-tiles__note">{noteOf(stats)}</p>
      </div>
      {engineMissing ? <p className="practice__card-note">{NEEDS_ENGINE_TEXT}</p> : null}
      <HealthyMix stats={stats} {...controls} />
      {PUZZLE_THEME_GROUPS.map((group) => (
        <ThemeGroup key={group} group={group} figures={figures} {...controls} />
      ))}
    </section>
  );
}
