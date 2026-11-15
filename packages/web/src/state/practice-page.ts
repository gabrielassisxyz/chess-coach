import type { RepertoiresResponse } from "@chess-coach/shared";
import { useCallback, useState } from "react";

// The navigation of the Practice hub, in the order it lists its entries. Puzzle themes is a part of
// the Overview rather than a page: it shows the Overview at its themes section.
export const PRACTICE_NAV_GROUPS = [
  { label: "Train", entries: ["overview", "puzzle-themes", "from-my-games", "openings"] },
  { label: "Stats", entries: ["dashboard", "improvement-areas", "strengths", "openings-played"] },
] as const;

export type PracticeEntry = (typeof PRACTICE_NAV_GROUPS)[number]["entries"][number];
export type PracticePage = Exclude<PracticeEntry, "puzzle-themes">;

const PRACTICE_ENTRIES: readonly string[] = PRACTICE_NAV_GROUPS.flatMap((group) => group.entries);

export const PRACTICE_ENTRY_LABEL: Record<PracticeEntry, string> = {
  overview: "Overview",
  "puzzle-themes": "Puzzle themes",
  "from-my-games": "From my games",
  openings: "Openings",
  dashboard: "Dashboard",
  "improvement-areas": "Improvement areas",
  strengths: "Strengths",
  "openings-played": "Openings played",
};

// The pages whose content is still to come; until then each says so.
export const UNBUILT_PRACTICE_PAGES: readonly PracticePage[] = ["dashboard", "openings-played"];

export const practicePageOf = (entry: PracticeEntry): PracticePage =>
  entry === "puzzle-themes" ? "overview" : entry;

export const PRACTICE_PAGE_STORAGE_KEY = "chess-coach.practice-page";

const FIRST_ENTRY: PracticeEntry = "overview";

const isPracticeEntry = (value: string | null): value is PracticeEntry =>
  value !== null && PRACTICE_ENTRIES.includes(value);

// The hub comes back to the entry the student chose last, after a session and after a reload.
export function readPracticeEntry(): PracticeEntry {
  try {
    const stored = window.localStorage.getItem(PRACTICE_PAGE_STORAGE_KEY);
    return isPracticeEntry(stored) ? stored : FIRST_ENTRY;
  } catch {
    return FIRST_ENTRY;
  }
}

function storePracticeEntry(entry: PracticeEntry): void {
  try {
    window.localStorage.setItem(PRACTICE_PAGE_STORAGE_KEY, entry);
  } catch {
    // Storage can be refused (private mode); the page then lasts for the session only.
  }
}

export function usePracticeEntry(): { entry: PracticeEntry; choose(entry: PracticeEntry): void } {
  const [entry, setEntry] = useState<PracticeEntry>(readPracticeEntry);
  const choose = useCallback((next: PracticeEntry): void => {
    storePracticeEntry(next);
    setEntry(next);
  }, []);
  return { entry, choose };
}

// What the Openings entry counts: the moves due now on each side, as the server counts a side, so a
// move two variations share is counted once. An answer that lists no side counts nothing.
export const openingsDueOf = (listing: RepertoiresResponse): number =>
  (listing.sides ?? []).reduce((sum, side) => sum + side.moves.due, 0);
