// The puzzle themes shown in the Stats views and theme picker, matching the Lichess keys the
// server stores and computes statistics over.

export const PUZZLE_THEME_GROUPS = [
  "Phases",
  "Motifs",
  "Advanced",
  "Mates",
  "Special moves",
  "Goal and length",
] as const;

export type PuzzleThemeGroup = (typeof PUZZLE_THEME_GROUPS)[number];

export interface PuzzleThemeEntry {
  theme: string;
  name: string;
  description: string;
  group: PuzzleThemeGroup;
}

export interface PuzzleThemeDescription {
  name: string;
  description: string;
}

export const PUZZLE_THEMES: readonly PuzzleThemeEntry[] = [
  // Phases
  {
    theme: "opening",
    name: "Opening",
    description: "A tactic while the pieces develop.",
    group: "Phases",
  },
  {
    theme: "middlegame",
    name: "Middlegame",
    description: "A tactic once the pieces are out.",
    group: "Phases",
  },
  {
    theme: "endgame",
    name: "Endgame",
    description: "Few pieces left; the accurate move decides.",
    group: "Phases",
  },
  {
    theme: "rookEndgame",
    name: "Rook endgame",
    description: "Only rooks and pawns.",
    group: "Phases",
  },
  {
    theme: "bishopEndgame",
    name: "Bishop endgame",
    description: "Only bishops and pawns.",
    group: "Phases",
  },
  {
    theme: "knightEndgame",
    name: "Knight endgame",
    description: "Only knights and pawns.",
    group: "Phases",
  },
  {
    theme: "pawnEndgame",
    name: "Pawn endgame",
    description: "Only kings and pawns.",
    group: "Phases",
  },
  {
    theme: "queenEndgame",
    name: "Queen endgame",
    description: "Only queens and pawns.",
    group: "Phases",
  },
  {
    theme: "queenRookEndgame",
    name: "Queen and rook",
    description: "Queens, rooks and pawns.",
    group: "Phases",
  },

  // Motifs
  {
    theme: "advancedPawn",
    name: "Advanced pawn",
    description: "A pawn deep in enemy territory.",
    group: "Motifs",
  },
  {
    theme: "attackingF2F7",
    name: "Attacking f2 or f7",
    description: "The weak pawn next to the king, as in the Fried Liver.",
    group: "Motifs",
  },
  {
    theme: "capturingDefender",
    name: "Capture the defender",
    description: "Remove the guard, then take what it guarded.",
    group: "Motifs",
  },
  {
    theme: "discoveredAttack",
    name: "Discovered attack",
    description: "Move one piece to unveil another.",
    group: "Motifs",
  },
  {
    theme: "doubleCheck",
    name: "Double check",
    description: "Check with two pieces at once.",
    group: "Motifs",
  },
  {
    theme: "exposedKing",
    name: "Exposed king",
    description: "A king with few defenders.",
    group: "Motifs",
  },
  {
    theme: "fork",
    name: "Fork",
    description: "One piece attacks two targets.",
    group: "Motifs",
  },
  {
    theme: "hangingPiece",
    name: "Hanging piece",
    description: "An undefended piece, free to take.",
    group: "Motifs",
  },
  {
    theme: "kingsideAttack",
    name: "Kingside attack",
    description: "Attack the king after short castling.",
    group: "Motifs",
  },
  {
    theme: "pin",
    name: "Pin",
    description: "A piece stuck in front of a bigger one.",
    group: "Motifs",
  },
  {
    theme: "queensideAttack",
    name: "Queenside attack",
    description: "Attack the king after long castling.",
    group: "Motifs",
  },
  {
    theme: "sacrifice",
    name: "Sacrifice",
    description: "Give up material for a forced gain.",
    group: "Motifs",
  },
  {
    theme: "skewer",
    name: "Skewer",
    description: "Hit a big piece to win the one behind it.",
    group: "Motifs",
  },
  {
    theme: "trappedPiece",
    name: "Trapped piece",
    description: "A piece with no safe square left.",
    group: "Motifs",
  },

  // Advanced
  {
    theme: "attraction",
    name: "Attraction",
    description: "Lure a piece onto a fatal square.",
    group: "Advanced",
  },
  {
    theme: "clearance",
    name: "Clearance",
    description: "Clear a line or square with tempo.",
    group: "Advanced",
  },
  {
    theme: "deflection",
    name: "Deflection",
    description: "Pull a defender away from its duty.",
    group: "Advanced",
  },
  {
    theme: "defensiveMove",
    name: "Defensive move",
    description: "The only move that keeps the balance.",
    group: "Advanced",
  },
  {
    theme: "discoveredCheck",
    name: "Discovered check",
    description: "Unveil a check from a hidden piece.",
    group: "Advanced",
  },
  {
    theme: "interference",
    name: "Interference",
    description: "Step between two enemy pieces.",
    group: "Advanced",
  },
  {
    theme: "intermezzo",
    name: "Intermezzo",
    description: "An in-between move before the expected one.",
    group: "Advanced",
  },
  {
    theme: "quietMove",
    name: "Quiet move",
    description: "No check, no capture, but unstoppable.",
    group: "Advanced",
  },
  {
    theme: "xRayAttack",
    name: "X-ray",
    description: "Attack or defend through an enemy piece.",
    group: "Advanced",
  },
  {
    theme: "zugzwang",
    name: "Zugzwang",
    description: "Every move makes it worse for them.",
    group: "Advanced",
  },

  // Mates
  {
    theme: "mateIn1",
    name: "Mate in 1",
    description: "Deliver checkmate in one move.",
    group: "Mates",
  },
  {
    theme: "mateIn2",
    name: "Mate in 2",
    description: "Checkmate in two moves.",
    group: "Mates",
  },
  {
    theme: "mateIn3",
    name: "Mate in 3",
    description: "Checkmate in three moves.",
    group: "Mates",
  },
  {
    theme: "mateIn4",
    name: "Mate in 4+",
    description: "A long mating sequence.",
    group: "Mates",
  },
  {
    theme: "backRankMate",
    name: "Back rank mate",
    description: "The king trapped on its home rank.",
    group: "Mates",
  },
  {
    theme: "smotheredMate",
    name: "Smothered mate",
    description: "A knight mates a king boxed in by its own pieces.",
    group: "Mates",
  },
  {
    theme: "arabianMate",
    name: "Arabian mate",
    description: "Knight and rook in the corner.",
    group: "Mates",
  },
  {
    theme: "anastasiaMate",
    name: "Anastasia's mate",
    description: "Knight and rook on the edge.",
    group: "Mates",
  },
  {
    theme: "hookMate",
    name: "Hook mate",
    description: "Rook, knight and pawn together.",
    group: "Mates",
  },
  {
    theme: "doubleBishopMate",
    name: "Double bishop mate",
    description: "Two bishops on adjacent diagonals.",
    group: "Mates",
  },

  // Special moves
  {
    theme: "castling",
    name: "Castling",
    description: "King to safety, rook into play.",
    group: "Special moves",
  },
  {
    theme: "enPassant",
    name: "En passant",
    description: "Capture the pawn that just jumped past.",
    group: "Special moves",
  },
  {
    theme: "promotion",
    name: "Promotion",
    description: "Push the pawn and pick the right piece.",
    group: "Special moves",
  },
  {
    theme: "underPromotion",
    name: "Underpromotion",
    description: "A knight, bishop or rook instead of a queen.",
    group: "Special moves",
  },

  // Goal and length
  {
    theme: "equality",
    name: "Equality",
    description: "Save a losing position.",
    group: "Goal and length",
  },
  {
    theme: "advantage",
    name: "Advantage",
    description: "Turn a small edge into a real one.",
    group: "Goal and length",
  },
  {
    theme: "crushing",
    name: "Crushing",
    description: "Punish a blunder decisively.",
    group: "Goal and length",
  },
  {
    theme: "oneMove",
    name: "One move",
    description: "A single move wins it.",
    group: "Goal and length",
  },
  {
    theme: "short",
    name: "Short",
    description: "Two moves to win.",
    group: "Goal and length",
  },
  {
    theme: "long",
    name: "Long",
    description: "Three moves to win.",
    group: "Goal and length",
  },
  {
    theme: "veryLong",
    name: "Very long",
    description: "Four moves or more.",
    group: "Goal and length",
  },
] as const;

// Themes stored by Lichess or the built-in library outside the 54-entry picker.
export const EXTRA_PUZZLE_THEMES: Readonly<Record<string, PuzzleThemeDescription>> = {
  mate: {
    name: "Checkmate",
    description: "Find the forcing line that ends the game.",
  },
};

const PUZZLE_THEME_BY_KEY: ReadonlyMap<string, PuzzleThemeDescription> = new Map([
  ...PUZZLE_THEMES.map(({ theme, name, description }): [string, PuzzleThemeDescription] => [
    theme,
    { name, description },
  ]),
  ...Object.entries(EXTRA_PUZZLE_THEMES),
]);

const GOAL_OR_LENGTH_THEMES: ReadonlySet<string> = new Set(
  PUZZLE_THEMES.filter((entry) => entry.group === "Goal and length").map((entry) => entry.theme),
);

/** Return the display name and one-line description of a Lichess puzzle theme key, or null. */
export function puzzleThemeInfo(theme: string): PuzzleThemeDescription | null {
  return PUZZLE_THEME_BY_KEY.get(theme) ?? null;
}

/** Whether `theme` is a goal or length tag (excluded from ranked Improvement areas / Strengths). */
export function isGoalOrLengthTheme(theme: string): boolean {
  return GOAL_OR_LENGTH_THEMES.has(theme);
}
