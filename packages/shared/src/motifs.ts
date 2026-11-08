// The Practice hub offers a fixed list, so the student picks from the same motifs on every
// machine, with or without an import. The server reads the same list to validate a start.

export interface PracticeMotifChoice {
  theme: string;
  label: string;
  description: string;
}

// The fourteen motifs of the Motifs section at https://lichess.org/training/themes. The theme key
// is Lichess's, the label is its title, and the description is its page text shortened for the card.
export const LICHESS_PRACTICE_MOTIFS: readonly PracticeMotifChoice[] = [
  {
    theme: "advancedPawn",
    label: "Advanced pawn",
    description: "A pawn deep in enemy territory, threatening to promote.",
  },
  {
    theme: "attackingF2F7",
    label: "Attacking f2 or f7",
    description: "Attack the f2 or f7 pawn, as in the fried liver.",
  },
  {
    theme: "capturingDefender",
    label: "Capture the defender",
    description: "Remove the defender, then take what it guarded.",
  },
  {
    theme: "discoveredAttack",
    label: "Discovered attack",
    description: "Move a piece to unveil an attack from behind it.",
  },
  {
    theme: "doubleCheck",
    label: "Double check",
    description: "Check with two pieces at once.",
  },
  {
    theme: "exposedKing",
    label: "Exposed king",
    description: "A king with few defenders, often mated.",
  },
  {
    theme: "fork",
    label: "Fork",
    description: "One piece attacks two targets at once.",
  },
  {
    theme: "hangingPiece",
    label: "Hanging piece",
    description: "An undefended piece, free to capture.",
  },
  {
    theme: "kingsideAttack",
    label: "Kingside attack",
    description: "Attack the king after it castled kingside.",
  },
  {
    theme: "pin",
    label: "Pin",
    description: "A piece cannot move without exposing a stronger one.",
  },
  {
    theme: "queensideAttack",
    label: "Queenside attack",
    description: "Attack the king after it castled queenside.",
  },
  {
    theme: "sacrifice",
    label: "Sacrifice",
    description: "Give up material for a forced advantage.",
  },
  {
    theme: "skewer",
    label: "Skewer",
    description: "Attack a strong piece to win the weaker one behind it.",
  },
  {
    theme: "trappedPiece",
    label: "Trapped piece",
    description: "A piece with no escape from capture.",
  },
] as const;

// Choices outside the Motifs section whose queue is a Lichess theme once the puzzles are imported.
// The key is the stored motif, which the server maps to the theme. The library's counts say
// nothing about what these serve, so they are shown like the motifs above.
export const LICHESS_OTHER_PRACTICE_MOTIFS: readonly PracticeMotifChoice[] = [
  {
    theme: "back_rank_mate",
    label: "Back rank mate",
    description: "Mate the king trapped on its home rank.",
  },
  {
    theme: "checkmate",
    label: "Checkmate",
    description: "Find the forcing line that ends in checkmate.",
  },
  {
    theme: "endgame",
    label: "Endgame",
    description: "With few pieces left, the accurate move decides the game.",
  },
  {
    theme: "promotion",
    label: "Promotion",
    description: "Push the pawn and pick the piece that wins.",
  },
  {
    theme: "opening",
    label: "Opening",
    description: "Find the strongest move while the pieces develop.",
  },
] as const;

// Lichess has no theme for these, so they are served from the library alone. The library's fork,
// pin and skewer choices merge into the motifs above, so they are not listed here.
export const LIBRARY_PRACTICE_MOTIFS: readonly PracticeMotifChoice[] = [
  {
    theme: "opening_trap",
    label: "Opening trap",
    description: "Punish an early developing mistake.",
  },
] as const;

const FIXED_PRACTICE_THEME_SET: ReadonlySet<string> = new Set(
  [...LICHESS_PRACTICE_MOTIFS, ...LICHESS_OTHER_PRACTICE_MOTIFS, ...LIBRARY_PRACTICE_MOTIFS].map(
    (entry) => entry.theme,
  ),
);

// A start is valid when its motif names a fixed choice; the server also allows any stored motif.
export function isFixedPracticeMotif(motif: string): boolean {
  return FIXED_PRACTICE_THEME_SET.has(motif);
}
