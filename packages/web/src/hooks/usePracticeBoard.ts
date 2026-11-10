import type { PromotionPiece, TrainingActivity } from "@chess-coach/shared";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { useCallback, useEffect, useMemo, useState } from "react";
import { boardOf, trainingView } from "../state/practice.js";
import {
  isLegalIn,
  localBoard,
  movesOf,
  positionAfter,
  startFenOf,
} from "../state/practice-item.js";
import { shownMoveOf } from "../state/repertoire-drill.js";
import type { ServerApi } from "./useServer.js";

// How long the right or wrong mark stays on the destination square; the final right mark stays.
export const BADGE_MS = 500;

const NO_SHAPES: readonly DrawShape[] = [];

export interface SquareBadge {
  square: string;
  kind: "check" | "cross";
}

export interface PracticeBoard {
  // What the board draws: the served position, a stepped-back one, or the free line.
  activity: TrainingActivity;
  bothSides: boolean;
  line: readonly string[] | null;
  hintSquare: string | null;
  // The arrow a repertoire drill draws for the move it shows: the answer of a new move, or the
  // move a second hint asked for.
  answerShapes: readonly DrawShape[];
  orientation: "white" | "black";
  badge: SquareBadge | null;
  // The free line's SAN while exploring (open item) or analysing (ended item); null otherwise.
  scratchLine: string[] | null;
  shownPly: number;
  tip: number;
  step(to: number): void;
  toggleScratch(): void;
  takeBack(): void;
  resetLine(): void;
  flip(): void;
  move(from: string, to: string, promotion?: PromotionPiece): void;
}

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

// Everything the board does on Practice besides grading: stepping back through the item's moves,
// free moves (through the server while the item is open, on the client once it ended), the
// mark on the destination square, and the orientation.
export function usePracticeBoard(
  training: TrainingActivity,
  send: ServerApi["send"],
): PracticeBoard {
  const view = trainingView(training);
  const open = view.open;
  const activityId = training.activity_id;
  const moves = movesOf(training);
  const tip = moves.length;
  const servedKey = `${training.served_at}:${training.item.position_in_queue}`;

  const [scratch, setScratch] = useState(false);
  const [localUcis, setLocalUcis] = useState<string[]>([]);
  const [viewPly, setViewPly] = useState<number | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [badge, setBadge] = useState<SquareBadge | null>(null);

  // A new item starts at its tip, graded, with no free line.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the served key names the item
  useEffect(() => {
    setScratch(false);
    setLocalUcis([]);
    setViewPly(null);
  }, [servedKey]);
  // The answer ends exploration: the card shows the result, analysis is a choice made after.
  useEffect(() => {
    if (!open) {
      setScratch(false);
      setLocalUcis([]);
    }
  }, [open]);

  const lastTry = training.last_try;
  const drill = training.repertoire ?? null;
  const badgeKey = `${servedKey}:${lastTry?.uci ?? ""}:${training.tries}:${tip}:${training.status}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the try the mark is for
  useEffect(() => {
    // A repertoire drill answers a miss with the piece going back and nothing else.
    if (!lastTry || (drill !== null && !lastTry.correct)) {
      setBadge(null);
      return;
    }
    const mark: SquareBadge = {
      square: lastTry.uci.slice(2, 4),
      kind: lastTry.correct ? "check" : "cross",
    };
    setBadge(mark);
    if (mark.kind === "check" && (training.status === "solved" || training.status === "rated")) {
      return;
    }
    const timer = setTimeout(() => setBadge(null), BADGE_MS);
    return () => clearTimeout(timer);
  }, [badgeKey]);

  const shownPly = scratch ? tip : Math.min(viewPly ?? tip, tip);
  const stepping = shownPly < tip;
  const step = useCallback(
    (to: number): void => {
      setViewPly(to >= tip ? null : Math.max(0, to));
    },
    [tip],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target) || scratch) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(shownPly - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        step(shownPly + 1);
      } else if (event.key === "f") {
        setFlipped((on) => !on);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scratch, shownPly, step]);

  const explored = training.exploring.line_san.length > 0;
  const toggleScratch = useCallback((): void => {
    if (scratch && open && explored) {
      send({ type: "explore", kind: "reset", activity_id: activityId });
    }
    setLocalUcis([]);
    setViewPly(null);
    setScratch((on) => !on);
  }, [scratch, open, explored, send, activityId]);

  const takeBack = useCallback((): void => {
    if (open) send({ type: "explore", kind: "undo", activity_id: activityId });
    else setLocalUcis((line) => line.slice(0, -1));
  }, [open, send, activityId]);

  const resetLine = useCallback((): void => {
    if (open) send({ type: "explore", kind: "reset", activity_id: activityId });
    else setLocalUcis([]);
  }, [open, send, activityId]);

  const local = scratch && !open ? localBoard(training.fen, localUcis) : null;

  const move = useCallback(
    (from: string, to: string, promotion?: PromotionPiece): void => {
      if (stepping) return;
      const uci = `${from}${to}${promotion ?? ""}`;
      if (scratch && open) {
        send({ type: "explore", kind: "move", uci, activity_id: activityId });
        return;
      }
      if (scratch) {
        if (local && isLegalIn(local.fen, uci)) setLocalUcis((line) => [...line, uci]);
        return;
      }
      send({ type: "try_move", uci, activity_id: activityId });
    },
    [stepping, scratch, open, send, activityId, local],
  );

  let activity: TrainingActivity;
  if (local) {
    activity = {
      ...training,
      fen: local.fen,
      turn: local.turn,
      last_move: local.lastMove,
      legal_moves: local.legalMoves,
      input_enabled: true,
    };
  } else if (stepping) {
    const position = positionAfter(
      startFenOf(training),
      moves.map((played) => played.uci),
      shownPly,
    );
    activity = {
      ...training,
      fen: position.fen,
      last_move: position.lastMove,
      legal_moves: [],
      input_enabled: false,
    };
  } else {
    activity = boardOf(training);
  }

  const shown = open && drill ? shownMoveOf(drill) : null;
  const shownUci = shown?.uci ?? null;
  const answerShapes = useMemo<readonly DrawShape[]>(
    () =>
      shownUci === null
        ? NO_SHAPES
        : ([
            { orig: shownUci.slice(0, 2), dest: shownUci.slice(2, 4), brush: "green" },
          ] as DrawShape[]),
    [shownUci],
  );

  const scratchLine = scratch ? (open ? training.exploring.line_san : (local?.sans ?? [])) : null;
  const atTip = !stepping && !local;
  return {
    activity,
    bothSides: scratch,
    line: atTip && training.gave_up ? training.solution_line : null,
    hintSquare: atTip ? training.hint_square : null,
    answerShapes: atTip ? answerShapes : NO_SHAPES,
    orientation: flipped
      ? training.orientation === "white"
        ? "black"
        : "white"
      : training.orientation,
    badge: atTip ? badge : null,
    scratchLine,
    shownPly,
    tip,
    step,
    toggleScratch,
    takeBack,
    resetLine,
    flip: () => setFlipped((on) => !on),
    move,
  };
}
