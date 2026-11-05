import type { GameMove } from "@chess-coach/shared";
import { markOf } from "../state/games.js";
import { CLASSIFICATION_LABEL, moveRows } from "../state/play.js";

interface GameMovesProps {
  moves: GameMove[];
  selectedPly: number;
  onSelect(ply: number): void;
}

function Ply({
  move,
  selectedPly,
  onSelect,
}: { move: GameMove | null } & Omit<GameMovesProps, "moves">) {
  if (!move) return <span className="moves__ply" />;
  const mark = markOf(move.classification);
  return (
    <button
      type="button"
      className="game-moves__ply"
      data-testid={`ply-${move.ply}`}
      aria-current={move.ply === selectedPly ? "true" : undefined}
      onClick={() => onSelect(move.ply)}
    >
      <span className="moves__san">{move.san}</span>
      {move.classification && mark ? (
        <span
          className={`games__mark games__mark--${move.classification}`}
          role="img"
          aria-label={CLASSIFICATION_LABEL[move.classification]}
        >
          {mark}
        </span>
      ) : null}
    </button>
  );
}

export function GameMoves({ moves, selectedPly, onSelect }: GameMovesProps) {
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
