/*
 * The board is @lichess-org/chessground (GPL-3.0-or-later), which draws and animates but has no
 * rules of its own: every legal destination comes from the server's `legal_moves`.
 *
 * Styling, all imported by main.tsx:
 * - chessground.base.css, from the package: structural board CSS.
 * - chessground.cburnett.css, from the package: the cburnett piece set by Colin M.L. Burnett
 *   (GPL-2.0-or-later, as shipped with chessground).
 * - styles/board.css: the one theme file, squares and highlights in this app's tokens.
 */
import type { ActivityState, PromotionPiece } from "@chess-coach/shared";
import { Chessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { Config } from "@lichess-org/chessground/config";
import type { Color, Key } from "@lichess-org/chessground/types";
import { useEffect, useRef, useState } from "react";
import { checkedColor, destsFrom, promotionsFor } from "../state/play.js";
import { PromotionChooser } from "./PromotionChooser.js";

export type BoardFactory = (element: HTMLElement, config: Config) => Api;

export interface BoardProps {
  activity: ActivityState;
  onMove(from: string, to: string, promotion?: PromotionPiece): void;
  // Bumped by the caller when the server refused something, so the board snaps back to the truth.
  syncToken?: number;
  createBoard?: BoardFactory | undefined;
}

interface PendingPromotion {
  from: string;
  to: string;
  pieces: PromotionPiece[];
}

function toConfig(activity: ActivityState): Config {
  const lastMove = activity.last_move ? [activity.last_move.from, activity.last_move.to] : [];
  return {
    fen: activity.fen,
    orientation: activity.orientation,
    turnColor: activity.turn,
    check: checkedColor(activity.fen),
    lastMove: lastMove as Key[],
    movable: {
      free: false,
      // chessground's merge assigns undefined, which is how a disabled board drops the colour;
      // its typings do not admit it.
      color: (activity.input_enabled ? activity.orientation : undefined) as Color,
      dests: destsFrom(activity.legal_moves),
    },
  };
}

export function Board({ activity, onMove, syncToken = 0, createBoard = Chessground }: BoardProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const [pending, setPending] = useState<PendingPromotion | null>(null);
  const [resync, setResync] = useState(0);

  // Chessground callbacks are registered once at creation, so they read the latest props here.
  const latest = useRef({ activity, onMove });
  latest.current = { activity, onMove };

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const api = createBoard(element, {
      ...toConfig(latest.current.activity),
      draggable: { enabled: false },
      premovable: { enabled: false },
      selectable: { enabled: true },
      highlight: { lastMove: true, check: true },
      events: {
        move: (from, to) => {
          const { activity: current, onMove: send } = latest.current;
          const pieces = promotionsFor(current.legal_moves, from, to);
          if (pieces) setPending({ from, to, pieces });
          else send(from, to);
        },
      },
    });
    apiRef.current = api;
    return () => {
      api.destroy();
      apiRef.current = null;
    };
  }, [createBoard]);

  // syncToken and resync are deliberate triggers: set() with an unchanged position still
  // restores a piece the student moved that the server never accepted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    apiRef.current?.set(toConfig(activity));
  }, [activity, syncToken, resync]);

  const choose = (piece: PromotionPiece): void => {
    if (!pending) return;
    onMove(pending.from, pending.to, piece);
    setPending(null);
  };

  const cancel = (): void => {
    setPending(null);
    setResync((count) => count + 1);
  };

  return (
    // tabIndex -1 keeps the container out of the tab order but lets it take focus, so the shared
    // focus ring has something to draw on if a script or a click lands there.
    <div className="board" tabIndex={-1}>
      <div ref={elementRef} className="board__surface" data-testid="board" />
      {pending ? (
        <PromotionChooser
          to={pending.to}
          pieces={pending.pieces}
          orientation={activity.orientation}
          onChoose={choose}
          onCancel={cancel}
        />
      ) : null}
    </div>
  );
}
