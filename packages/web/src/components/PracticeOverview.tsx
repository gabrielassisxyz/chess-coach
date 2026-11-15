import type {
  ProgressResponse,
  PuzzleRatingHistoryResponse,
  ThemeStatsResponse,
  TrainingMode,
} from "@chess-coach/shared";
import type { ReactNode, Ref } from "react";
import type { Loaded } from "../hooks/useLoaded.js";
import {
  dueBreakdown,
  NEEDS_ENGINE_TEXT,
  NONE,
  nextBatchParts,
  percent,
} from "../state/practice.js";
import { ratingSparklinePoints } from "../state/puzzle-rating-api.js";
import type { ThemeStatsStarting } from "./PracticeThemeStats.js";
import { PracticeThemes } from "./PracticeThemes.js";
import { PracticeWeakness } from "./PracticeWeakness.js";

export interface HubStartProps {
  mode: TrainingMode;
  motif: string;
  idle: string;
  disabled?: boolean;
}

// A start button of the hub, which says Starting while its own start is in flight.
export type HubStartButton = (props: HubStartProps) => ReactNode;

export interface PracticeOverviewProps {
  progress: Loaded<ProgressResponse>;
  ratingHistory?: Loaded<PuzzleRatingHistoryResponse> | undefined;
  themeStats?: Loaded<ThemeStatsResponse> | undefined;
  engineMissing: boolean;
  startButton: HubStartButton;
  // The start in flight and the call that begins a puzzle queue, which the themes and the weakness
  // card draw their own controls with.
  starting: ThemeStatsStarting | null;
  onStart(mode: TrainingMode, motif: string): void;
  // The engine and coach problem cards, drawn under the title when they apply.
  problems?: ReactNode;
  // The alert of a refused start, when the start was pressed on this page.
  failure: ReactNode;
  // The themes section, which the Puzzle themes entry scrolls into view.
  themesRef: Ref<HTMLElement>;
  now: Date;
  // The panel of positions from the student's games, drawn beside the Due cards card.
  foundPanel?: ReactNode;
}

const ANY_MOTIF = "";

export function PracticePageHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="practice-page__head">
      <h2 className="screen__title">{title}</h2>
      {note ? <p className="screen__note">{note}</p> : null}
    </div>
  );
}

const dayWordOf = (days: number): string => (days === 1 ? "day" : "days");

const rotationText = (total: number): string =>
  `${total} ${total === 1 ? "card" : "cards"} in rotation`;

function ratePointsDelta(currentRate: number | null, previousRate: number | null): number | null {
  if (currentRate === null || previousRate === null) return null;
  return Math.round(currentRate * 100) - Math.round(previousRate * 100);
}

function TileDelta({ delta, period }: { delta: number | null; period: string }) {
  return (
    <>
      {delta !== null && delta !== 0 ? (
        <>
          {" "}
          <span className="practice-tile__delta" data-direction={delta > 0 ? "up" : "down"}>
            {delta > 0 ? `\u25b2 ${delta}` : `\u25bc ${Math.abs(delta)}`}
          </span>
        </>
      ) : null}{" "}
      <span className="practice-tile__unit">{period}</span>
    </>
  );
}

function DayStreakTile({ progress }: { progress: ProgressResponse }) {
  const { streak_days: streak, streak_best: best, activity_7d: activity } = progress;
  return (
    <div className="practice-tile">
      <dt>Day streak</dt>
      <dd className="practice-tile__value">
        <span className="practice-tile__figure">{streak}</span>{" "}
        <span className="practice-tile__unit">{`${dayWordOf(streak)} · best ${best}`}</span>
      </dd>
      <dd className="practice-tile__streak">
        <div className="practice-tile__streak-bars" role="img" aria-label="Last 7 days">
          {activity.map((active, index) => {
            const daysAgo = activity.length - 1 - index;
            return (
              <span
                key={`ago-${daysAgo}`}
                className="practice-tile__streak-day"
                data-active={active ? "true" : "false"}
                data-today={daysAgo === 0 ? "true" : "false"}
              />
            );
          })}
        </div>
      </dd>
    </div>
  );
}

function PuzzleRatingTile({
  rating,
  ratingHistory,
}: {
  rating: number;
  ratingHistory: Loaded<PuzzleRatingHistoryResponse> | undefined;
}) {
  const history = ratingHistory?.status === "ready" ? ratingHistory.value : null;
  const sparkPoints = history ? ratingSparklinePoints(history.points) : null;
  return (
    <div className="practice-tile">
      <dt>Puzzle rating</dt>
      <dd className="practice-tile__value">
        <span className="practice-tile__figure">{rating}</span>
        {history ? <TileDelta delta={history.change} period="7 days" /> : null}
      </dd>
      {sparkPoints ? (
        <dd className="practice-tile__visual">
          <svg
            className="practice-tile__spark"
            viewBox="0 0 200 28"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline
              points={sparkPoints}
              fill="none"
              stroke="var(--status-ready)"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </svg>
        </dd>
      ) : null}
    </div>
  );
}

function SolvedFirstTryTile({
  themeStats,
}: {
  themeStats: Loaded<ThemeStatsResponse> | undefined;
}) {
  const stats = themeStats?.status === "ready" ? themeStats.value : null;
  const current = stats && stats.overall.played > 0 ? stats.overall : null;
  const currentRate = current ? current.first_try / current.played : null;
  const previous =
    current && stats?.overall_previous && stats.overall_previous.played > 0
      ? stats.overall_previous
      : null;
  const previousRate = previous ? previous.first_try / previous.played : null;
  const solvedPct = currentRate !== null ? Math.round(currentRate * 100) : null;
  const delta = ratePointsDelta(currentRate, previousRate);

  return (
    <div className="practice-tile">
      <dt>Solved first try</dt>
      <dd className="practice-tile__value">
        <span className="practice-tile__figure">{solvedPct !== null ? `${solvedPct}%` : NONE}</span>
        {solvedPct !== null ? <TileDelta delta={delta} period="30 days" /> : null}
      </dd>
      {solvedPct !== null ? (
        <dd className="practice-tile__split" aria-hidden="true">
          <span className="practice-tile__split-solved" style={{ width: `${solvedPct}%` }} />
          <span className="practice-tile__split-rest" />
        </dd>
      ) : null}
    </div>
  );
}

function CardsRememberedTile({ cards }: { cards: ProgressResponse["cards"] }) {
  const delta = ratePointsDelta(cards.correct_rate_30d, cards.correct_rate_prev_30d);
  return (
    <div className="practice-tile">
      <dt>Cards remembered</dt>
      <dd className="practice-tile__value">
        <span className="practice-tile__figure">{percent(cards.correct_rate_30d)}</span>
        {cards.correct_rate_30d !== null ? <TileDelta delta={delta} period="30 days" /> : null}
      </dd>
      <dd className="practice-tile__note">{rotationText(cards.total)}</dd>
    </div>
  );
}

function OverviewTiles({
  progress,
  ratingHistory,
  themeStats,
}: {
  progress: ProgressResponse;
  ratingHistory: Loaded<PuzzleRatingHistoryResponse> | undefined;
  themeStats: Loaded<ThemeStatsResponse> | undefined;
}) {
  return (
    <dl className="practice-tiles">
      <DayStreakTile progress={progress} />
      <PuzzleRatingTile rating={progress.puzzle_rating} ratingHistory={ratingHistory} />
      <SolvedFirstTryTile themeStats={themeStats} />
      <CardsRememberedTile cards={progress.cards} />
    </dl>
  );
}

function forecastDayLabel(now: Date, offset: number): string {
  if (offset === 0) return "Today";
  // Anchor at local noon so DST shifts never roll a calendar date backwards or forwards.
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12);
  return day.toLocaleDateString("en-US", { weekday: "short" });
}

function DueForecast({ dueNext7d, now }: { dueNext7d: readonly number[]; now: Date }) {
  const max = Math.max(...dueNext7d, 1);
  return (
    <div className="practice-forecast">
      <p className="practice-forecast__title">Coming up · next 7 days</p>
      <div className="practice-forecast__bars">
        {dueNext7d.map((count, offset) => {
          const height = Math.max(2, Math.round((count / max) * 40));
          const label = forecastDayLabel(now, offset);
          return (
            <div
              key={label}
              className="practice-forecast__day"
              data-today={offset === 0 ? "true" : "false"}
            >
              <span className="practice-forecast__count">{count}</span>
              <span className="practice-forecast__bar" style={{ height: `${height}px` }} />
              <span className="practice-forecast__label">{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DueCards({ progress, now }: { progress: Loaded<ProgressResponse>; now: Date }) {
  if (progress.status === "loading") {
    return (
      <p className="practice__card-note" role="status">
        Loading your cards.
      </p>
    );
  }
  if (progress.status === "failed") {
    return (
      <>
        <p className="practice__failure" role="alert">
          Your card numbers could not be loaded.
        </p>
        <button type="button" className="button" onClick={progress.retry}>
          Try again
        </button>
      </>
    );
  }
  const { cards } = progress.value;
  const next = nextBatchParts(cards.next_due_at, cards.next_due_count, now);
  return (
    <>
      <p className="practice__due">
        <strong className="practice__due-count">{cards.due_now}</strong>
        {cards.due_now === 0 ? (
          <span> due, you're caught up</span>
        ) : (
          <span>
            {" "}
            due now
            {cards.due_from_games > 0
              ? ` · from ${cards.due_from_games} ${cards.due_from_games === 1 ? "game" : "games"}`
              : ""}
          </span>
        )}
      </p>
      <dl className="practice__facts">
        {dueBreakdown(cards.due_by_classification).map((entry) => (
          <div key={entry.key} className="practice__fact">
            <dt>{entry.label}</dt>
            <dd>{entry.count}</dd>
          </div>
        ))}
        {next ? (
          <div className="practice__fact">
            <dt>{next.label}</dt>
            <dd>{next.when}</dd>
          </div>
        ) : null}
      </dl>
      <DueForecast dueNext7d={cards.due_next_7d} now={now} />
    </>
  );
}

function dueButton(progress: Loaded<ProgressResponse>, startButton: HubStartButton): ReactNode {
  if (progress.status !== "ready") {
    return startButton({ mode: "srs", motif: ANY_MOTIF, idle: "Review due cards" });
  }
  const due = progress.value.cards.due_now;
  if (due === 0) return null;
  const idle = `Review ${due} ${due === 1 ? "card" : "cards"}`;
  return startButton({ mode: "srs", motif: ANY_MOTIF, idle });
}

// The page the hub opens on: the numbers at a glance, the due cards, then the puzzle themes.
export function PracticeOverview(props: PracticeOverviewProps) {
  const { progress, engineMissing, startButton } = props;
  return (
    <>
      <PracticePageHead
        title="Practice"
        note="Pick a session. The board appears once an item starts."
      />
      {props.problems}
      {progress.status === "ready" ? (
        <OverviewTiles
          progress={progress.value}
          ratingHistory={props.ratingHistory}
          themeStats={props.themeStats}
        />
      ) : null}
      <div className="practice-page__cards">
        <section className="practice__card" aria-label="Due cards">
          <h3 className="practice__card-title">Due cards</h3>
          <p className="practice__card-note">Spaced repetition on positions from your own games</p>
          <DueCards progress={progress} now={props.now} />
          {engineMissing ? <p className="practice__card-note">{NEEDS_ENGINE_TEXT}</p> : null}
          {dueButton(progress, startButton)}
        </section>
        <PracticeWeakness
          themeStats={props.themeStats}
          starting={props.starting}
          engineMissing={engineMissing}
          onStart={props.onStart}
        />
        {props.foundPanel}
      </div>
      <PracticeThemes
        themeStats={props.themeStats}
        starting={props.starting}
        engineMissing={engineMissing}
        onStart={props.onStart}
        themesRef={props.themesRef}
      />
      {props.failure}
    </>
  );
}
