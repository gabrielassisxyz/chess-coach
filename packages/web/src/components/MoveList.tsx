import type { ActivityMove } from "@chess-coach/shared";
import { CLASSIFICATION_LABEL, moveRows } from "../state/play.js";

function Ply({ move }: { move: ActivityMove | null }) {
  if (!move) return <span className="moves__ply" />;
  return (
    <span className="moves__ply" data-testid={`ply-${move.ply}`}>
      <span className="moves__san">{move.san}</span>
      {move.classification ? (
        <span className={`badge badge--${move.classification}`} data-testid="badge">
          {CLASSIFICATION_LABEL[move.classification]}
        </span>
      ) : null}
    </span>
  );
}

export function MoveList({ moves }: { moves: ActivityMove[] }) {
  return (
    <ol className="moves" aria-label="Moves">
      {moveRows(moves).map((row) => (
        <li key={row.number} className="moves__row">
          <span className="moves__number">{row.number}.</span>
          <Ply move={row.white} />
          <Ply move={row.black} />
        </li>
      ))}
    </ol>
  );
}
