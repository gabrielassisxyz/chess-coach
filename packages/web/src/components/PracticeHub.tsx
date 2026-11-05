import type { ProgressResponse, TrainingMode } from "@chess-coach/shared";
import { type ReactNode, useState } from "react";
import type { Loaded } from "../hooks/useLoaded.js";
import {
  DRILL_SIZES,
  type DrillSize,
  dueBreakdown,
  type MotifCount,
  motifRows,
  NONE,
  nextBatchParts,
  openingCount,
  percent,
} from "../state/practice.js";

const ANY_MOTIF = "";
const NEEDS_ENGINE = "Needs the engine to grade answers.";

export interface PracticeHubProps {
  progress: Loaded<ProgressResponse>;
  motifs: Loaded<MotifCount[]>;
  engineMissing: boolean;
  starting: { mode: TrainingMode; motif: string } | null;
  failure: string | null;
  size: DrillSize;
  onSize(size: DrillSize): void;
  onStart(mode: TrainingMode, motif: string): void;
  now?: Date;
}

interface StartProps {
  mode: TrainingMode;
  motif: string;
  idle: string;
  disabled?: boolean;
}

const sideName = (color: "white" | "black"): string => (color === "white" ? "White" : "Black");

function motifNote(motifs: Loaded<MotifCount[]>): string | null {
  if (motifs.status === "loading") return "Loading motifs.";
  if (motifs.status === "failed") {
    return "The motif list could not be loaded. You can still drill with Any motif.";
  }
  return motifs.value.length === 0
    ? "No puzzles are loaded. Restart the server to load the puzzle library."
    : null;
}

export function PracticeHub(props: PracticeHubProps) {
  const { progress, motifs, engineMissing, starting, failure, size, onSize, onStart } = props;
  const [motif, setMotif] = useState(ANY_MOTIF);
  const busy = starting !== null;
  const counts = motifs.status === "ready" ? motifs.value : [];
  const rows = motifRows(counts, progress.status === "ready" ? progress.value : null);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const note = motifNote(motifs);

  const startButton = ({ mode, motif: target, idle, disabled = false }: StartProps): ReactNode => {
    const mine = starting?.mode === mode && starting.motif === target;
    return (
      <button
        type="button"
        className="button button--primary"
        disabled={busy || engineMissing || disabled}
        onClick={() => onStart(mode, target)}
      >
        {mine ? "Starting" : idle}
      </button>
    );
  };

  return (
    <div className="practice__hub" aria-busy={busy}>
      <section className="practice__card" aria-label="Due cards">
        <h3 className="practice__card-title">Due cards</h3>
        <p className="practice__card-note">Spaced repetition on positions from your own games</p>
        <DueCards progress={progress} now={props.now ?? new Date()} />
        {engineMissing ? <p className="practice__card-note">{NEEDS_ENGINE}</p> : null}
        {dueButton(progress, startButton)}
      </section>

      <section className="practice__card" aria-label="Puzzles by motif">
        <h3 className="practice__card-title">Puzzles by motif</h3>
        <p className="practice__card-note">One pattern at a time. Accuracy is your last 30 days.</p>
        <div className="practice__motifs" role="radiogroup" aria-label="Motif">
          <MotifChoice
            name="Any motif"
            value={ANY_MOTIF}
            count={total}
            selected={motif === ANY_MOTIF}
            onPick={setMotif}
          />
          {rows.map((row) => (
            <MotifChoice
              key={row.motif}
              name={row.motif}
              value={row.motif}
              count={row.count}
              rate={row.rate30d}
              selected={motif === row.motif}
              onPick={setMotif}
            />
          ))}
        </div>
        {note ? <p role="status">{note}</p> : null}
        <fieldset className="practice__sizes" aria-label="Drill size">
          {DRILL_SIZES.map((option) => (
            <button
              key={option}
              type="button"
              className="button practice__size"
              aria-pressed={option === size}
              onClick={() => onSize(option)}
            >
              {option}
            </button>
          ))}
        </fieldset>
        {startButton({
          mode: "puzzles",
          motif,
          idle: `Start ${motif === ANY_MOTIF ? "any motif" : motif}`,
        })}
      </section>

      <section className="practice__card" aria-label="Opening drill">
        <h3 className="practice__card-title">Opening drill</h3>
        <p className="practice__card-note">
          Best move in the positions that actually occur in your games
        </p>
        {(["white", "black"] as const).map((color) => {
          const count = openingCount(counts, color);
          const known = motifs.status === "ready";
          return (
            <div className="practice__opening" key={color}>
              <span className="practice__opening-side">As {sideName(color)}</span>
              <span className="practice__opening-count">
                {known ? (count === 0 ? NONE : `${count} positions`) : ""}
              </span>
              {startButton({
                mode: "openings",
                motif: color,
                idle: `Drill as ${sideName(color)}`,
                disabled: known && count === 0,
              })}
            </div>
          );
        })}
        {engineMissing ? <p className="practice__card-note">{NEEDS_ENGINE}</p> : null}
      </section>

      {failure ? (
        <p className="practice__failure" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

function DueCards({ progress, now }: { progress: Loaded<ProgressResponse>; now: Date }) {
  if (progress.status !== "ready") {
    return (
      <p className="practice__card-note" role="status">
        {progress.status === "loading"
          ? "Loading your cards."
          : "Your card numbers are not available."}
      </p>
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
        <div className="practice__fact">
          <dt>Remembered, 30 days</dt>
          <dd>{percent(cards.correct_rate_30d)}</dd>
        </div>
      </dl>
    </>
  );
}

function dueButton(
  progress: Loaded<ProgressResponse>,
  startButton: (props: StartProps) => ReactNode,
): ReactNode {
  if (progress.status !== "ready") {
    return startButton({ mode: "srs", motif: ANY_MOTIF, idle: "Review due cards" });
  }
  const due = progress.value.cards.due_now;
  if (due === 0) return null;
  const idle = `Review ${due} ${due === 1 ? "card" : "cards"}`;
  return startButton({ mode: "srs", motif: ANY_MOTIF, idle });
}

interface MotifChoiceProps {
  name: string;
  value: string;
  count: number;
  rate?: number | null;
  selected: boolean;
  onPick(value: string): void;
}

function MotifChoice({ name, value, count, rate, selected, onPick }: MotifChoiceProps) {
  const empty = count === 0;
  return (
    <label className="practice__motif" data-selected={selected} data-empty={empty}>
      <input
        type="radio"
        name="motif"
        checked={selected}
        disabled={empty}
        onChange={() => onPick(value)}
      />
      <span className="practice__motif-name">{name}</span>
      <span className="practice__motif-count">{empty ? NONE : count}</span>
      {rate === undefined || empty ? null : (
        <span className="practice__motif-rate">
          <span className="practice__bar" aria-hidden="true">
            <span style={{ width: `${Math.round((rate ?? 0) * 100)}%` }} />
          </span>
          {percent(rate)}
        </span>
      )}
    </label>
  );
}
