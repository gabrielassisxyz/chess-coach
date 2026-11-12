import type { PromotionPiece, TrainingActivity } from "@chess-coach/shared";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { Chess } from "chess.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MOVE_PAUSE_MS, type MovePause } from "../components/Board.js";
import { positionsAlong } from "../state/play.js";
import { boardOf, trainingView } from "../state/practice.js";
import {
  isLegalIn,
  legalMovesIn,
  localBoard,
  movesOf,
  positionAfter,
  startFenOf,
} from "../state/practice-item.js";
import { shownMoveOf } from "../state/repertoire-drill.js";
import type { ServerApi } from "./useServer.js";

// How long the right or wrong mark stays on the destination square; the final right mark stays.
// As long as the pause, so a wrong move's cross lasts while the piece rests where it landed.
export const BADGE_MS = MOVE_PAUSE_MS;

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
  // What the board shows before the state the last try produced; null off the graded tip.
  pause: MovePause | null;
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

const servedKeyOf = (training: TrainingActivity): string =>
  `${training.served_at}:${training.item.position_in_queue}`;

// The positions the board passes through before the state a try produced: the wrong move where it
// landed, or the student's right move and every move played after it but the last, which is the
// state itself. None when the state is not a new try on the same item, when nothing answered a
// right move, and for a miss in a line drill, whose piece goes straight back.
function pauseAfterTry(before: TrainingActivity, after: TrainingActivity): MovePause | null {
  const lastTry = after.last_try;
  if (!lastTry || servedKeyOf(before) !== servedKeyOf(after)) return null;
  const played = movesOf(after);
  const key = `${servedKeyOf(after)}:${after.tries}:${played.length}`;
  if (!lastTry.correct) {
    if (after.repertoire || after.tries !== before.tries + 1) return null;
    const landed = positionsAlong(boardOf(after).fen, [lastTry.uci]);
    return landed.length === 1 ? { key, steps: landed } : null;
  }
  const from = movesOf(before).length;
  if (played[from]?.uci !== lastTry.uci) return null;
  const ucis = played.map((move) => move.uci);
  const steps = positionsAlong(startFenOf(after), ucis).slice(from, -1);
  return steps.length > 0 && steps.length === played.length - from - 1 ? { key, steps } : null;
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
  const itemTip = moves.length;
  const servedKey = servedKeyOf(training);

  // Each state the server sends replaces the pause, so a newer one, a new item among them, is
  // shown at once. Kept in state, since the pause is worked out against the state before it.
  const [tracked, setTracked] = useState<{ training: TrainingActivity; pause: MovePause | null }>(
    () => ({ training, pause: null }),
  );
  let pause = tracked.pause;
  if (tracked.training !== training) {
    pause = pauseAfterTry(tracked.training, training);
    setTracked({ training, pause });
  }

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
  const badgeKey = `${servedKey}:${lastTry?.uci ?? ""}:${training.tries}:${itemTip}:${training.status}`;
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

  const tip =
    itemTip + (scratch ? (open ? training.exploring.line_san.length : localUcis.length) : 0);
  const shownPly = Math.min(viewPly ?? tip, tip);
  const stepping = shownPly < tip;
  const step = useCallback(
    (to: number): void => {
      setViewPly(to >= tip ? null : Math.max(0, to));
    },
    [tip],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
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
  }, [shownPly, step]);

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
  const shownLocal =
    local && stepping && shownPly >= itemTip
      ? localBoard(training.fen, localUcis.slice(0, shownPly - itemTip))
      : local;

  const move = useCallback(
    (from: string, to: string, promotion?: PromotionPiece): void => {
      if (stepping && (!scratch || shownPly < itemTip)) return;
      const uci = `${from}${to}${promotion ?? ""}`;
      if (scratch && open) {
        for (let ply = shownPly; ply < tip; ply += 1) {
          if (!send({ type: "explore", kind: "undo", activity_id: activityId })) return;
        }
        if (send({ type: "explore", kind: "move", uci, activity_id: activityId })) {
          setViewPly(null);
        }
        return;
      }
      if (scratch) {
        if (shownLocal && isLegalIn(shownLocal.fen, uci)) {
          setLocalUcis((line) => [...line.slice(0, shownPly - itemTip), uci]);
          setViewPly(null);
        }
        return;
      }
      send({ type: "try_move", uci, activity_id: activityId });
    },
    [stepping, scratch, shownPly, itemTip, open, send, activityId, tip, shownLocal],
  );

  const itemLastUci = moves.at(-1)?.uci;
  const itemLastMove = itemLastUci
    ? { from: itemLastUci.slice(0, 2), to: itemLastUci.slice(2, 4) }
    : null;
  let activity: TrainingActivity;
  if (stepping && (!scratch || shownPly < itemTip)) {
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
  } else if (scratch && open && stepping) {
    const board = new Chess(training.fen);
    let lastMove = itemLastMove;
    for (const san of training.exploring.line_san.slice(0, shownPly - itemTip)) {
      const played = board.move(san);
      lastMove = { from: played.from, to: played.to };
    }
    const fen = board.fen();
    activity = {
      ...training,
      fen,
      turn: board.turn() === "w" ? "white" : "black",
      last_move: lastMove,
      legal_moves: legalMovesIn(fen),
      input_enabled: true,
    };
  } else if (shownLocal) {
    activity = {
      ...training,
      fen: shownLocal.fen,
      turn: shownLocal.turn,
      last_move: shownLocal.lastMove ?? (shownPly === itemTip ? itemLastMove : null),
      legal_moves: shownLocal.legalMoves,
      input_enabled: true,
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
    pause: !scratch && !stepping ? pause : null,
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
