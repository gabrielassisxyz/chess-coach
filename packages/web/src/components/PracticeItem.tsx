import type { TrainingActivity } from "@chess-coach/shared";
import { useState } from "react";
import { useElapsed } from "../hooks/useElapsed.js";
import {
  breadcrumbOf,
  endedMotifText,
  formatElapsed,
  lookedAtMs,
  playedSanOf,
  promptOf,
  type TrainingView,
} from "../state/practice.js";
import { ExplorationTrail } from "./ExplorationTrail.js";
import { RatingButtons } from "./RatingButtons.js";

export interface PracticeItemActions {
  showSolution(): void;
  rate(quality: number): void;
  next(): void;
  end(): void;
  hint(): void;
  startExplore(): void;
  takeBack(): void;
  resetLine(): void;
  backToPuzzle(): void;
}

export interface PracticeItemProps {
  training: TrainingActivity;
  view: TrainingView;
  actions: PracticeItemActions;
  exploring?: boolean | undefined;
  runMotif?: string | null | undefined;
}

function wrongTries(count: number): string {
  return count === 1 ? "1 wrong try" : `${count} wrong tries`;
}

function verdictLine(training: TrainingActivity): string {
  if (training.status === "rated") return "Rated";
  if (training.gave_up) return "Solution shown";
  const played = playedSanOf(training);
  const word = training.status === "solved" ? "Right" : "Wrong";
  return `${word}${played ? ` ${played}` : ""}`;
}

function Verdict({ training, view }: Pick<PracticeItemProps, "training" | "view">) {
  const solved = training.status === "solved";
  // A right answer never reads as wrong, even if the server sent an expected move.
  const expected = solved ? null : view.expected;
  return (
    <div className="practice__verdict">
      <p role="status" className="practice__verdict-line">
        {verdictLine(training)}
      </p>
      {solved && training.tries > 0 ? (
        <p className="practice__expected">After {wrongTries(training.tries)}</p>
      ) : null}
      {expected ? <p className="practice__expected">Expected {expected}</p> : null}
    </div>
  );
}

function Open({ training, view, actions, exploring = false }: PracticeItemProps) {
  const elapsed = useElapsed(training.served_at, true);
  const line = training.exploring.line_san.join(" ");
  return (
    <>
      <p role="status" className="screen__note">
        {exploring ? "Exploring" : view.status}
      </p>
      <div className="practice__timer">
        <span className="practice__elapsed" role="timer" aria-label="Time on this item">
          {formatElapsed(elapsed)}
        </span>
        <button type="button" className="button" onClick={actions.hint}>
          Hint
        </button>
        {exploring ? (
          <button type="button" className="button" onClick={actions.backToPuzzle}>
            Back to puzzle
          </button>
        ) : (
          <button type="button" className="button" onClick={actions.startExplore}>
            Explore
          </button>
        )}
        <button type="button" className="button" onClick={actions.showSolution}>
          Solution
        </button>
      </div>
      {exploring ? (
        <div className="practice__explore">
          <p className="screen__note" data-testid="explore-line">
            {line === "" ? "Nothing yet. Moves here are not graded." : line}
          </p>
          <div className="controls__row">
            <button type="button" className="button" onClick={actions.takeBack}>
              Take back
            </button>
            <button type="button" className="button" onClick={actions.resetLine}>
              Reset
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Finished({ training, view, actions }: PracticeItemProps) {
  const { item } = training;
  const trail = training.exploring.trail;
  return (
    <>
      <Verdict training={training} view={view} />
      {trail.length > 0 ? (
        <ExplorationTrail
          trail={trail}
          answered={false}
          heading={`What you looked at · ${formatElapsed(lookedAtMs(training))}`}
        />
      ) : null}
      {view.canRate && item.kind === "card" ? (
        <RatingButtons
          preview={item.rating_preview}
          suggested={training.suggested_quality}
          onRate={actions.rate}
        />
      ) : null}
    </>
  );
}

export function PracticeItem(props: PracticeItemProps) {
  const { training, view, actions, runMotif } = props;
  const [confirming, setConfirming] = useState(false);
  const effectiveRunMotif = runMotif !== undefined ? runMotif : (training.run_motif ?? null);
  const heading = breadcrumbOf(training, effectiveRunMotif);
  const [title, count] = heading.split("\n");
  const motifAfter = endedMotifText(training, effectiveRunMotif);
  return (
    <section className="screen practice" aria-label="Practice">
      <h2 className="screen__title practice__crumb">
        <span className="practice__crumb-title">{title}</span>
        {count ? <span className="practice__crumb-count">{count}</span> : null}
      </h2>
      {motifAfter ? <p className="practice__card-note">{motifAfter}</p> : null}
      <p className="practice__prompt">{promptOf(training)}</p>
      {view.summary ? (
        <p className="practice__summary" data-testid="summary">
          Queue finished: {view.summary.solved} solved, {view.summary.failed} failed.
        </p>
      ) : null}
      {view.open ? <Open {...props} /> : <Finished {...props} />}
      <div className="controls__row">
        {view.summary ? null : (
          <button
            type="button"
            className="button button--primary"
            disabled={!view.canAdvance}
            onClick={actions.next}
          >
            {view.advanceLabel}
          </button>
        )}
        {view.summary ? (
          <button type="button" className="button" onClick={actions.end}>
            Done
          </button>
        ) : (
          <button type="button" className="button" onClick={() => setConfirming(true)}>
            End training
          </button>
        )}
      </div>
      {confirming && !view.summary ? (
        <dialog open className="practice__confirm" aria-label="End training">
          <p>End this session? What you answered is kept.</p>
          <div className="controls__row">
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                setConfirming(false);
                actions.end();
              }}
            >
              End
            </button>
            <button type="button" className="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </dialog>
      ) : null}
    </section>
  );
}
