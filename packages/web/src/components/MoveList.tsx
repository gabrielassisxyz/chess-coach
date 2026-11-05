import type { ActivityMove } from "@chess-coach/shared";
import { useEffect, useRef } from "react";
import { CLASSIFICATION_LABEL, MARK_TEXT, moveRows } from "../state/play.js";

interface PlyProps {
  move: ActivityMove | null;
  latest: boolean;
  flagged: boolean;
}

function Ply({ move, latest, flagged }: PlyProps) {
  if (!move) return <span className="movelist__ply" />;
  const grade = move.classification;
  const mark = grade ? MARK_TEXT[grade] : undefined;
  return (
    <span
      className="movelist__ply"
      data-testid={`ply-${move.ply}`}
      data-flagged={flagged ? "true" : undefined}
      aria-current={latest ? "true" : undefined}
    >
      <span className="movelist__san">{move.san}</span>
      <span
        className={`movelist__dot movelist__dot--${grade ?? "none"}`}
        data-testid="dot"
        aria-hidden="true"
      />
      {mark && grade ? (
        <span className={`movelist__mark movelist__mark--${grade}`} data-testid="mark">
          <span aria-hidden="true">{mark}</span>
          <span className="sr-only">{CLASSIFICATION_LABEL[grade]}</span>
        </span>
      ) : grade ? (
        <span className="sr-only">{CLASSIFICATION_LABEL[grade]}</span>
      ) : null}
    </span>
  );
}

export interface MoveListProps {
  moves: ActivityMove[];
  // The blunder the card beside the list names; its cell takes the blunder background.
  flaggedPly?: number | null;
}

export function MoveList({ moves, flaggedPly = null }: MoveListProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const latestPly = moves.at(-1)?.ply ?? null;

  useEffect(() => {
    const list = listRef.current;
    if (!list || latestPly === null) return;
    list.scrollTop = list.scrollHeight;
    list.scrollLeft = list.scrollWidth;
  }, [latestPly]);

  return (
    <ol className="movelist" aria-label="Moves" ref={listRef}>
      {moveRows(moves).map((row) => (
        <li key={row.number} className="movelist__row">
          <span className="movelist__number">{row.number}.</span>
          <Ply
            move={row.white}
            latest={row.white?.ply === latestPly}
            flagged={row.white?.ply === flaggedPly}
          />
          <Ply
            move={row.black}
            latest={row.black?.ply === latestPly}
            flagged={row.black?.ply === flaggedPly}
          />
        </li>
      ))}
    </ol>
  );
}
