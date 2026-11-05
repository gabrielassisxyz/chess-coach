import type { ExploredEvent } from "@chess-coach/shared";
import { trailLines } from "../state/practice.js";

export interface ExplorationTrailProps {
  trail: ExploredEvent[];
  answered: boolean;
  heading: string;
}

// The same list the coach reads, so the student sees what the coach sees of their reasoning.
export function ExplorationTrail({ trail, answered, heading }: ExplorationTrailProps) {
  const lines = trailLines(trail, answered);
  return (
    <section className="practice__trail" aria-label={heading}>
      <h3 className="practice__trail-title">{heading}</h3>
      {lines.length === 0 ? (
        <p className="practice__trail-empty">
          Nothing yet. Every step you try on the board is recorded here with its time.
        </p>
      ) : (
        <ol className="practice__trail-list">
          {lines.map((line) => (
            <li key={line.key}>
              <span className="practice__trail-line">{line.text}</span>
              {line.offset ? <span className="practice__trail-offset">{line.offset}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
