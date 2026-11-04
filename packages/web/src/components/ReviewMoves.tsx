import type { GameMove } from "@chess-coach/shared";
import { CLASSIFICATION_LABEL, moveRows } from "../state/play.js";

interface ReviewMovesProps {
  moves: GameMove[];
  selectedPly: number;
  onSelect(ply: number): void;
}

function Ply({
  move,
  selectedPly,
  onSelect,
}: { move: GameMove | null } & Omit<ReviewMovesProps, "moves">) {
  if (!move) return <span className="moves__ply" />;
  return (
    <button
      type="button"
      className="review-moves__ply"
      data-testid={`ply-${move.ply}`}
      aria-current={move.ply === selectedPly ? "true" : undefined}
      onClick={() => onSelect(move.ply)}
    >
      <span className="moves__san">{move.san}</span>
      {move.cp_loss !== null ? <span className="review-moves__loss">{move.cp_loss}</span> : null}
      {move.classification ? (
        <span className={`badge badge--${move.classification}`}>
          {CLASSIFICATION_LABEL[move.classification]}
        </span>
      ) : null}
    </button>
  );
}

export function ReviewMoves({ moves, selectedPly, onSelect }: ReviewMovesProps) {
  const full = (move: { ply: number } | null): GameMove | null =>
    move ? (moves[move.ply - 1] ?? null) : null;
  return (
    <ol className="moves" aria-label="Moves">
      {moveRows(moves).map((row) => (
        <li key={row.number} className="moves__row">
          <span className="moves__number">{row.number}.</span>
          <Ply move={full(row.white)} selectedPly={selectedPly} onSelect={onSelect} />
          <Ply move={full(row.black)} selectedPly={selectedPly} onSelect={onSelect} />
        </li>
      ))}
    </ol>
  );
}
