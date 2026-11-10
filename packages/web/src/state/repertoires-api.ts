import {
  type MetOpening,
  type RepertoireScope,
  type RepertoireSummary,
  type RepertoiresResponse,
  RepertoiresResponseSchema,
  repertoireRootText,
} from "@chess-coach/shared";

// The whole answer: the drills and the openings the student's games met.
export type FetchRepertoireList = () => Promise<RepertoiresResponse>;

export const fetchRepertoireListFromServer: FetchRepertoireList = async () => {
  const response = await fetch("/api/repertoires");
  if (!response.ok) throw new Error(`repertoires: ${response.status}`);
  return RepertoiresResponseSchema.parse(await response.json());
};

export type FetchRepertoires = () => Promise<RepertoireSummary[]>;

export const fetchRepertoiresFromServer: FetchRepertoires = async () =>
  (await fetchRepertoireListFromServer()).repertoires;

// Builds the drill of a root. The server answers when the run ends, which takes minutes, and
// refuses with a message the student can read, so a failure carries that message.
export type AddOpening = (root: readonly string[]) => Promise<void>;

async function refusalOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message !== "") return body.message;
  } catch {
    // An answer with no readable body is told by its status.
  }
  return `The server answered ${response.status}.`;
}

export const addOpeningToServer: AddOpening = async (root) => {
  const response = await fetch("/api/openings/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sources: ["repertoire"], root }),
  });
  if (!response.ok) throw new Error(await refusalOf(response));
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

// A root that has a unit is already in the menu above, so only the others are offered.
export const withoutDrill = (met: readonly MetOpening[]): MetOpening[] =>
  met.filter((entry) => entry.repertoire_id === null);

// The book's name for the opening, else the line itself.
export const metNameOf = (entry: MetOpening): string =>
  entry.opening_name ?? repertoireRootText(entry.root);

export const rootKeyOf = (root: readonly string[]): string => root.join(" ");

export const gamesText = (games: number): string => `${games} ${games === 1 ? "game" : "games"}`;
