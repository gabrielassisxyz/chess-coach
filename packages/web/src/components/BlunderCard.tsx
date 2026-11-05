import type { ActivityMove } from "@chess-coach/shared";
import { blunderFacts } from "../state/play.js";

export function BlunderCard({ move }: { move: ActivityMove }) {
  const facts = blunderFacts(move);
  const summary = [facts.move, facts.played].filter((part) => part !== null).join(" · ");
  const detail = [
    facts.best === null ? null : `Best was ${facts.best}.`,
    facts.lost === null ? null : `Lost ${facts.lost}.`,
  ]
    .filter((part) => part !== null)
    .join(" ");
  return (
    <section className="blunder-card" aria-label="Last blunder" data-testid="blunder-card">
      <div className="blunder-card__head">
        <span className="blunder-card__kind">Blunder</span>
        <span className="blunder-card__move">{summary}</span>
      </div>
      {detail === "" ? null : <p className="blunder-card__detail">{detail}</p>}
    </section>
  );
}
