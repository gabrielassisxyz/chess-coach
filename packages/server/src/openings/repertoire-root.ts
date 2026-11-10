import { Chess } from "chess.js";

// The opening is chosen rather than scored, so these plies are played whatever the data says, and
// reach starts counting after them: a reply that leaves earlier is out of scope for this unit.
export const ITALIAN_SETUP_SAN = ["e4", "e5", "Nf3", "Nc6", "Bc4"];
const WHITE_SETUP_SAN = ITALIAN_SETUP_SAN.filter((_, ply) => ply % 2 === 0);

// A unit rooted past this many plies would start from a position too narrow to teach from.
export const REPERTOIRE_ROOT_MAX_PLY = 8;
// The longest SAN chess.js can write is well under this; it bounds the parser's work on input
// that came from a browser.
const LONGEST_SAN = 12;

export class RepertoireRootError extends Error {}

export type RepertoireRootCheck =
  | { ok: true; root: string[]; fen: string }
  | { ok: false; reason: string };

const refused = (reason: string): RepertoireRootCheck => ({ ok: false, reason });

// Played one move at a time, so the SAN is the one chess.js writes for the move and never the
// spelling the caller used.
function playRoot(sans: readonly string[]): { sans: string[]; fen: string } | null {
  const game = new Chess();
  const played: string[] = [];
  for (const san of sans) {
    try {
      played.push(game.move(san).san);
    } catch {
      return null;
    }
  }
  return { sans: played, fen: game.fen() };
}

// White's moves must be the setup moves at the plies the setup has one. Past the setup White has
// no fixed move, and the length cap is what bounds the root there.
const departsFromSetup = (sans: readonly string[]): boolean =>
  sans.some((san, ply) => {
    const setup = ITALIAN_SETUP_SAN[ply];
    return ply % 2 === 0 && setup !== undefined && san !== setup;
  });

/**
 * A root is the line a unit starts from: 1.e4, White's moves of the Italian setup, and the Black
 * move that leaves it as the last one. It comes from the browser, so it is replayed on a board and
 * everything it fails is said in words.
 */
export function checkRepertoireRoot(root: unknown): RepertoireRootCheck {
  if (!Array.isArray(root) || root.some((san) => typeof san !== "string" || san === "")) {
    return refused("the root is a list of SAN moves");
  }
  if (root.length > REPERTOIRE_ROOT_MAX_PLY) {
    return refused(`the root is at most ${REPERTOIRE_ROOT_MAX_PLY} plies long`);
  }
  if (root.some((san: string) => san.length > LONGEST_SAN)) {
    return refused("the root holds a move that is not SAN");
  }
  const played = playRoot(root as string[]);
  if (!played) return refused("the root is not a legal line from the start position");
  if (played.sans[0] !== ITALIAN_SETUP_SAN[0]) return refused("the root starts with 1.e4");
  if (played.sans.length % 2 === 1) return refused("the root ends on Black's move");
  if (departsFromSetup(played.sans)) {
    return refused(`White plays the setup moves ${WHITE_SETUP_SAN.join(", ")} in the root`);
  }
  return { ok: true, root: played.sans, fen: played.fen };
}
