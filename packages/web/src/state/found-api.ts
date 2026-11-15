import {
  type FoundPositionLine,
  type FoundPositionPhase,
  type FoundPositionsQuery,
  type FoundPositionsResponse,
  FoundPositionsResponseSchema,
  type FoundPositionView,
  type RepertoireScope,
} from "@chess-coach/shared";
import { dateLabel } from "./games.js";
import { type FirstTryBarTone, firstTryBarToneOf } from "./theme-stats-api.js";

export type FetchFoundPositions = (query: FoundPositionsQuery) => Promise<FoundPositionsResponse>;

// What starts a drill of the positions from the student's games. The filters narrow the queue the
// way they narrow the list; `position` names one listed position.
export interface FoundStartRequest extends FoundPositionsQuery {
  scope: RepertoireScope;
  position?: string | undefined;
}

export const foundPositionsUrlOf = (query: FoundPositionsQuery): string => {
  const params = new URLSearchParams();
  if (query.color !== undefined) params.set("color", query.color);
  if (query.phase !== undefined) params.set("phase", query.phase);
  if (query.opening !== undefined) params.set("opening", query.opening);
  const filters = params.toString();
  return filters === "" ? "/api/found-positions" : `/api/found-positions?${filters}`;
};

export const fetchFoundPositionsFromServer: FetchFoundPositions = async (query) => {
  const response = await fetch(foundPositionsUrlOf(query));
  if (!response.ok) throw new Error(`found positions: ${response.status}`);
  return FoundPositionsResponseSchema.parse(await response.json());
};

export const FOUND_PAGE_NOTE =
  "Positions from your games that you reached more than once or got wrong. Each one comes back until you find the best move.";
export const FOUND_LOADING_TEXT = "Loading the positions from your games.";
export const FOUND_FAILED_TEXT = "The positions from your games could not be loaded.";
export const FOUND_EMPTY_TEXT =
  "No position from your games yet. Import and grade games in Games, and the positions you got wrong or met twice appear here.";

export const FOUND_SECTIONS = [
  {
    section: "reached",
    title: "Reached more than once",
    empty: "No position reached more than once.",
  },
  { section: "mistakes", title: "Mistakes", empty: "No mistakes found." },
] as const;

export const FOUND_PHASE_LABEL: Record<FoundPositionPhase, string> = {
  opening: "Opening",
  middlegame: "Middlegame",
  endgame: "Endgame",
};

export const FOUND_COLOR_LABEL = { white: "White", black: "Black" } as const;

export const positionsText = (count: number): string =>
  `${count} ${count === 1 ? "position" : "positions"}`;

export const foundDueCount = (positions: readonly FoundPositionView[]): number =>
  positions.filter((position) => position.state === "due").length;

// "1.e4 e5 2.Nf3" from the first move. The server keeps only the last four plies once the position is
// past ply 8, so a line that starts later opens with an ellipsis, "… 23.Kh1 Qf2 24.e6 Nc8", and one
// that starts on a Black move names it, "… 3…exd4 4.cxd4".
export function foundLineText(line: FoundPositionLine): string {
  if (line.san.length === 0) return "";
  const moves = line.san.map((san, index) => {
    const ply = line.first_ply + index;
    const number = Math.ceil(ply / 2);
    if (ply % 2 === 1) return `${number}.${san}`;
    return index === 0 ? `${number}…${san}` : san;
  });
  return `${line.first_ply > 1 ? "… " : ""}${moves.join(" ")}`;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// When a scheduled position comes back, in the units the student thinks in: "in 3 days",
// "next week", "in 2 weeks". A position whose time came after the list was read is due by the clock.
export function foundReturnsText(nextReviewAt: string, now: Date): string {
  const wait = Date.parse(nextReviewAt) - now.getTime();
  if (Number.isNaN(wait)) return "scheduled";
  if (wait <= 0) return "due";
  if (wait < HOUR_MS) return "in under an hour";
  if (wait < DAY_MS) {
    const hours = Math.round(wait / HOUR_MS);
    return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.round(wait / DAY_MS);
  if (days === 1) return "tomorrow";
  if (days < 7) return `in ${days} days`;
  if (days < 14) return "next week";
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  if (days < 365) return `in ${Math.round(days / 30)} months`;
  const years = Math.round(days / 365);
  return years === 1 ? "in a year" : `in ${years} years`;
}

export function foundStateText(position: FoundPositionView, now: Date): string {
  if (position.state !== "scheduled") return position.state;
  return position.next_review_at === null
    ? "scheduled"
    : foundReturnsText(position.next_review_at, now);
}

// "Today" and "Yesterday" read as the start of a foot line; inside a sentence they take a lower case.
const inSentence = (label: string): string =>
  label === "Today" || label === "Yesterday" ? label.toLowerCase() : label;

export const foundLastText = (position: FoundPositionView, now: Date): string =>
  `Last ${inSentence(dateLabel(position.last_reached_at, now))}`;

const moveNumberOf = (position: FoundPositionView): number => Math.ceil(position.game.ply / 2);

// A mistake in the opening is named by the opening; one past it by its move and its opponent, which
// is also the name of a mistake in an opening the book does not name. A position reached more than
// once is named by its opening, else by its move.
export function foundTitleOf(position: FoundPositionView): string {
  const name = position.opening_name;
  const move = `Move ${moveNumberOf(position)}`;
  if (position.section === "reached") return name ?? move;
  if (position.phase === "opening" && name !== null) return name;
  const { opponent } = position.game;
  return opponent === null ? move : `${move} · vs ${opponent}`;
}

// The foot of a mistake: the date, then what the title left out, the opponent or the opening.
export function foundMistakeFootOf(position: FoundPositionView, now: Date): string {
  const date = dateLabel(position.game.played_at ?? position.last_reached_at, now);
  const named = position.phase === "opening" && position.opening_name !== null;
  const opponent = position.game.opponent === null ? null : `vs ${position.game.opponent}`;
  const rest = named ? opponent : position.opening_name;
  return rest === null ? date : `${date} · ${rest}`;
}

export const foundReachedText = (position: FoundPositionView): string =>
  `${position.reached_games}×`;

export const foundBestText = (position: FoundPositionView): string =>
  `${position.best_games} of ${position.reached_games}`;

// The exact share decides the colour: a rounded 55 that is really 54.5 stays red.
export function foundBestToneOf(position: FoundPositionView): FirstTryBarTone {
  if (position.reached_games <= 0) return "low";
  return firstTryBarToneOf((position.best_games / position.reached_games) * 100);
}

// The positions the Overview lists: the first ones due, in the order the page lists them.
export const firstDueFoundPositions = (
  positions: readonly FoundPositionView[],
  limit: number,
): FoundPositionView[] => positions.filter((position) => position.state === "due").slice(0, limit);
