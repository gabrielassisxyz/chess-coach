import type { FoundPositionView } from "@chess-coach/shared";
import { memo, useId } from "react";
import {
  FOUND_COLOR_LABEL,
  FOUND_PHASE_LABEL,
  foundBestText,
  foundBestToneOf,
  foundDueCount,
  foundLastText,
  foundLineText,
  foundMistakeFootOf,
  foundReachedText,
  foundStateText,
  foundTitleOf,
  positionsText,
} from "../state/found-api.js";
import type { BoardFactory } from "./Board.js";
import { MiniBoard } from "./MiniBoard.js";

function CardChips({ position }: { position: FoundPositionView }) {
  return (
    <div className="found-card__chips">
      <span className="found-chip">{FOUND_COLOR_LABEL[position.color]}</span>
      <span className="found-chip">{FOUND_PHASE_LABEL[position.phase]}</span>
      {position.from_departure ? <span className="found-chip">Opponent left your line</span> : null}
      {position.from_mistake ? <span className="found-chip">Mistake</span> : null}
    </div>
  );
}

// A position reached more than once says how often and how often its best move was found; a
// mistake, which was met once, says when, and against whom or in which opening.
function CardFacts({ position, now }: { position: FoundPositionView; now: Date }) {
  if (position.section !== "reached") return <span>{foundMistakeFootOf(position, now)}</span>;
  return (
    <>
      <span>
        Reached <span className="found-card__figure">{foundReachedText(position)}</span>
      </span>
      <span>
        Found best{" "}
        <span className="found-card__figure" data-tone={foundBestToneOf(position)}>
          {foundBestText(position)}
        </span>
      </span>
      <span>{foundLastText(position, now)}</span>
    </>
  );
}

interface FoundCardProps {
  position: FoundPositionView;
  now: Date;
  // A start is in flight somewhere in the hub, so the card's Drill waits for it.
  busy: boolean;
  // The start in flight is this card's own.
  starting: boolean;
  onDrill(position: FoundPositionView): void;
  createBoard: BoardFactory | undefined;
}

// Memoised because a list holds a hundred cards or more and the hub renders on every server event.
const FoundCard = memo(function FoundCard({
  position,
  now,
  busy,
  starting,
  onDrill,
  createBoard,
}: FoundCardProps) {
  const titleId = useId();
  const title = foundTitleOf(position);
  const line = foundLineText(position.line);
  return (
    <li className="found-card">
      <MiniBoard fen={position.fen} orientation={position.color} createBoard={createBoard} />
      <div className="found-card__body">
        <div className="found-card__head">
          <span className="found-card__title" id={titleId} title={title}>
            {title}
          </span>
          <span className="found-card__state" data-state={position.state}>
            {foundStateText(position, now)}
          </span>
        </div>
        {line === "" ? null : (
          <p className="found-card__line" title={line}>
            {line}
          </p>
        )}
        <CardChips position={position} />
        <div className="found-card__foot">
          <CardFacts position={position} now={now} />
          <button
            type="button"
            className="button found-card__drill"
            aria-describedby={titleId}
            disabled={busy}
            onClick={() => onDrill(position)}
          >
            {starting ? "Starting" : "Drill"}
          </button>
        </div>
      </div>
    </li>
  );
});

export interface FoundSectionProps {
  title: string;
  // Said in place of the cards when the section holds none.
  empty: string;
  positions: readonly FoundPositionView[];
  now: Date;
  busy: boolean;
  // The position whose start is in flight, if a card's start is.
  startingPosition: string | undefined;
  onDrill(position: FoundPositionView): void;
  createBoard: BoardFactory | undefined;
}

export function FoundSection({
  title,
  empty,
  positions,
  startingPosition,
  ...card
}: FoundSectionProps) {
  const titleId = useId();
  return (
    <section className="found-section" aria-labelledby={titleId}>
      <div className="found-section__head">
        <h3 className="found-section__title" id={titleId}>
          {title}
        </h3>
        <span className="found-section__count">
          {`${positionsText(positions.length)} · ${foundDueCount(positions)} due`}
        </span>
      </div>
      {positions.length === 0 ? (
        <p className="found-section__empty">{empty}</p>
      ) : (
        <ul className="found-grid">
          {positions.map((position) => (
            <FoundCard
              key={position.id}
              position={position}
              starting={startingPosition === position.id}
              {...card}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
