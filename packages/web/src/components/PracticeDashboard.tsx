import type {
  PlayedOpeningsResponse,
  ProgressResponse,
  PuzzleRatingHistoryResponse,
  PuzzleRatingPoint,
  PuzzleRatingWindow,
  ThemeStatsResponse,
  TrainingMode,
} from "@chess-coach/shared";
import type { ReactNode } from "react";
import type { Loaded } from "../hooks/useLoaded.js";
import {
  type FetchOpeningsPlayed,
  fetchOpeningsPlayedFromServer,
  PLAYED_FAILED_TEXT,
  PLAYED_LOADING_TEXT,
  PLAYED_SECTION_EMPTY_TEXT,
  playedGamesText,
  playedSideText,
  topPlayedOpeningsOf,
} from "../state/openings-played-api.js";
import { NEEDS_ENGINE_TEXT, NONE } from "../state/practice.js";
import {
  type FetchPuzzleRatingHistory,
  fetchPuzzleRatingHistoryFromServer,
  ratingChartPoints,
} from "../state/puzzle-rating-api.js";
import {
  type FetchThemeStats,
  fetchThemeStatsFromServer,
  type ThemeStatsKind,
  themeRowsOf,
} from "../state/theme-stats-api.js";
import { PlayedBar, PlayedScore } from "./PracticeOpeningsPlayed.js";
import { TileDelta } from "./PracticeOverview.js";
import {
  emptyThemeMessageOf,
  ThemeRow,
  type ThemeStatsStarting,
  ThemeTableHeader,
  ThemeTimeWindow,
  useActivatedWindow,
  useWindowedResource,
} from "./PracticeThemeStats.js";

const DAY_MS = 86_400_000;
const DASHBOARD_THEME_LIMIT = 5;
const DASHBOARD_OPENINGS_LIMIT = 4;
const ANY_MOTIF = "";

export interface PracticeDashboardProps {
  shown: boolean;
  progress: Loaded<ProgressResponse>;
  fetchThemeStats?: FetchThemeStats | undefined;
  fetchRatingHistory?: FetchPuzzleRatingHistory | undefined;
  fetchOpeningsPlayed?: FetchOpeningsPlayed | undefined;
  starting: ThemeStatsStarting | null;
  engineMissing: boolean;
  onStart(mode: TrainingMode, motif: string): void;
  onOpenPage(page: ThemeStatsKind | "openings-played"): void;
  failure: ReactNode;
}

const THEME_CARD_META: Readonly<
  Record<ThemeStatsKind, { headingId: string; title: string; direction: "below" | "above" }>
> = {
  "improvement-areas": {
    headingId: "practice-dashboard-improvement-heading",
    title: "Improvement areas",
    direction: "below",
  },
  strengths: {
    headingId: "practice-dashboard-strengths-heading",
    title: "Strengths",
    direction: "above",
  },
};

function performanceDeltaOf(stats: ThemeStatsResponse, days: PuzzleRatingWindow): number | null {
  if (days === "all" || stats.overall.played === 0 || stats.overall.performance === null) {
    return null;
  }
  const previous = stats.overall_previous?.performance ?? null;
  if (previous === null) return null;
  return stats.overall.performance - previous;
}

function formatAllTimeStart(day: string): string {
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function chartStartLabel(points: readonly PuzzleRatingPoint[], days: PuzzleRatingWindow): string {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return "";
  if (days === "all") return formatAllTimeStart(first.day);
  const firstMs = Date.parse(`${first.day}T00:00:00Z`);
  const lastMs = Date.parse(`${last.day}T00:00:00Z`);
  const span =
    Number.isFinite(firstMs) && Number.isFinite(lastMs)
      ? Math.max(1, Math.round((lastMs - firstMs) / DAY_MS) + 1)
      : points.length;
  return span === 1 ? "1 day ago" : `${span} days ago`;
}

function DashboardTiles({
  themeStats,
  progress,
  days,
  starting,
  engineMissing,
  onStart,
}: {
  themeStats: Loaded<ThemeStatsResponse>;
  progress: Loaded<ProgressResponse>;
  days: PuzzleRatingWindow;
  starting: ThemeStatsStarting | null;
  engineMissing: boolean;
  onStart(mode: TrainingMode, motif: string): void;
}) {
  const readyStats = themeStats.status === "ready" ? themeStats.value : null;
  const hasPuzzles =
    readyStats !== null && readyStats.overall.played > 0 && readyStats.themes.length > 0;
  const rating = hasPuzzles && readyStats ? readyStats.overall.performance : null;
  const delta = hasPuzzles && readyStats ? performanceDeltaOf(readyStats, days) : null;
  const solvedPct =
    hasPuzzles && readyStats
      ? Math.round((readyStats.overall.first_try / readyStats.overall.played) * 100)
      : null;
  const due = progress.status === "ready" ? progress.value.cards.due_now : null;

  return (
    <dl className="practice-tiles practice-dashboard__tiles">
      <div className="practice-tile">
        <dt>Played</dt>
        <dd className="practice-tile__value">
          <span className="practice-tile__figure">
            {hasPuzzles && readyStats ? readyStats.overall.played : NONE}
          </span>
        </dd>
      </div>
      <div className="practice-tile">
        <dt>Performance rating</dt>
        <dd className="practice-tile__value">
          <span className="practice-tile__figure">{rating ?? NONE}</span>
          {delta !== null && delta !== 0 ? (
            <>
              {" "}
              <TileDelta delta={delta} />
            </>
          ) : null}
        </dd>
      </div>
      <div className="practice-tile">
        <dt>Solved first try</dt>
        <dd className="practice-tile__value">
          <span className="practice-tile__figure">
            {solvedPct !== null ? `${solvedPct}%` : NONE}
          </span>
        </dd>
        {solvedPct !== null ? (
          <dd className="practice-tile__split" aria-hidden="true">
            <span className="practice-tile__split-solved" style={{ width: `${solvedPct}%` }} />
            <span className="practice-tile__split-rest" />
          </dd>
        ) : null}
      </div>
      <div className="practice-tile">
        <dt>Due cards</dt>
        <dd className="practice-tile__value practice-dashboard__due-row">
          <span className="practice-tile__figure">{due ?? NONE}</span>
          {due !== null && due > 0 ? (
            <button
              type="button"
              className="practice-dashboard__link"
              disabled={starting !== null || engineMissing}
              onClick={() => onStart("srs", ANY_MOTIF)}
            >
              Review
            </button>
          ) : null}
        </dd>
      </div>
    </dl>
  );
}

function DashboardRatingCard({
  ratingHistory,
  days,
}: {
  ratingHistory: Loaded<PuzzleRatingHistoryResponse>;
  days: PuzzleRatingWindow;
}) {
  const ready = ratingHistory.status === "ready" ? ratingHistory.value : null;
  const polyline = ready ? ratingChartPoints(ready.points) : null;

  return (
    <section
      className="practice-dashboard__card"
      aria-labelledby="practice-dashboard-rating-heading"
    >
      <div className="practice-dashboard__card-head">
        <div className="practice-dashboard__rating-title">
          <h3 id="practice-dashboard-rating-heading" className="practice-dashboard__card-title">
            Puzzle rating
          </h3>
          {ready ? (
            <span className="practice-dashboard__rating-current">{ready.current}</span>
          ) : null}
        </div>
        {ready ? (
          <span className="practice-dashboard__card-meta">
            {`low ${ready.low} \u00b7 high ${ready.high}`}
          </span>
        ) : null}
      </div>
      {ratingHistory.status === "loading" ? (
        <p className="practice-dashboard__state" role="status">
          Loading your rating history.
        </p>
      ) : null}
      {ratingHistory.status === "failed" ? (
        <div className="practice-dashboard__state-box">
          <p className="practice__failure" role="alert">
            Your rating history could not be loaded.
          </p>
          <button type="button" className="button" onClick={ratingHistory.retry}>
            Try again
          </button>
        </div>
      ) : null}
      {ready ? (
        <>
          <svg
            className="practice-dashboard__chart"
            viewBox="0 0 600 120"
            preserveAspectRatio="none"
            role="img"
            aria-label="Puzzle rating over time"
          >
            <line x1="0" y1="60" x2="600" y2="60" stroke="var(--surface-2)" strokeWidth={1} />
            {polyline ? (
              <polyline
                fill="none"
                stroke="var(--accent)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={polyline}
              />
            ) : null}
          </svg>
          <div className="practice-dashboard__chart-axis">
            <span>{chartStartLabel(ready.points, days)}</span>
            <span>today</span>
          </div>
        </>
      ) : null}
    </section>
  );
}

function DashboardThemeCard({
  kind,
  themeStats,
  starting,
  engineMissing,
  onStart,
  onOpenPage,
}: {
  kind: ThemeStatsKind;
  themeStats: Loaded<ThemeStatsResponse>;
  starting: ThemeStatsStarting | null;
  engineMissing: boolean;
  onStart(mode: TrainingMode, motif: string): void;
  onOpenPage(kind: ThemeStatsKind): void;
}) {
  const meta = THEME_CARD_META[kind];
  const ready = themeStats.status === "ready" ? themeStats.value : null;
  const hasPuzzles = ready !== null && ready.overall.played > 0 && ready.themes.length > 0;
  const overallRating = hasPuzzles && ready ? ready.overall.performance : null;
  const yardstick = overallRating !== null ? String(overallRating) : "rating";
  const rows = hasPuzzles && ready ? themeRowsOf(kind, ready, DASHBOARD_THEME_LIMIT) : [];
  const isStartingMix = starting?.mode === "puzzles" && starting.motif === ANY_MOTIF;

  return (
    <section className="practice-dashboard__card" aria-labelledby={meta.headingId}>
      <div className="practice-dashboard__card-head">
        <div className="practice-dashboard__card-titles">
          <h3 id={meta.headingId} className="practice-dashboard__card-title">
            {meta.title}
          </h3>
          <p className="practice-dashboard__card-sub">
            {`Furthest ${meta.direction} your ${yardstick}`}
          </p>
        </div>
        <button type="button" className="practice-dashboard__link" onClick={() => onOpenPage(kind)}>
          See all
        </button>
      </div>
      {themeStats.status === "loading" ? (
        <p className="practice-dashboard__state" role="status">
          Loading your theme statistics.
        </p>
      ) : null}
      {themeStats.status === "failed" ? (
        <div className="practice-dashboard__state-box">
          <p className="practice__failure" role="alert">
            Your theme statistics could not be loaded.
          </p>
          <button type="button" className="button" onClick={themeStats.retry}>
            Try again
          </button>
        </div>
      ) : null}
      {ready ? (
        rows.length > 0 ? (
          <>
            <ThemeTableHeader showTrain={false} solvedLabel="Solved" />
            <ul className="practice-themes__list practice-dashboard__list" aria-label={meta.title}>
              {rows.map((entry) => (
                <ThemeRow
                  key={entry.theme}
                  entry={entry}
                  overallRating={overallRating}
                  starting={starting}
                  engineMissing={engineMissing}
                />
              ))}
            </ul>
          </>
        ) : (
          <div className="practice-themes__empty practice-dashboard__empty">
            <p className="practice-themes__message">{emptyThemeMessageOf(kind, ready)}</p>
            <button
              type="button"
              className="button"
              disabled={starting !== null || engineMissing}
              onClick={() => onStart("puzzles", ANY_MOTIF)}
            >
              {isStartingMix ? "Starting" : "Start a healthy mix"}
            </button>
          </div>
        )
      ) : null}
    </section>
  );
}

function DashboardOpeningsCard({
  openings,
  onOpenPage,
}: {
  openings: Loaded<PlayedOpeningsResponse>;
  onOpenPage(page: "openings-played"): void;
}) {
  const rows =
    openings.status === "ready"
      ? topPlayedOpeningsOf(openings.value, DASHBOARD_OPENINGS_LIMIT)
      : [];

  return (
    <section
      className="practice-dashboard__card"
      aria-labelledby="practice-dashboard-openings-heading"
    >
      <div className="practice-dashboard__card-head">
        <div className="practice-dashboard__card-titles">
          <h3 id="practice-dashboard-openings-heading" className="practice-dashboard__card-title">
            Openings played
          </h3>
          <p className="practice-dashboard__card-sub">
            Most frequent in your games · win / draw / loss
          </p>
        </div>
        <button
          type="button"
          className="practice-dashboard__link"
          onClick={() => onOpenPage("openings-played")}
        >
          See all
        </button>
      </div>
      {openings.status === "loading" ? (
        <p className="practice-dashboard__state" role="status">
          {PLAYED_LOADING_TEXT}
        </p>
      ) : null}
      {openings.status === "failed" ? (
        <div className="practice-dashboard__state-box">
          <p className="practice__failure" role="alert">
            {PLAYED_FAILED_TEXT}
          </p>
          <button type="button" className="button" onClick={openings.retry}>
            Try again
          </button>
        </div>
      ) : null}
      {openings.status === "ready" && rows.length === 0 ? (
        <p className="practice-dashboard__state">{PLAYED_SECTION_EMPTY_TEXT}</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="played-top" aria-label="Most played openings">
          {rows.map(({ side, section, opening }) => (
            <li key={`${side}/${section}/${opening.opening}`} className="played-top__row">
              <span className="played-top__name">{opening.opening}</span>
              <span className="played-top__side">{playedSideText(side)}</span>
              <span className="played-top__games">{playedGamesText(opening.games)}</span>
              <PlayedBar figures={opening} />
              <PlayedScore figures={opening} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Windowed Dashboard combining puzzle KPIs, rating trend chart, top improvement/strength themes and the most played openings. */
export function PracticeDashboard({
  shown,
  progress,
  fetchThemeStats = fetchThemeStatsFromServer,
  fetchRatingHistory = fetchPuzzleRatingHistoryFromServer,
  fetchOpeningsPlayed = fetchOpeningsPlayedFromServer,
  starting,
  engineMissing,
  onStart,
  onOpenPage,
  failure,
}: PracticeDashboardProps) {
  const { activated, days, selectWindow } = useActivatedWindow(shown);
  const themeStats = useWindowedResource(activated, days, fetchThemeStats);
  const ratingHistory = useWindowedResource(activated, days, fetchRatingHistory);
  const openingsPlayed = useWindowedResource(activated, days, fetchOpeningsPlayed);

  // The hub keeps every page mounted, so before the first visit there is no tile, chart or
  // theme row to duplicate the Overview's labels in hidden queries.
  if (!activated) {
    return (
      <div className="practice-dashboard">
        <div className="practice-themes__top">
          <div className="practice-themes__heading">
            <h2 className="screen__title">Dashboard</h2>
            <p className="screen__note">
              An overview of your puzzles and openings. Each block opens its own page.
            </p>
          </div>
          <ThemeTimeWindow days={days} onSelect={selectWindow} />
        </div>
        {failure}
      </div>
    );
  }

  return (
    <div className="practice-dashboard">
      <div className="practice-themes__top">
        <div className="practice-themes__heading">
          <h2 className="screen__title">Dashboard</h2>
          <p className="screen__note">
            An overview of your puzzles and openings. Each block opens its own page.
          </p>
        </div>
        <ThemeTimeWindow days={days} onSelect={selectWindow} />
      </div>
      {failure}
      <DashboardTiles
        themeStats={themeStats}
        progress={progress}
        days={days}
        starting={starting}
        engineMissing={engineMissing}
        onStart={onStart}
      />
      <DashboardRatingCard ratingHistory={ratingHistory} days={days} />
      <div className="practice-dashboard__themes">
        {(["improvement-areas", "strengths"] as const).map((kind) => (
          <DashboardThemeCard
            key={kind}
            kind={kind}
            themeStats={themeStats}
            starting={starting}
            engineMissing={engineMissing}
            onStart={onStart}
            onOpenPage={onOpenPage}
          />
        ))}
      </div>
      <DashboardOpeningsCard openings={openingsPlayed} onOpenPage={onOpenPage} />
      {engineMissing ? <p className="practice__card-note">{NEEDS_ENGINE_TEXT}</p> : null}
    </div>
  );
}
