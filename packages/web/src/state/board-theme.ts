import { useCallback, useEffect, useState } from "react";

export const BOARD_THEMES = [
  { id: "lichess", label: "Lichess" },
  { id: "chesscom", label: "Chess.com" },
  { id: "slate", label: "Slate" },
  { id: "teal", label: "Deep teal" },
] as const;

export type BoardTheme = (typeof BOARD_THEMES)[number]["id"];

export const BOARD_STORAGE_KEY = "chess-coach.board";

const DEFAULT_BOARD: BoardTheme = "lichess";

function isBoardTheme(value: unknown): value is BoardTheme {
  return BOARD_THEMES.some((theme) => theme.id === value);
}

export function readBoardTheme(): BoardTheme {
  try {
    const stored = window.localStorage.getItem(BOARD_STORAGE_KEY);
    return isBoardTheme(stored) ? stored : DEFAULT_BOARD;
  } catch {
    return DEFAULT_BOARD;
  }
}

// tokens.css carries the Lichess squares as the base set, so that theme is the absence of the
// attribute rather than a value.
export function applyBoardTheme(theme: BoardTheme): void {
  if (theme === DEFAULT_BOARD) delete document.documentElement.dataset.board;
  else document.documentElement.dataset.board = theme;
}

function storeBoardTheme(theme: BoardTheme): void {
  try {
    window.localStorage.setItem(BOARD_STORAGE_KEY, theme);
  } catch {
    // Storage can be refused (private mode); the choice then lasts for the session only.
  }
}

export function useBoardTheme(): { theme: BoardTheme; choose: (theme: BoardTheme) => void } {
  const [theme, setTheme] = useState<BoardTheme>(readBoardTheme);

  useEffect(() => applyBoardTheme(theme), [theme]);

  const choose = useCallback((next: BoardTheme) => {
    storeBoardTheme(next);
    setTheme(next);
  }, []);

  return { theme, choose };
}
