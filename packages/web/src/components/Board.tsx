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
import { ANIMATION_MS, type BoardPrefs, DEFAULT_BOARD_PREFS } from "../state/board-prefs.js";
import {
  checkedColor,
  destsFrom,
  type LineStep,
  positionsAlong,
  promotionsFor,
} from "../state/play.js";
import { PromotionChooser } from "./PromotionChooser.js";

export type BoardFactory = (element: HTMLElement, config: Config) => Api;

export const LINE_STEP_MS = 600;

export interface BoardProps {
  activity: ActivityState;
  onMove(from: string, to: string, promotion?: PromotionPiece): void;
  // Bumped by the caller when the server refused something, so the board snaps back to the truth.
  syncToken?: number;
  // Exploration plays both sides of a line, so the board may move the side to play, whoever it is.
  bothSides?: boolean;
  // UCI moves played one by one from the activity's position, LINE_STEP_MS apart; the board then
  // stays on the last one. A new line, or a new position under it, starts again from the first.
  line?: readonly string[] | null | undefined;
  // Origin square of the expected move after a hint; rendered with the hint highlight.
  hintSquare?: string | null | undefined;
  // Which side is at the bottom; the activity's own orientation unless the student flipped it.
  orientation?: Color | undefined;
  // A right or wrong mark on a square, drawn over the board.
  badge?: SquareBadge | null | undefined;
  // Coordinates, animation and highlights, the same set on every screen.
  prefs?: BoardPrefs | undefined;
  createBoard?: BoardFactory | undefined;
}

export interface SquareBadge {
  square: string;
  kind: "check" | "cross";
}

interface PendingPromotion {
  from: string;
  to: string;
  pieces: PromotionPiece[];
}

function turnOf(fen: string): Color {
  return fen.split(" ")[1] === "b" ? "black" : "white";
}

function toConfig(
  activity: ActivityState,
  bothSides: boolean,
  shown: LineStep | null,
  hintSquare: string | null | undefined,
  orientation: Color,
  prefs: BoardPrefs,
): Config {
  const last = shown ?? activity.last_move;
  const lastMove = last ? [last.from, last.to] : [];
  const fen = shown ? shown.fen : activity.fen;
  return {
    fen,
    orientation,
    coordinates: prefs.coordinates !== "off",
    coordinatesOnSquares: prefs.coordinates === "inside",
    animation: {
      enabled: prefs.animation !== "off",
      duration: ANIMATION_MS[prefs.animation],
    },
    turnColor: shown ? turnOf(shown.fen) : activity.turn,
    check: checkedColor(fen),
    lastMove: lastMove as Key[],
    movable: {
      free: false,
      // chessground's merge assigns undefined, which is how a disabled board drops the colour;
      // its typings do not admit it.
      color: (activity.input_enabled
        ? bothSides
          ? "both"
          : activity.orientation
        : undefined) as Color,
      dests: destsFrom(activity.legal_moves),
      showDests: prefs.legalMoves,
    },
    // Always a map: chessground keeps the previous one when the key is absent, so a cleared
    // hint would stay on the square into the next item.
    highlight: {
      lastMove: prefs.lastMove,
      check: true,
      custom: new Map(hintSquare ? [[hintSquare as Key, "hint"]] : []),
    },
  };
}

// The step of `line` on the board right now: none at first, then one more every LINE_STEP_MS.
function useLinePlayback(fen: string, line: readonly string[] | null): LineStep | null {
  const key = line && line.length > 0 ? `${fen} ${line.join(" ")}` : null;
  const steps = key && line ? positionsAlong(fen, line) : [];
  const [played, setPlayed] = useState<{ key: string | null; count: number }>({
    key: null,
    count: 0,
  });
  const count = played.key === key ? played.count : 0;
  useEffect(() => {
    if (key === null || count >= steps.length) return;
    const timer = setTimeout(() => setPlayed({ key, count: count + 1 }), LINE_STEP_MS);
    return () => clearTimeout(timer);
  }, [key, count, steps.length]);
  return count > 0 ? (steps[count - 1] ?? null) : null;
}

// The mark sits on the square's centre, so it reads from the piece that just landed there.
function BadgeMark({ badge, orientation }: { badge: SquareBadge; orientation: Color }) {
  const file = badge.square.charCodeAt(0) - "a".charCodeAt(0);
  const rank = Number(badge.square[1]) - 1;
  const column = orientation === "white" ? file : 7 - file;
  const row = orientation === "white" ? 7 - rank : rank;
  const style = { left: `${(column + 0.5) * 12.5}%`, top: `${(row + 0.5) * 12.5}%` };
  return (
    <span
      className="board__badge"
      data-kind={badge.kind}
      data-testid="square-badge"
      style={style}
      aria-hidden="true"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {badge.kind === "check" ? (
          <path d="M3 8.5l3.5 3.5L13 4.5" />
        ) : (
          <path d="M4 4l8 8M12 4l-8 8" />
        )}
      </svg>
    </span>
  );
}

export function Board({
  activity,
  onMove,
  syncToken = 0,
  bothSides = false,
  line = null,
  hintSquare = null,
  orientation,
  badge = null,
  prefs = DEFAULT_BOARD_PREFS,
  createBoard = Chessground,
}: BoardProps) {
  const facing = orientation ?? activity.orientation;
  const elementRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const [pending, setPending] = useState<PendingPromotion | null>(null);
  const [resync, setResync] = useState(0);
  const shown = useLinePlayback(activity.fen, line);

  // Chessground callbacks are registered once at creation, so they read the latest props here.
  const latest = useRef({ activity, onMove, bothSides, hintSquare, facing, prefs });
  latest.current = { activity, onMove, bothSides, hintSquare, facing, prefs };

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const api = createBoard(element, {
      ...toConfig(
        latest.current.activity,
        latest.current.bothSides,
        null,
        latest.current.hintSquare,
        latest.current.facing,
        latest.current.prefs,
      ),
      draggable: { enabled: false },
      premovable: { enabled: false },
      selectable: { enabled: true },
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
  // restores a piece the student moved that the server never accepted. The line step is keyed by
  // its position, since the step object is rebuilt on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    apiRef.current?.set(toConfig(activity, bothSides, shown, hintSquare, facing, prefs));
  }, [activity, bothSides, hintSquare, facing, prefs, syncToken, resync, shown?.fen]);

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
      {badge ? <BadgeMark badge={badge} orientation={facing} /> : null}
      {pending ? (
        <PromotionChooser
          to={pending.to}
          pieces={pending.pieces}
          orientation={facing}
          onChoose={choose}
          onCancel={cancel}
        />
      ) : null}
    </div>
  );
}
