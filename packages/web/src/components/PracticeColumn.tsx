import type { RepertoireDrill, TrainingActivity } from "@chess-coach/shared";
import { type ReactNode, useState } from "react";
import { formatElapsed, lookedAtMs, NONE, type TrainingView } from "../state/practice.js";
import {
  headingOf,
  type MoveCell,
  type MoveRow,
  moveRowsOf,
  outcomesOf,
  ratingsOf,
  type StateCard,
  signedCount,
  variationText,
} from "../state/practice-item.js";
import { hintLabelOf, nextEndsDrill, shownMoveOf } from "../state/repertoire-drill.js";
import type { FetchRepertoires } from "../state/repertoires-api.js";
import { ExplorationTrail } from "./ExplorationTrail.js";
import { RatingButtons } from "./RatingButtons.js";
import { RepertoireHead } from "./RepertoireHead.js";

export interface PracticeColumnActions {
  showSolution(): void;
  rate(quality: number): void;
  next(): void;
  end(): void;
  hint(): void;
  toggleScratch(): void;
  takeBack(): void;
  resetLine(): void;
}

export interface PracticeColumnProps {
  training: TrainingActivity;
  view: TrainingView;
  actions: PracticeColumnActions;
  card: StateCard;
  elapsedMs: number;
  // The line of free moves while exploring or analysing; null otherwise.
  scratchLine: string[] | null;
  // How many of the item's moves the board shows; the cell at that ply reads as current.
  shownPly: number;
  // The engine strip, rendered by the screen that owns the engine state.
  engineStrip: ReactNode;
  runMotif?: string | null | undefined;
  // Where a repertoire drill reads its variation names from when a position has none of its own.
  fetchRepertoires?: FetchRepertoires | undefined;
}

function Segments({ training }: { training: TrainingActivity }) {
  const outcomes = outcomesOf(training);
  const solved = outcomes.filter((outcome) => outcome === "solved").length;
  const failed = outcomes.filter((outcome) => outcome === "failed").length;
  return (
    <ol
      className="practice-item__progress"
      aria-label={`Session progress: ${solved} solved, ${failed} missed, item ${training.item.position_in_queue} of ${training.item.queue_length}`}
    >
      {outcomes.map((outcome, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a segment is its queue position
        <li key={index} data-outcome={outcome} />
      ))}
    </ol>
  );
}

function Ratings({ training, view }: Pick<PracticeColumnProps, "training" | "view">) {
  const ratings = ratingsOf(training, view);
  return (
    <dl className="practice-item__ratings">
      <div className="practice-item__rating">
        <dt>Your rating</dt>
        <dd>
          {ratings.yours ?? NONE}
          {ratings.change !== null && ratings.change !== 0 ? (
            <span
              className="practice-item__rating-change"
              data-direction={ratings.change > 0 ? "up" : "down"}
              data-testid="rating-change"
            >
              {signedCount(ratings.change)}
            </span>
          ) : null}
        </dd>
      </div>
      <div className="practice-item__rating">
        <dt>Puzzle rating</dt>
        {ratings.revealed ? (
          <dd data-testid="puzzle-rating">{ratings.puzzle ?? NONE}</dd>
        ) : (
          <dd className="practice-item__rating--hidden" data-testid="puzzle-rating">
            <span aria-hidden="true">····</span>
            <span className="practice-item__rating-note">after solving</span>
          </dd>
        )}
      </div>
    </dl>
  );
}

interface CellProps {
  cell: MoveCell | "ellipsis" | null;
  current: boolean;
  // The move a repertoire drill shows in the empty cell of the ply the student is on.
  answer: string | null;
}

function Cell({ cell, current, answer }: CellProps) {
  if (cell === null) return <span className="moves-list__cell" />;
  if (cell === "ellipsis") {
    return <span className="moves-list__cell moves-list__cell--ellipsis">{"…"}</span>;
  }
  if (cell.by === "pending" && answer !== null) {
    return (
      <span
        className="moves-list__cell"
        data-by="answer"
        data-current={current ? "true" : undefined}
        data-testid="answer-cell"
      >
        {answer}
        <span className="sr-only">the move to play</span>
      </span>
    );
  }
  return (
    <span
      className="moves-list__cell"
      data-by={cell.by}
      data-current={current ? "true" : undefined}
      data-testid={`ply-${cell.ply}`}
    >
      {cell.san}
      {cell.by === "student" ? (
        <span className="moves-list__mark">
          <span aria-hidden="true">{"\u2713"}</span>
          <span className="sr-only">right</span>
        </span>
      ) : null}
    </span>
  );
}

function variations(row: MoveRow): ReactNode[] {
  const lines: ReactNode[] = [];
  for (const [cell, white] of [
    [row.white, true],
    [row.black, false],
  ] as const) {
    if (cell === null || cell === "ellipsis") continue;
    for (const wrong of cell.wrongTries) {
      lines.push(
        <div key={`${cell.ply}-${wrong.uci}-${lines.length}`} className="moves-list__variation">
          {variationText(row.number, white, wrong.san, wrong.uci)}
        </div>,
      );
    }
  }
  return lines;
}

// A repertoire drill keeps the wrong tries out of the list: a miss puts the piece back and shows
// nothing else.
function MovesList({
  training,
  shownPly,
  answer,
}: Pick<PracticeColumnProps, "training" | "shownPly"> & { answer: string | null }) {
  const rows = moveRowsOf(training.repertoire ? { ...training, wrong_tries: [] } : training);
  const isCurrent = (cell: MoveCell | "ellipsis" | null): boolean =>
    cell !== null && cell !== "ellipsis" && cell.ply === shownPly - 1;
  const pendingCurrent = (cell: MoveCell | "ellipsis" | null): boolean =>
    cell !== null && cell !== "ellipsis" && cell.by === "pending" && shownPly === cell.ply;
  return (
    <ol className="moves-list" aria-label="Moves">
      {rows.map((row) => (
        <li key={row.number} className="moves-list__row">
          <div className="moves-list__line">
            <span className="moves-list__number">{row.number}.</span>
            <Cell
              cell={row.white}
              current={isCurrent(row.white) || pendingCurrent(row.white)}
              answer={answer}
            />
            <Cell
              cell={row.black}
              current={isCurrent(row.black) || pendingCurrent(row.black)}
              answer={answer}
            />
          </div>
          {variations(row)}
        </li>
      ))}
    </ol>
  );
}

function CardIcon({ tone }: { tone: StateCard["tone"] }) {
  if (tone === "wrong") {
    return (
      <span className="state-card__icon" aria-hidden="true">
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </span>
    );
  }
  if (tone === "right") {
    return (
      <span className="state-card__icon" aria-hidden="true">
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 8.5l3.5 3.5L13 4.5" />
        </svg>
      </span>
    );
  }
  return (
    <span className="state-card__icon" aria-hidden="true">
      <span className="state-card__icon-dot" />
    </span>
  );
}

function ScratchActions({ actions, open }: { actions: PracticeColumnActions; open: boolean }) {
  return (
    <div className="state-card__actions">
      <button type="button" className="button" onClick={actions.takeBack}>
        Take back
      </button>
      <button type="button" className="button" onClick={actions.resetLine}>
        Reset
      </button>
      <button type="button" className="button button--quiet" onClick={actions.toggleScratch}>
        {open ? "Back to puzzle" : "Back to position"}
      </button>
    </div>
  );
}

function OpenActions({ actions }: { actions: PracticeColumnActions }) {
  return (
    <div className="state-card__actions">
      <button type="button" className="button" onClick={actions.hint}>
        Get a hint
      </button>
      <button type="button" className="button button--quiet" onClick={actions.showSolution}>
        View solution
      </button>
    </div>
  );
}

// The hint button is the only way the idea or the move of a repertoire line appears, so there is no
// View solution beside it; once both were asked there is nothing left to offer.
function DrillOpenActions({
  actions,
  drill,
}: {
  actions: PracticeColumnActions;
  drill: RepertoireDrill;
}) {
  const label = hintLabelOf(drill);
  if (label === null) return null;
  return (
    <div className="state-card__actions">
      <button type="button" className="button" onClick={actions.hint}>
        {label}
      </button>
    </div>
  );
}

function EndedActions({
  training,
  view,
  actions,
}: Pick<PracticeColumnProps, "training" | "view" | "actions">) {
  const last = training.repertoire
    ? nextEndsDrill(training.repertoire)
    : training.item.position_in_queue === training.item.queue_length;
  return (
    <>
      {view.canRate && training.item.kind === "card" ? (
        <RatingButtons
          preview={training.item.rating_preview}
          suggested={training.suggested_quality}
          onRate={actions.rate}
        />
      ) : null}
      <button
        type="button"
        className="button button--primary state-card__continue"
        disabled={!view.canAdvance}
        onClick={actions.next}
      >
        {last ? "Finish training" : "Continue training"}
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 8h10M9 4l4 4-4 4" />
        </svg>
      </button>
      <div className="state-card__actions state-card__actions--even">
        <button type="button" className="button" onClick={actions.toggleScratch}>
          Analyse
        </button>
      </div>
    </>
  );
}

export function PracticeColumn(props: PracticeColumnProps) {
  const { training, view, actions, card, elapsedMs, scratchLine, shownPly, runMotif } = props;
  const { engineStrip, fetchRepertoires } = props;
  const [confirming, setConfirming] = useState(false);
  const heading = headingOf(
    training,
    runMotif !== undefined ? runMotif : (training.run_motif ?? null),
  );
  const trail = training.exploring.trail;
  const drill = training.repertoire ?? null;
  const answer = drill && view.open ? (shownMoveOf(drill)?.san ?? null) : null;
  return (
    <section className="screen practice-item" aria-label="Practice">
      <header className="practice-item__head">
        <div className="practice-item__title-row">
          <h2 className="practice-item__title">{heading.title}</h2>
          {heading.tag ? <span className="practice-item__tag">{heading.tag}</span> : null}
          <span className="practice-item__elapsed" role="timer" aria-label="Time on this item">
            {formatElapsed(elapsedMs)}
          </span>
          {view.summary ? null : (
            <button
              type="button"
              className="button button--quiet practice-item__end"
              onClick={() => setConfirming(true)}
            >
              End
            </button>
          )}
        </div>
        {heading.openingName ? (
          <p className="practice-item__opening-name">{heading.openingName}</p>
        ) : null}
        <Segments training={training} />
      </header>
      {drill ? null : <Ratings training={training} view={view} />}
      {engineStrip}
      {drill ? (
        <RepertoireHead training={training} drill={drill} fetchRepertoires={fetchRepertoires} />
      ) : null}
      <MovesList training={training} shownPly={shownPly} answer={answer} />
      <div className="state-card" data-tone={card.tone}>
        <div className="state-card__head">
          <CardIcon tone={card.tone} />
          <div className="state-card__text">
            <p className="state-card__title" role="status">
              {card.title}
            </p>
            <p className="state-card__body" data-testid={view.summary ? "summary" : undefined}>
              {card.body}
            </p>
          </div>
        </div>
        {!view.open && !view.summary && trail.length > 0 && scratchLine === null ? (
          <ExplorationTrail
            trail={trail}
            answered={false}
            heading={`What you looked at · ${formatElapsed(lookedAtMs(training))}`}
          />
        ) : null}
        {scratchLine !== null ? (
          <ScratchActions actions={actions} open={view.open} />
        ) : view.summary ? (
          <button
            type="button"
            className="button button--primary state-card__continue"
            onClick={actions.end}
          >
            Done
          </button>
        ) : view.open ? (
          drill ? (
            <DrillOpenActions actions={actions} drill={drill} />
          ) : (
            <OpenActions actions={actions} />
          )
        ) : (
          <EndedActions training={training} view={view} actions={actions} />
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
