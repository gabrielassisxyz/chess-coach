import type { ActivityState, TrainingActivity, TrainingStatus } from "@chess-coach/shared";

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

export function trainingView(training: TrainingActivity): TrainingView {
  const { item, status, summary } = training;
  const answered = status === "solved" || status === "failed";
  const ended = summary !== null;
  const card = item.kind === "card";
  return {
    header: headerOf(training),
    status: STATUS_LABEL[status],
    expected: training.expected ? (training.expected.san ?? training.expected.uci) : null,
    canRate: card && answered && !ended,
    canAdvance: !ended && (answered || (card && status === "rated")),
    advanceLabel: item.position_in_queue === item.queue_length ? "Finish" : "Next",
    summary,
  };
}
