import type { AnalysisEvent, TrainingActivity } from "@chess-coach/shared";
import type { DrawShape } from "@lichess-org/chessground/draw";
import { useEffect } from "react";
import { type EnginePrefs, useEnginePrefs } from "../state/engine-prefs.js";
import { MATE_CP, signedPawns } from "../state/play.js";
import type { TrainingView } from "../state/practice.js";
import type { ServerApi } from "./useServer.js";

// A position is asked about once the board has settled on it, not on every step of the arrows.
export const ANALYSE_DEBOUNCE_MS = 250;

export type EvalTone = "neutral" | "better" | "worse";

export interface EngineView {
  prefs: EnginePrefs;
  setPrefs(change: Partial<EnginePrefs>): void;
  // The switch works only once the item ended; while it is open the engine stays off.
  enabled: boolean;
  on: boolean;
  toggle(): void;
  // "Stockfish · off", "Stockfish · thinking" or "Stockfish · depth 18".
  label: string;
  // The first line's score from the student's side, as "+1.3", "−0.4" or "M"; null while off.
  evalText: string | null;
  evalTone: EvalTone;
  analysis: AnalysisEvent | null;
  shapes: DrawShape[];
}

function studentView(scoreCp: number, orientation: "white" | "black"): number {
  return orientation === "white" ? scoreCp : -scoreCp;
}

function evalTextOf(cp: number): string {
  return Math.abs(cp) >= MATE_CP ? "M" : signedPawns(cp);
}

// The board's brushes, best line first; a position with fewer lines uses fewer arrows.
export const LINE_BRUSHES = ["green", "blue", "yellow", "red", "paleBlue"] as const;

function shapesOf(analysis: AnalysisEvent): DrawShape[] {
  return analysis.lines.flatMap((line, index) => {
    const first = line.moves[0];
    const brush = LINE_BRUSHES[index];
    if (!first || !brush) return [];
    return [{ orig: first.slice(0, 2), dest: first.slice(2, 4), brush }] as DrawShape[];
  });
}

// Runs the engine on the position the board shows once the item ended: on the tip, on a stepped
// position, or on the free line the student is analysing. The server refuses it while open.
export function useEngineAnalysis(
  training: TrainingActivity,
  view: TrainingView,
  fen: string,
  server: Pick<ServerApi, "send" | "analysis">,
): EngineView {
  const { prefs, set } = useEnginePrefs();
  const enabled = !view.open;
  const on = prefs.on && enabled;
  const activityId = training.activity_id;
  const { send, analysis: latest } = server;
  // The answer on hand is for this position at these settings; the engine echoes the request,
  // so a position with fewer legal lines than asked is never asked again.
  const fresh =
    latest !== null &&
    latest.fen === fen &&
    latest.depth === prefs.depth &&
    latest.requested_lines === prefs.lines;

  useEffect(() => {
    if (!on || fresh) return;
    const timer = setTimeout(() => {
      send({
        type: "analyse",
        activity_id: activityId,
        fen,
        lines: prefs.lines,
        depth: prefs.depth,
      });
    }, ANALYSE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [on, fresh, fen, prefs.lines, prefs.depth, activityId, send]);

  const analysis = on && latest?.fen === fen ? latest : null;
  const first = analysis?.lines[0];
  const cp = first ? studentView(first.score_cp, training.orientation) : null;
  return {
    prefs,
    setPrefs: set,
    enabled,
    on,
    toggle: () => set({ on: !prefs.on }),
    label: !on
      ? "Stockfish · off"
      : analysis
        ? `Stockfish · depth ${analysis.depth}`
        : "Stockfish · thinking",
    evalText: cp === null ? null : evalTextOf(cp),
    evalTone: cp === null || cp === 0 ? "neutral" : cp > 0 ? "better" : "worse",
    analysis,
    shapes: analysis ? shapesOf(analysis) : [],
  };
}
