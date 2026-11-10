import {
  type RepertoireScope,
  type RepertoireSummary,
  RepertoiresResponseSchema,
} from "@chess-coach/shared";

export type FetchRepertoires = () => Promise<RepertoireSummary[]>;

export const fetchRepertoiresFromServer: FetchRepertoires = async () => {
  const response = await fetch("/api/repertoires");
  if (!response.ok) throw new Error(`repertoires: ${response.status}`);
  return RepertoiresResponseSchema.parse(await response.json()).repertoires;
};

export const SCOPE_LABEL: Record<RepertoireScope, string> = {
  recommended: "Recommended",
  due: "Everything due",
  all: "All moves",
};

export interface OpeningMenu {
  name: string;
  due: number;
  variations: RepertoireSummary[];
}

export interface SideMenu {
  side: RepertoireSummary["side"];
  heading: string;
  openings: OpeningMenu[];
}

const SIDES: readonly RepertoireSummary["side"][] = ["white", "black"];

// The hub groups openings under the side the student plays, White first. An opening lists its
// variations in the order the server gave them, and its due count adds theirs up.
export function menuOf(list: readonly RepertoireSummary[]): SideMenu[] {
  return SIDES.flatMap((side): SideMenu[] => {
    const openings = new Map<string, OpeningMenu>();
    for (const entry of list.filter((candidate) => candidate.side === side)) {
      const opening = openings.get(entry.group_name) ?? {
        name: entry.group_name,
        due: 0,
        variations: [],
      };
      opening.due += entry.moves.due;
      opening.variations.push(entry);
      openings.set(entry.group_name, opening);
    }
    if (openings.size === 0) return [];
    const word = side === "white" ? "White" : "Black";
    return [{ side, heading: `${word} openings`, openings: [...openings.values()] }];
  });
}
