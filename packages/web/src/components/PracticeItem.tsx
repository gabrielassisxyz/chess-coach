import type { TrainingActivity } from "@chess-coach/shared";
import { useElapsed } from "../hooks/useElapsed.js";
import {
  answeredSanOf,
  breadcrumbOf,
  formatElapsed,
  lookedAtMs,
  NONE,
  promptOf,
  type TrainingView,
} from "../state/practice.js";
import { ExplorationTrail } from "./ExplorationTrail.js";
import { RatingButtons } from "./RatingButtons.js";

const ANSWER_LOCKED = `Answer ${NONE} make your move first`;

export interface PracticeItemActions {
  answer(): void;
  takeBack(): void;
  reset(): void;
  rate(quality: number): void;
  next(): void;
  end(): void;
}

export interface PracticeItemProps {
  training: TrainingActivity;
  view: TrainingView;
  actions: PracticeItemActions;
}

function Verdict({ training, view }: Pick<PracticeItemProps, "training" | "view">) {
  const played = answeredSanOf(training);
  const word = training.status === "solved" ? "Right" : "Wrong";
  const expected = view.expected;
  return (
    <div className="practice__verdict">
      <p role="status" className="practice__verdict-line">
        {training.status === "rated" ? "Rated" : `${word}${played ? ` ${played}` : ""}`}
      </p>
      {expected ? <p className="practice__expected">Expected {expected}</p> : null}
    </div>
  );
}

function Exploring({ training, view, actions }: PracticeItemProps) {
  const elapsed = useElapsed(training.served_at, true);
  return (
    <>
      <p role="status" className="screen__note">
        {view.status}
      </p>
      <ExplorationTrail
        trail={training.exploring.trail}
        answered={false}
        heading="Explored so far"
      />
      <div className="practice__timer">
        <span className="practice__elapsed" role="timer" aria-label="Time on this item">
          {formatElapsed(elapsed)}
        </span>
        <button type="button" className="button" disabled={!view.canAnswer} onClick={actions.reset}>
          Reset
        </button>
        <button
          type="button"
          className="button"
          disabled={!view.canAnswer}
          onClick={actions.takeBack}
        >
          Take back
        </button>
      </div>
      <button
        type="button"
        className="button button--primary practice__answer"
        disabled={!view.canAnswer}
        onClick={actions.answer}
      >
        {view.canAnswer ? "Answer" : ANSWER_LOCKED}
      </button>
    </>
  );
}

function Answered({ training, view, actions }: PracticeItemProps) {
  const { item } = training;
  return (
    <>
      <Verdict training={training} view={view} />
      <ExplorationTrail
        trail={training.exploring.trail}
        answered
        heading={`What you looked at · ${formatElapsed(lookedAtMs(training))}`}
      />
      {view.canRate && item.kind === "card" ? (
        <RatingButtons preview={item.rating_preview} onRate={actions.rate} />
      ) : null}
    </>
  );
}

export function PracticeItem(props: PracticeItemProps) {
  const { training, view, actions } = props;
  return (
    <section className="screen practice" aria-label="Practice">
      <h2 className="screen__title practice__crumb">{breadcrumbOf(training)}</h2>
      <p className="practice__prompt">{promptOf(training)}</p>
      {view.summary ? (
        <p className="practice__summary" data-testid="summary">
          Queue finished: {view.summary.solved} solved, {view.summary.failed} failed.
        </p>
      ) : null}
      {view.canExplore ? <Exploring {...props} /> : <Answered {...props} />}
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
        <button type="button" className="button" onClick={actions.end}>
          {view.summary ? "Done" : "End training"}
        </button>
      </div>
    </section>
  );
}
