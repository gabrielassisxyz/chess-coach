import {
  type CoverageReply,
  type CoverageStatus,
  type MetOpening,
  type RepertoireCoverage,
  RepertoireCoverageSchema,
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

// What a run that ended well says of itself: it stops short of a whole drill when it reaches the
// explorer's request limit, and running it again carries on from what it stored.
export interface AddedOpening {
  truncated: boolean;
}

// Builds the drill of a root. The server answers when the run ends, which takes minutes, and
// refuses with a message the student can read, so a failure carries that message.
export type AddOpening = (root: readonly string[]) => Promise<AddedOpening>;

const CONNECTION_LOST =
  "The connection ended before the run did. The server may still be building the drill. Reload the page later to see it.";

async function refusalOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string" && body.message !== "") return body.message;
  } catch {
    // An answer with no readable body is told by its status.
  }
  return `The server answered ${response.status}.`;
}

async function truncatedIn(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { repertoire?: { truncated?: unknown } };
    return body.repertoire?.truncated === true;
  } catch {
    return false;
  }
}

export const addOpeningToServer: AddOpening = async (root) => {
  let response: Response;
  try {
    response = await fetch("/api/openings/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sources: ["repertoire"], root }),
    });
  } catch {
    throw new Error(CONNECTION_LOST);
  }
  if (!response.ok) throw new Error(await refusalOf(response));
  return { truncated: await truncatedIn(response) };
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

export const metRootKey = (root: readonly string[]): string => root.join(" ");

// A root that has a unit is already in the menu above, so only the others are offered, and with
// them the roots whose last run stopped short: their unit is partial, and adding the root again
// carries on from what is stored.
export const metToAdd = (met: readonly MetOpening[], unfinished: ReadonlySet<string>) =>
  met.filter((entry) => entry.repertoire_id === null || unfinished.has(metRootKey(entry.root)));

// The book's name for the opening, else the line itself.
export const metNameOf = (entry: MetOpening): string =>
  entry.opening_name ?? repertoireRootText(entry.root);

// What names a row to a screen reader. The line goes with the name because a root the book leaves
// unnamed carries the name of the opening before it, so two rows can share a name.
export const metLabelOf = (entry: MetOpening): string =>
  entry.opening_name === null
    ? repertoireRootText(entry.root)
    : `${entry.opening_name}, ${repertoireRootText(entry.root)}`;

export const metGamesText = (games: number): string => `${games} ${games === 1 ? "game" : "games"}`;

// What one variation covers, read from its stored moves when the student opens it.
export type FetchCoverage = (repertoireId: number) => Promise<RepertoireCoverage>;

export const fetchCoverageFromServer: FetchCoverage = async (repertoireId) => {
  const response = await fetch(`/api/repertoires/${repertoireId}/coverage`);
  if (!response.ok) throw new Error(`coverage: ${response.status}`);
  return RepertoireCoverageSchema.parse(await response.json());
};

export const COVERAGE_STATUS_TEXT: Record<CoverageStatus, string> = {
  covered: "Covered",
  gap: "Gap",
  not_required: "Not required",
};

export const NO_SCORE_TEXT = "Not enough games";

// How often a game reaches a position, as "1 in N". The whole number stays on its own side of the
// goal, so a position that needs no answer never reads as common as one that does; one no game is
// known to have reached has no chance to state.
export function oneInText(incidence: number, goalOneIn: number): string {
  if (incidence <= 0) return "Too few games";
  const oneIn = Math.round(1 / incidence);
  const needsAnswer = incidence >= 1 / goalOneIn;
  return `1 in ${needsAnswer ? Math.min(oneIn, goalOneIn) : Math.max(oneIn, goalOneIn + 1)}`;
}

// A reply the opening fixes is not met by chance, so it has no chance to state.
export const replyChanceText = (reply: CoverageReply, goalOneIn: number): string =>
  reply.source === "setup" ? "Opening move" : oneInText(reply.incidence, goalOneIn);

export const percentText = (percent: number | null): string =>
  percent === null ? NO_SCORE_TEXT : `${percent.toFixed(1)}%`;

export const soundnessText = (soundness: number | null): string =>
  soundness === null ? NO_SCORE_TEXT : String(soundness);

// "3...Bc5": Black's move after a line that ends on White's, as the book writes it.
export const replyMoveText = (line: readonly string[], san: string): string =>
  `${Math.floor(line.length / 2) + 1}...${san}`;
