import { Chessground } from "@lichess-org/chessground";
import type { Config } from "@lichess-org/chessground/config";
import type { Color } from "@lichess-org/chessground/types";
import { useEffect, useRef } from "react";
import type { BoardFactory } from "./Board.js";

export interface MiniBoardProps {
  fen: string;
  // The side at the bottom, which is the side to move in a position from the student's games.
  orientation: Color;
  createBoard?: BoardFactory | undefined;
}

// A board that only shows a position: chessground with its events left unbound (`viewOnly`), nothing
// movable, no highlights, no coordinates and no animation, since a list of them is drawn at once.
// Board.tsx stays the one board a student plays on.
const READ_ONLY_BOARD: Config = {
  viewOnly: true,
  coordinates: false,
  disableContextMenu: true,
  animation: { enabled: false },
  highlight: { lastMove: false, check: false },
  movable: { free: false },
  draggable: { enabled: false },
  selectable: { enabled: false },
  premovable: { enabled: false },
  drawable: { enabled: false, visible: false },
};

export function MiniBoard({ fen, orientation, createBoard = Chessground }: MiniBoardProps) {
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const api = createBoard(element, { ...READ_ONLY_BOARD, fen, orientation });
    return () => api.destroy();
  }, [createBoard, fen, orientation]);

  // The pieces carry no labels and a list of boards would read the same label out many times; the
  // card's title, its moves and its chips tell a screen reader what the board shows.
  return (
    <div className="found-board" aria-hidden="true">
      <div ref={surface} className="found-board__surface" data-testid="found-board" />
    </div>
  );
}
