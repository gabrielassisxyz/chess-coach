import type {
  ActivityState,
  ErrorCode,
  TrainingActivity,
  TrainingMode,
  TrainingStatus,
} from "@chess-coach/shared";

import { Chess } from "chess.js";

export interface MotifCount {
  motif: string;
  count: number;
}

export type FetchMotifs = () => Promise<MotifCount[]>;

export const fetchMotifsFromServer: FetchMotifs = async () => {
  const response = await fetch("/api/puzzles/motifs");
  if (!response.ok) throw new Error(`motifs: ${response.status}`);
  const body = (await response.json()) as { motifs?: unknown };
  return Array.isArray(body.motifs) ? (body.motifs as MotifCount[]) : [];
};

export const STATUS_LABEL: Record<TrainingStatus, string> = {
  prompt: "Your move",
  in_progress: "Correct, keep going",
  solved: "Solved",
  failed: "Missed",
  rated: "Rated",
};

export interface TrainingView {
  header: string;
  status: string;
  expected: string | null;
  canRate: boolean;
  canAdvance: boolean;
  canExplore: boolean;
  canAnswer: boolean;
  advanceLabel: "Next" | "Finish";
  summary: TrainingActivity["summary"];
}

export function trainingOf(activity: ActivityState | null): TrainingActivity | null {
  return activity?.kind === "training" ? activity : null;
}

function headerOf(training: TrainingActivity): string {
  const { item } = training;
  const place = `${item.position_in_queue} of ${item.queue_length}`;
  if (item.kind === "card") return `Card ${place}`;
  return `${item.motif} puzzle ${place}`;
}

// The board shows the explored position while the item is served in another one.
export function boardOf(training: TrainingActivity): TrainingActivity {
  return { ...training, fen: training.exploring.fen };
}

// The answer is the first move of the explored line, played from the position the item was served in.
export function answerUciOf(training: TrainingActivity): string | null {
  const first = training.exploring.line_san[0];
  if (first === undefined) return null;
  try {
    const move = new Chess(training.fen).move(first);
    return `${move.from}${move.to}${move.promotion ?? ""}`;
  } catch {
    return null;
  }
}

export function trainingView(training: TrainingActivity): TrainingView {
  const { item, status, summary } = training;
  const answered = status === "solved" || status === "failed";
  const ended = summary !== null;
  const open = !ended && (status === "prompt" || status === "in_progress");
  const card = item.kind === "card";
  return {
    header: headerOf(training),
    status: STATUS_LABEL[status],
    expected: training.expected ? (training.expected.san ?? training.expected.uci) : null,
    canRate: card && answered && !ended,
    canAdvance: !ended && (answered || (card && status === "rated")),
    canExplore: open,
    canAnswer: open && training.exploring.line_san.length > 0,
    advanceLabel: item.position_in_queue === item.queue_length ? "Finish" : "Next",
    summary,
  };
}

// What to tell the student when a start was refused, ending on the thing they can do next.
export function startFailureText(
  mode: TrainingMode,
  motif: string,
  code: ErrorCode | null,
  message: string | null,
): string {
  if (code === "empty_queue" && mode === "srs") {
    return "Nothing is due right now. Cards come from the mistakes in a finished game: open one in Review and choose Create cards, or drill puzzles instead.";
  }
  if (code === "empty_queue" && mode === "openings") {
    return `There are no ${motif} opening drills yet. Import and grade some of your games in Review, then try again.`;
  }
  if (code === "empty_queue") {
    return motif === ""
      ? "There are no puzzles to drill. Restart the server to load the puzzle library."
      : `There are no ${motif} puzzles. Choose Any motif or another motif.`;
  }
  const reason = message ? `${message.replace(/\.$/, "")}. ` : "";
  return `Training could not start. ${reason}Try again; if it keeps failing, restart the server.`;
}

export const OFFLINE_START_TEXT =
  "The server is not connected. Wait until the chat header says connected, then try again.";
