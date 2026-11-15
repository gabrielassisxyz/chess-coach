export type PositionPhase = "opening" | "middlegame" | "endgame";

// Both sides' pieces besides kings and pawns, counted together.
const ENDGAME_MAX_PIECES = 6;
// The student's 15th move is the last of the opening.
const OPENING_LAST_PLY = 30;

const KINGS_AND_PAWNS = new Set(["k", "p"]);

function piecesBesidesKingsAndPawns(fen: string): number {
  const placement = fen.split(" ")[0] ?? "";
  let pieces = 0;
  for (const square of placement) {
    if (/[a-z]/i.test(square) && !KINGS_AND_PAWNS.has(square.toLowerCase())) pieces += 1;
  }
  return pieces;
}

/** The phase of a position the student is to move in, where `ply` is the ply of that move. */
export function positionPhaseOf(fen: string, ply: number): PositionPhase {
  if (piecesBesidesKingsAndPawns(fen) <= ENDGAME_MAX_PIECES) return "endgame";
  return ply <= OPENING_LAST_PLY ? "opening" : "middlegame";
}
