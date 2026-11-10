import type {
  PausedTraining,
  ProgressResponse,
  RepertoireScope,
  RepertoireSummary,
  TrainingMode,
} from "@chess-coach/shared";
import { type ReactNode, useState } from "react";
import type { Loaded } from "../hooks/useLoaded.js";
import {
  DRILL_SIZES,
  type DrillSize,
  dueBreakdown,
  italianOpeningCount,
  type LastSession,
  lastSessionText,
  type MotifCount,
  motifLabel,
  motifRows,
  NONE,
  nextBatchParts,
  openingCount,
  percent,
  resumeLabelOf,
} from "../state/practice.js";
import type { AddOpening, FetchCoverage, FetchRepertoireList } from "../state/repertoires-api.js";
import { RepertoireMenu } from "./RepertoireMenu.js";

const ANY_MOTIF = "";
const NEEDS_ENGINE = "Needs the engine to grade answers.";

export interface PracticeHubProps {
  progress: Loaded<ProgressResponse>;
  motifs: Loaded<MotifCount[]>;
  repertoires: Loaded<RepertoireSummary[]>;
  engineMissing: boolean;
  // A repertoire start carries its scope in `motif` and names its repertoire.
  starting: { mode: TrainingMode; motif: string; repertoireId?: number } | null;
  failure: string | null;
  size: DrillSize;
  onSize(size: DrillSize): void;
  onStart(mode: TrainingMode, motif: string): void;
  onStartRepertoire(repertoireId: number, scope: RepertoireScope): void;
  now?: Date;
  lastSession?: LastSession | null;
  // The openings met in games and the call that builds a drill for one; the server's by default.
  fetchRepertoireList?: FetchRepertoireList | undefined;
  addOpening?: AddOpening | undefined;
  // Where a variation's coverage comes from when it is opened; the server's by default.
  fetchCoverage?: FetchCoverage | undefined;
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

function ItalianRow({
  counts,
  known,
  startButton,
}: {
  counts: MotifCount[];
  known: boolean;
  startButton: (props: StartProps) => ReactNode;
}): ReactNode {
  const count = italianOpeningCount(counts);
  const empty = known && count === 0;
  return (
    <div className="practice__opening" key="italian">
      <span className="practice__opening-side">As White</span>
      <span className="practice__opening-count">
        {known ? (count === 0 ? NONE : `${count} positions`) : ""}
      </span>
      {startButton({
        mode: "puzzles",
        motif: "opening-italian",
        idle: "Drill",
        disabled: empty,
      })}
      {empty ? <span className="practice__card-note">Generate the Italian drill first</span> : null}
    </div>
  );
}

export function PracticeHub(props: PracticeHubProps) {
  const { progress, motifs, repertoires, engineMissing, starting, failure, size, onSize } = props;
  const { onStart, onStartRepertoire } = props;
  const lastSession = props.lastSession ?? null;
  const [motif, setMotif] = useState(ANY_MOTIF);
  const busy = starting !== null;
  const counts = motifs.status === "ready" ? motifs.value : [];
  const rows = motifRows(counts, progress.status === "ready" ? progress.value : null);
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
      {lastSession ? (
        <p className="practice__last-session" data-testid="last-session">
          {lastSessionText(lastSession)}
        </p>
      ) : null}
      <section className="practice__card" aria-label="Due cards">
        <h3 className="practice__card-title">Due cards</h3>
        <p className="practice__card-note">Spaced repetition on positions from your own games</p>
        <DueCards progress={progress} now={props.now ?? new Date()} />
        {engineMissing ? <p className="practice__card-note">{NEEDS_ENGINE}</p> : null}
        {dueButton(progress, startButton)}
      </section>

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
          idle: `Start ${motif === ANY_MOTIF ? "any motif" : motifLabel(motif)}`,
        })}
      </section>

      <RepertoireMenu
        repertoires={repertoires}
        busy={busy}
        starting={
          starting?.mode === "repertoire" && starting.repertoireId !== undefined
            ? { repertoireId: starting.repertoireId, scope: starting.motif as RepertoireScope }
            : null
        }
        onStart={onStartRepertoire}
        fetchList={props.fetchRepertoireList}
        addOpening={props.addOpening}
        fetchCoverage={props.fetchCoverage}
      />

      <section className="practice__card" aria-label="Openings">
        <h3 className="practice__card-title">Openings</h3>
        <p className="practice__card-note">
          Best move in the positions that actually occur in your games
        </p>
        <p className="practice__card-note">Common positions</p>
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
        <p className="practice__card-note">Italian Opening</p>
        <ItalianRow counts={counts} known={motifs.status === "ready"} startButton={startButton} />
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

export interface ResumeCardProps {
  paused: PausedTraining;
  engineMissing: boolean;
  onResume(): void;
  onDiscard(): void;
}

// The session the student left when they opened a game or the server restarted.
export function ResumeCard({ paused, engineMissing, onResume, onDiscard }: ResumeCardProps) {
  const tally = `${paused.solved} right, ${paused.failed} missed so far`;
  return (
    <section className="practice__card" aria-label="Paused session">
      <h3 className="practice__card-title">{resumeLabelOf(paused)}</h3>
      <p className="practice__card-note">{tally}</p>
      <div className="practice__resume-actions">
        <button
          type="button"
          className="button button--primary"
          disabled={engineMissing}
          onClick={onResume}
        >
          Resume
        </button>
        <button type="button" className="button" onClick={onDiscard}>
          Discard
        </button>
      </div>
    </section>
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
