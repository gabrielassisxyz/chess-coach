import type { FoundPositionState, RepertoireScope } from "@chess-coach/shared";
import type { ListedFoundPosition } from "../db/found-positions.js";

/** The most positions a `recommended` drill of the positions from the student's games serves. */
export const FOUND_RECOMMENDED_SIZE = 10;

export function foundPositionStateOf(position: ListedFoundPosition, now: Date): FoundPositionState {
  if (position.nextReviewAt === null) return "new";
  return Date.parse(position.nextReviewAt) <= now.getTime() ? "due" : "scheduled";
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// A card by when it falls due, the oldest first; a new position by when it was found, the latest
// first. The id settles a tie, so a list and a drill read at one moment agree on the order.
const byNextReview = (a: ListedFoundPosition, b: ListedFoundPosition): number =>
  byText(a.nextReviewAt ?? "", b.nextReviewAt ?? "") || byText(a.id, b.id);
const byLatestFound = (a: ListedFoundPosition, b: ListedFoundPosition): number =>
  byText(b.firstFoundAt, a.firstFoundAt) || byText(a.id, b.id);

/**
 * The positions a drill of this scope serves, in the order it serves them: `recommended` the due
 * cards and then the new positions, at most ten in all; `due` the due cards alone; `all` the due
 * cards, the new positions and then every other card. There is no daily cap on new positions.
 */
export function selectFoundDrillPositions<T extends ListedFoundPosition>(
  positions: readonly T[],
  scope: RepertoireScope,
  now: Date,
): T[] {
  const inState = (state: FoundPositionState): T[] =>
    positions.filter((position) => foundPositionStateOf(position, now) === state);
  const due = inState("due").sort(byNextReview);
  if (scope === "due") return due;
  const fresh = inState("new").sort(byLatestFound);
  if (scope === "recommended") return [...due, ...fresh].slice(0, FOUND_RECOMMENDED_SIZE);
  return [...due, ...fresh, ...inState("scheduled").sort(byNextReview)];
}
