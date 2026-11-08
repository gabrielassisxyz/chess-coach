import { useCallback, useState } from "react";

// How the board is drawn and behaves, apart from its colours (those are the board theme).
// Stored per browser like the theme; every board on every screen reads the same set.
export interface BoardPrefs {
  coordinates: "inside" | "edge" | "off";
  animation: "off" | "fast" | "normal";
  lastMove: boolean;
  legalMoves: boolean;
  // Practice only: Continue fires by itself once a puzzle ended and its mark has settled.
  autoNext: boolean;
}

export const DEFAULT_BOARD_PREFS: BoardPrefs = {
  coordinates: "inside",
  animation: "normal",
  lastMove: true,
  legalMoves: true,
  autoNext: false,
};

export const BOARD_PREFS_STORAGE_KEY = "chess-coach.board-prefs";

export const COORDINATE_OPTIONS: readonly BoardPrefs["coordinates"][] = ["inside", "edge", "off"];
export const ANIMATION_OPTIONS: readonly BoardPrefs["animation"][] = ["off", "fast", "normal"];

// Chessground's animation length per setting; "off" disables it.
export const ANIMATION_MS: Record<BoardPrefs["animation"], number> = {
  off: 0,
  fast: 100,
  normal: 200,
};

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

// Every field is checked on its own, so a stored set from an older version keeps what it can.
export function readBoardPrefs(): BoardPrefs {
  try {
    const raw = window.localStorage.getItem(BOARD_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_BOARD_PREFS;
    const stored = JSON.parse(raw) as Partial<Record<keyof BoardPrefs, unknown>>;
    return {
      coordinates: isOneOf(COORDINATE_OPTIONS, stored.coordinates)
        ? stored.coordinates
        : DEFAULT_BOARD_PREFS.coordinates,
      animation: isOneOf(ANIMATION_OPTIONS, stored.animation)
        ? stored.animation
        : DEFAULT_BOARD_PREFS.animation,
      lastMove:
        typeof stored.lastMove === "boolean" ? stored.lastMove : DEFAULT_BOARD_PREFS.lastMove,
      legalMoves:
        typeof stored.legalMoves === "boolean" ? stored.legalMoves : DEFAULT_BOARD_PREFS.legalMoves,
      autoNext:
        typeof stored.autoNext === "boolean" ? stored.autoNext : DEFAULT_BOARD_PREFS.autoNext,
    };
  } catch {
    return DEFAULT_BOARD_PREFS;
  }
}

function storeBoardPrefs(prefs: BoardPrefs): void {
  try {
    window.localStorage.setItem(BOARD_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be refused (private mode); the choice then lasts for the session only.
  }
}

export function useBoardPrefs(): { prefs: BoardPrefs; set(change: Partial<BoardPrefs>): void } {
  const [prefs, setPrefs] = useState<BoardPrefs>(readBoardPrefs);
  const set = useCallback((change: Partial<BoardPrefs>): void => {
    setPrefs((current) => {
      const next = { ...current, ...change };
      storeBoardPrefs(next);
      return next;
    });
  }, []);
  return { prefs, set };
}
