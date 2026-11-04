export const MATE_SCORE_CP = 10000;

export interface InfoLine {
  multipv: number;
  score: number;
  moves: string[];
}

/**
 * Parses one `info` line into a principal variation, or null for lines that carry no usable
 * one (currmove, string, bounds). The score stays from the side to move; mate maps to
 * +-10000, and `mate 0` (the side to move is already mated) counts as lost.
 */
export function parseInfoLine(line: string): InfoLine | null {
  if (!line.startsWith("info ")) return null;
  const tokens = line.split(/\s+/);
  if (tokens.includes("string") || tokens.includes("lowerbound") || tokens.includes("upperbound")) {
    return null;
  }
  const scoreAt = tokens.indexOf("score");
  const kind = tokens[scoreAt + 1];
  const raw = Number(tokens[scoreAt + 2]);
  if (scoreAt < 0 || (kind !== "cp" && kind !== "mate") || Number.isNaN(raw)) return null;
  const multipvAt = tokens.indexOf("multipv");
  const pvAt = tokens.indexOf("pv");
  return {
    multipv: multipvAt < 0 ? 1 : Number(tokens[multipvAt + 1]),
    score: kind === "cp" ? raw : raw > 0 ? MATE_SCORE_CP : -MATE_SCORE_CP,
    moves: pvAt < 0 ? [] : tokens.slice(pvAt + 1),
  };
}

export function parseBestmove(line: string): string | null {
  const move = line.split(/\s+/)[1];
  return move === undefined || move === "(none)" ? null : move;
}
