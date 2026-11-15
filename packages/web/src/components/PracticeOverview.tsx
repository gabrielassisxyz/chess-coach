import type { ProgressResponse, TrainingMode } from "@chess-coach/shared";
import { type ReactNode, type Ref, useId, useState } from "react";
import type { Loaded } from "../hooks/useLoaded.js";
import {
  dueBreakdown,
  type MotifCount,
  motifLabel,
  motifRows,
  NEEDS_ENGINE_TEXT,
  NONE,
  nextBatchParts,
  percent,
} from "../state/practice.js";

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
  motifs: Loaded<MotifCount[]>;
  engineMissing: boolean;
  startButton: HubStartButton;
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

// The numbers the progress answer already holds, one tile each.
function OverviewTiles({ progress }: { progress: ProgressResponse }) {
  const { streak_days: streak, puzzle_rating: rating, cards } = progress;
  return (
    <dl className="practice-tiles">
      <div className="practice-tile">
        <dt>Day streak</dt>
        <dd className="practice-tile__value">
          <span className="practice-tile__figure">{streak}</span>{" "}
          <span className="practice-tile__unit">{dayWordOf(streak)}</span>
        </dd>
      </div>
      <div className="practice-tile">
        <dt>Puzzle rating</dt>
        <dd className="practice-tile__value">
          <span className="practice-tile__figure">{rating}</span>
        </dd>
      </div>
      <div className="practice-tile">
        <dt>Cards remembered</dt>
        <dd className="practice-tile__value">
          <span className="practice-tile__figure">{percent(cards.correct_rate_30d)}</span>
        </dd>
        <dd className="practice-tile__note">{rotationText(cards.total)}</dd>
      </div>
    </dl>
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

function MotifStatus({ motifs }: { motifs: Loaded<MotifCount[]> }) {
  if (motifs.status === "loading") {
    return (
      <p className="practice__card-note" role="status">
        Loading motifs.
      </p>
    );
  }
  if (motifs.status === "failed") {
    return (
      <>
        <p className="practice__failure" role="alert">
          The motif list could not be loaded. You can still drill with Any motif.
        </p>
        <button type="button" className="button" onClick={motifs.retry}>
          Try again
        </button>
      </>
    );
  }
  if (motifs.value.length === 0) {
    return (
      <p className="practice__card-note" role="status">
        No puzzles are loaded. Restart the server to load the puzzle library.
      </p>
    );
  }
  return null;
}

interface MotifChoiceProps {
  name: string;
  value: string;
  count: number;
  rate?: number | null | undefined;
  attempts?: number | undefined;
  solved?: number | undefined;
  description: string | null;
  kind: "lichess" | "library";
  selected: boolean;
  onPick(value: string): void;
}

function motifRateText(rate: number | null, attempts: number, solved: number): string {
  if (rate === null) return "not tried yet";
  return `${percent(rate)} · ${solved} of ${attempts}`;
}

function MotifChoice({
  name,
  value,
  count,
  rate,
  attempts = 0,
  solved = 0,
  description,
  kind,
  selected,
  onPick,
}: MotifChoiceProps) {
  // A Lichess theme always has puzzles at the student's level once imported, so it stays
  // selectable even though the motif counts cover the library only.
  const empty = kind === "library" && count === 0;
  const accessibleName =
    kind === "lichess"
      ? `${name}, ${description ?? ""}`
      : rate === undefined || empty
        ? `${name}, ${count} puzzles`
        : `${name}, ${count} puzzles, ${motifRateText(rate, attempts, solved)}`;
  return (
    <label className="practice__motif" data-selected={selected} data-empty={empty}>
      <input
        type="radio"
        name="motif"
        aria-label={accessibleName}
        checked={selected}
        disabled={empty}
        onChange={() => onPick(value)}
      />
      <span className="practice__motif-name" aria-hidden="true">
        <span className="practice__motif-label">{name}</span>
        {description ? <span className="practice__motif-desc">{description}</span> : null}
      </span>
      {kind === "lichess" ? null : (
        <span className="practice__motif-count" aria-hidden="true">
          {empty ? NONE : count}
        </span>
      )}
      {kind === "lichess" || rate === undefined || empty ? null : (
        <span className="practice__motif-rate" aria-hidden="true">
          <span className="practice__bar" aria-hidden="true">
            <span style={{ width: `${Math.round((rate ?? 0) * 100)}%` }} />
          </span>
          {motifRateText(rate, attempts, solved)}
        </span>
      )}
    </label>
  );
}

function MotifCard({
  motifs,
  progress,
  startButton,
}: Pick<PracticeOverviewProps, "motifs" | "progress" | "startButton">) {
  const [motif, setMotif] = useState(ANY_MOTIF);
  const counts = motifs.status === "ready" ? motifs.value : [];
  const rows = motifRows(counts, progress.status === "ready" ? progress.value : null);
  return (
    <section className="practice__card" aria-label="Puzzles by motif">
      <h3 className="practice__card-title">Puzzles by motif</h3>
      <p className="practice__card-note">Solved first try, last 30 days.</p>
      <div className="practice__motifs" role="radiogroup" aria-label="Motif">
        <MotifChoice
          name="Any motif"
          value={ANY_MOTIF}
          count={0}
          description="A mix of everything at your level."
          kind="lichess"
          selected={motif === ANY_MOTIF}
          onPick={setMotif}
        />
        {rows.map((row) => (
          <MotifChoice
            key={row.motif}
            name={row.label}
            value={row.motif}
            count={row.count}
            rate={row.rate30d}
            attempts={row.attempts30d}
            solved={row.solved30d}
            description={row.description}
            kind={row.kind}
            selected={motif === row.motif}
            onPick={setMotif}
          />
        ))}
      </div>
      <MotifStatus motifs={motifs} />
      {startButton({
        mode: "puzzles",
        motif,
        idle: `Start ${motif === ANY_MOTIF ? "any motif" : motifLabel(motif)}`,
      })}
    </section>
  );
}

// The page the hub opens on: the numbers at a glance, the due cards, then the puzzle themes.
export function PracticeOverview(props: PracticeOverviewProps) {
  const { progress, engineMissing, startButton } = props;
  const themesTitle = useId();
  return (
    <>
      <PracticePageHead
        title="Practice"
        note="Pick a session. The board appears once an item starts."
      />
      {props.problems}
      {progress.status === "ready" ? <OverviewTiles progress={progress.value} /> : null}
      <div className="practice-page__cards">
        <section className="practice__card" aria-label="Due cards">
          <h3 className="practice__card-title">Due cards</h3>
          <p className="practice__card-note">Spaced repetition on positions from your own games</p>
          <DueCards progress={progress} now={props.now} />
          {engineMissing ? <p className="practice__card-note">{NEEDS_ENGINE_TEXT}</p> : null}
          {dueButton(progress, startButton)}
        </section>
        {props.foundPanel}
      </div>
      <section
        className="practice-page__section"
        aria-labelledby={themesTitle}
        ref={props.themesRef}
      >
        <h3 className="practice-page__section-title" id={themesTitle}>
          Puzzle themes
        </h3>
        <div className="practice-page__cards">
          <MotifCard motifs={props.motifs} progress={progress} startButton={startButton} />
        </div>
      </section>
      {props.failure}
    </>
  );
}
