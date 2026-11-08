import type {
  ActivityState,
  ErrorCode,
  ExploredEvent,
  PausedTraining,
  ProgressResponse,
  TrainingActivity,
  TrainingMode,
  TrainingStatus,
} from "@chess-coach/shared";
import {
  LIBRARY_PRACTICE_MOTIFS,
  LICHESS_OTHER_PRACTICE_MOTIFS,
  LICHESS_PRACTICE_MOTIFS,
} from "@chess-coach/shared";

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

export type DrillSize = 5 | 10 | 20;
export const DRILL_SIZES: readonly DrillSize[] = [5, 10, 20];
export const DEFAULT_DRILL_SIZE: DrillSize = 10;

// Opening drills are their own card, so their puzzles stay out of the motif rows.
export const OPENING_MOTIFS = {
  white: "opening-white",
  black: "opening-black",
  italian: "opening-italian",
} as const;

// Stored motifs read like `back_rank_mate`; Lichess themes read like `hangingPiece`.
// The hub and the heading show words. Fixed choices use their shared labels first.
const LICHESS_SERVED_MOTIFS = [...LICHESS_PRACTICE_MOTIFS, ...LICHESS_OTHER_PRACTICE_MOTIFS];
const FIXED_MOTIFS = [...LICHESS_SERVED_MOTIFS, ...LIBRARY_PRACTICE_MOTIFS];

const PRACTICE_LABEL_OF: ReadonlyMap<string, string> = new Map(
  FIXED_MOTIFS.map((entry) => [entry.theme, entry.label]),
);

const PRACTICE_DESCRIPTION_OF: ReadonlyMap<string, string> = new Map(
  FIXED_MOTIFS.map((entry) => [entry.theme, entry.description]),
);

export function motifLabel(motif: string): string {
  const fixed = PRACTICE_LABEL_OF.get(motif);
  if (fixed) return fixed;
  const spaced = motif
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (spaced.length === 0) return "";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function motifDescription(motif: string): string | null {
  return PRACTICE_DESCRIPTION_OF.get(motif) ?? null;
}

export interface MotifRow {
  motif: string;
  count: number;
  // Share solved over the last 30 days; null when the motif has had no attempt in that window,
  // undefined when the row hides its rate (a Lichess theme, whose history is not grouped by theme).
  rate30d: number | null | undefined;
  attempts30d: number;
  solved30d: number;
  label: string;
  description: string | null;
  kind: "lichess" | "library";
}

// The hub offers the fourteen Lichess motifs, the five other choices a Lichess theme serves, and
// the library's opening traps. Library fork, pin and skewer merge into the Lichess rows; the
// imported-only fallback tactics and every opening drill stay out of this card.
export function motifRows(list: MotifCount[], progress: ProgressResponse | null): MotifRow[] {
  const counts = new Map(list.map((entry) => [entry.motif, entry.count]));
  const byMotif = new Map((progress?.puzzles_by_motif ?? []).map((entry) => [entry.motif, entry]));
  const lichess = LICHESS_SERVED_MOTIFS.map(
    (entry): MotifRow => ({
      motif: entry.theme,
      count: 0,
      rate30d: undefined,
      attempts30d: 0,
      solved30d: 0,
      label: entry.label,
      description: entry.description,
      kind: "lichess",
    }),
  );
  const library = LIBRARY_PRACTICE_MOTIFS.map((entry): MotifRow => {
    const found = byMotif.get(entry.theme);
    return {
      motif: entry.theme,
      count: counts.get(entry.theme) ?? 0,
      rate30d: found?.success_rate_30d ?? null,
      attempts30d: found?.attempts_30d ?? 0,
      solved30d: found?.solved_30d ?? 0,
      label: entry.label,
      description: entry.description,
      kind: "library",
    };
  });
  return [...lichess, ...library];
}

export function openingCount(list: MotifCount[], color: "white" | "black"): number {
  return list.find((entry) => entry.motif === OPENING_MOTIFS[color])?.count ?? 0;
}

export function italianOpeningCount(list: MotifCount[]): number {
  return list.find((entry) => entry.motif === OPENING_MOTIFS.italian)?.count ?? 0;
}

const CLASSIFICATION_ORDER = ["blunder", "mistake", "inaccuracy", "opening", "teaching"];
const CLASSIFICATION_LABEL: Record<string, string> = {
  blunder: "Blunders",
  mistake: "Mistakes",
  inaccuracy: "Inaccuracies",
  opening: "Opening",
  teaching: "Teaching",
};

export function dueBreakdown(
  byClassification: Record<string, number>,
): { key: string; label: string; count: number }[] {
  const rank = (key: string): number => {
    const index = CLASSIFICATION_ORDER.indexOf(key);
    return index === -1 ? CLASSIFICATION_ORDER.length : index;
  };
  return Object.entries(byClassification)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, count]) => ({
      key,
      label: CLASSIFICATION_LABEL[key] ?? key.charAt(0).toUpperCase() + key.slice(1),
      count,
    }));
}

// The em-dash is the design's mark for "no value"; spelled as an escape so no prose tool mistakes it for a habit.
export const NONE = "\u2014";

export function percent(rate: number | null): string {
  return rate === null ? NONE : `${Math.round(rate * 100)}%`;
}

function dayWord(then: Date, now: Date): string {
  const midnight = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(then) - midnight(now)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return then.toLocaleDateString("en-US", { weekday: "short" });
}

export function nextBatchParts(
  iso: string | null,
  count: number,
  now: Date,
): { label: string; when: string } | null {
  if (iso === null) return null;
  const then = new Date(iso);
  const clock = `${String(then.getHours()).padStart(2, "0")}:${String(then.getMinutes()).padStart(2, "0")}`;
  return { label: `Next batch ${count}`, when: `${dayWord(then, now)} ${clock}` };
}

export const STATUS_LABEL: Record<TrainingStatus, string> = {
  prompt: "Your move",
  in_progress: "Correct, keep going",
  solved: "Solved",
  failed: "Missed",
  rated: "Rated",
};

export const MISSED_TRY = "Not it, try again";

export interface TrainingView {
  status: string;
  expected: string | null;
  answered: boolean;
  canRate: boolean;
  canAdvance: boolean;
  // The item takes a dropped move and offers the solution.
  open: boolean;
  advanceLabel: "Next" | "Finish";
  summary: TrainingActivity["summary"];
}

// What the coach panel says while it is idle and the student is mid-item.
export function practiceIdleLabel(activity: ActivityState | null): string | undefined {
  const training = trainingOf(activity);
  if (!training || training.summary !== null) return undefined;
  if (training.status === "prompt" || training.status === "in_progress") {
    return "waiting for your answer";
  }
  const card = training.item.kind === "card";
  if (training.status === "rated") return "card rated";
  if (training.status === "failed") return "solution shown";
  return card ? "card answered" : "puzzle solved";
}

export const PRACTICE_WAITING_LABEL = "o coach está analisando sua resposta";

// What the coach panel says once an item ended and its notification went out, until the coach's
// reply starts streaming or the turn ends. The flag lives in the chat state because only the
// chat events know the reply arrived; the activity alone cannot tell.
export function practiceWaitingLabel(
  activity: ActivityState | null,
  replyPending: boolean,
): string | undefined {
  const training = trainingOf(activity);
  if (!replyPending || !training || training.summary !== null) return undefined;
  return training.status === "solved" || training.status === "failed"
    ? PRACTICE_WAITING_LABEL
    : undefined;
}

export function trainingOf(activity: ActivityState | null): TrainingActivity | null {
  return activity?.kind === "training" ? activity : null;
}

const MODE_LABEL: Record<TrainingMode, string> = {
  srs: "Due cards",
  puzzles: "Puzzles",
  openings: "Opening drill",
};

export function resumeLabelOf(paused: PausedTraining): string {
  return `Resume: ${MODE_LABEL[paused.mode]} · ${paused.position + 1} of ${paused.size}`;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function elapsedSince(servedAt: string, now: number): number {
  return Math.max(0, now - Date.parse(servedAt));
}

// The preview is in hours; the buttons say it the way the student thinks about it.
export function formatInterval(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 24) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} d`;
}

export const RATING_WORDS: Record<number, string> = {
  0: "Blank \u2014 no idea",
  1: "Wrong, recognised it",
  2: "Wrong, nearly there",
  3: "Right, with effort",
  4: "Right, hesitated",
  5: "Easy",
};

export interface TrailLine {
  key: string;
  text: string;
  offset: string;
}

const BACK = "\u2014 back";
const RESET = "\u2014 reset";
const ANSWERED = "\u2014 answered";

// Each event carries the line as it stood afterwards, so an undo or a reset is shown against
// the line it took apart. After an answer the graded line closes the list: it is the last move
// when the student answered right after playing it, and a line of its own after a take back.
export function trailLines(trail: ExploredEvent[], answered: boolean): TrailLine[] {
  let previous: string[] = [];
  const lines = trail.map((event): TrailLine => {
    const shown = event.kind === "move" ? event.line_san : previous;
    const mark = event.kind === "undo" ? ` ${BACK}` : event.kind === "reset" ? ` ${RESET}` : "";
    previous = event.line_san;
    return {
      key: String(event.seq),
      text: `${shown.join(" ")}${mark}`,
      offset: `after ${Math.round(event.at_ms / 1000)}s`,
    };
  });
  const last = trail.at(-1);
  if (!answered || !last || last.line_san.length === 0) return lines;
  if (last.kind === "move") {
    const closing = lines[lines.length - 1] as TrailLine;
    closing.text = `${closing.text} ${ANSWERED}`;
    return lines;
  }
  return [
    ...lines,
    { key: "answered", text: `${last.line_san.join(" ")} ${ANSWERED}`, offset: "" },
  ];
}

// The move that ended the item; a card or puzzle given up before any try has none.
export function playedSanOf(training: TrainingActivity): string | null {
  const last = training.last_try;
  return last ? (last.san ?? last.uci) : null;
}

export function lookedAtMs(training: TrainingActivity): number {
  return training.exploring.trail.at(-1)?.at_ms ?? 0;
}

// The board shows the explored position while the item is served in another one.
export function boardOf(training: TrainingActivity): TrainingActivity {
  return { ...training, fen: training.exploring.fen };
}

export function trainingView(training: TrainingActivity): TrainingView {
  const { item, status, summary } = training;
  const answered = status === "solved" || status === "failed";
  const ended = summary !== null;
  const open = !ended && (status === "prompt" || status === "in_progress");
  const card = item.kind === "card";
  const missed = open && training.last_try?.correct === false;
  return {
    status: missed ? MISSED_TRY : STATUS_LABEL[status],
    expected: training.expected ? (training.expected.san ?? training.expected.uci) : null,
    answered,
    canRate: card && answered && !ended,
    canAdvance: !ended && (answered || (card && status === "rated")),
    open,
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
    return "Nothing is due right now. Cards come from the mistakes in a finished game: open one in Games and choose Create cards, or drill puzzles instead.";
  }
  if (code === "empty_queue" && mode === "openings") {
    return `There are no ${motifLabel(motif)} opening drills yet. Import and grade some of your games in Games, then try again.`;
  }
  if (code === "empty_queue") {
    return motif === ""
      ? "There are no puzzles to drill. Restart the server to load the puzzle library."
      : `There are no ${motifLabel(motif)} puzzles. Choose Any motif or another motif.`;
  }
  const reason = message ? `${message.replace(/\.$/, "")}. ` : "";
  return `Training could not start. ${reason}Try again; if it keeps failing, restart the server.`;
}

export const OFFLINE_START_TEXT =
  "The server is not connected. Wait until the chat header says connected, then try again.";

export interface LastSession {
  solved: number;
  failed: number;
}

const LAST_SESSION_KEY = "chess-coach:last-session";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

// The finished queue's tally, kept so the hub can show it after the run ends.
export function loadLastSession(): LastSession | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(LAST_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastSession>;
    if (typeof parsed.solved !== "number" || typeof parsed.failed !== "number") return null;
    return { solved: parsed.solved, failed: parsed.failed };
  } catch {
    return null;
  }
}

export function saveLastSession(summary: LastSession): void {
  try {
    storage()?.setItem(LAST_SESSION_KEY, JSON.stringify(summary));
  } catch {
    // A full or blocked store must not break the end of a queue.
  }
}

export function clearLastSession(): void {
  try {
    storage()?.removeItem(LAST_SESSION_KEY);
  } catch {
    // Clearing is best effort; a stale line is harmless.
  }
}
