import type { Chess, Move } from "chess.js";

export function applyUci(position: Chess, uci: string): Move {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.slice(4);
  return promotion ? position.move({ from, to, promotion }) : position.move({ from, to });
}
