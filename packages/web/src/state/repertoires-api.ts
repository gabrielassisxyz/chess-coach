import {
  type AddableOpening,
  AddableOpeningsResponseSchema,
  type CoverageReply,
  type CoverageStatus,
  type MetOpening,
  type RepertoireBranch,
  type RepertoireCoverage,
  RepertoireCoverageSchema,
  type RepertoireScope,
  type RepertoireSummary,
  type RepertoiresResponse,
  RepertoiresResponseSchema,
  repertoireMovesText,
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

// How the student weighs White's choices when a line is built: whole points over the three measures
// that add up to 6, which the server checks again and answers 400 for anything else.
export interface StylePoints {
  effectiveness: number;
  soundness: number;
  learnability: number;
}

export const STYLE_POINTS_TOTAL = 6;

// What the server weighs by when a request carries no points. A menu nobody touched sends none, so
// a change to the server's own default reaches it without a change here.
export const DEFAULT_STYLE_POINTS: Readonly<StylePoints> = {
  effectiveness: 2,
  soundness: 2,
  learnability: 2,
};

export interface StyleMeasure {
  key: keyof StylePoints;
  label: string;
  hint: string;
}

export const STYLE_MEASURES: readonly StyleMeasure[] = [
  {
    key: "effectiveness",
    label: "More wins",
    hint: "Moves that score best for White at your level",
  },
  { key: "soundness", label: "Less risk", hint: "Moves that stay closest to the engine's best" },
  {
    key: "learnability",
    label: "More intuitive moves",
    hint: "Moves that players at your level choose most often",
  },
];

export const stylePointsLeft = (points: StylePoints): number =>
  STYLE_POINTS_TOTAL - points.effectiveness - points.soundness - points.learnability;

export const isDefaultStylePoints = (points: StylePoints): boolean =>
  STYLE_MEASURES.every(({ key }) => points[key] === DEFAULT_STYLE_POINTS[key]);

// One point on or off a measure. A point comes off only where there is one, and goes on only
// where one is left, so the split never holds more than 6 or less than 0 on a measure.
export function moveStylePoint(
  points: StylePoints,
  key: keyof StylePoints,
  change: 1 | -1,
): StylePoints {
  const next = points[key] + change;
  if (next < 0 || (change === 1 && stylePointsLeft(points) === 0)) return points;
  return { ...points, [key]: next };
}

// Builds the drill of a root. The server answers when the run ends, which takes minutes, and
// refuses with a message the student can read, so a failure carries that message.
export type AddOpening = (root: readonly string[], points?: StylePoints) => Promise<AddedOpening>;

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

async function runRepertoireSource(
  line: { root?: readonly string[]; branch?: readonly string[] },
  points?: StylePoints,
) {
  let response: Response;
  try {
    response = await fetch("/api/openings/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sources: ["repertoire"], ...line, ...(points ? { points } : {}) }),
    });
  } catch {
    throw new Error(CONNECTION_LOST);
  }
  if (!response.ok) throw new Error(await refusalOf(response));
  return { truncated: await truncatedIn(response) };
}

export const addOpeningToServer: AddOpening = (root, points) =>
  runRepertoireSource({ root }, points);

// Builds another variation of the Italian from a branch: the line from 1.e4 through White's move
// at a branch point. Like a root, the server answers when the run ends.
export type AddVariation = (
  branch: readonly string[],
  points?: StylePoints,
) => Promise<AddedOpening>;

export const addVariationToServer: AddVariation = (branch, points) =>
  runRepertoireSource({ branch }, points);

export const SCOPE_LABEL: Record<RepertoireScope, string> = {
  recommended: "Recommended",
  due: "Everything due",
  all: "All moves",
};

// A drill of a group or a side is started from one of its variations, the first the page lists;
// the server widens it from there.
export const levelAnchorOf = (variations: readonly RepertoireSummary[]): number | null =>
  variations[0]?.id ?? null;

export const branchKey = (line: readonly string[], san: string): string => [...line, san].join(" ");

// "4.d3": White's move after a line that ends on Black's, as the book writes it.
export const branchMoveText = (line: readonly string[], san: string): string =>
  `${Math.floor(line.length / 2) + 1}.${san}`;

export const branchesOf = (
  branches: readonly RepertoireBranch[] | undefined,
  groupName: string,
): RepertoireBranch[] => (branches ?? []).filter((branch) => branch.group_name === groupName);

export const metRootKey = (root: readonly string[]): string => root.join(" ");

// A root that has a unit is already an opening on the page, so only the others are offered, and with
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

// The openings of the student's games that the panel offers, the most met first. The sort is stable,
// so the server's order settles a tie.
export const metToAddMostMetFirst = (
  met: readonly MetOpening[],
  unfinished: ReadonlySet<string>,
): MetOpening[] => metToAdd(met, unfinished).sort((a, b) => b.games - a.games);

// Every opening Black can leave the student's 1.e4 path with, met in a game or not, most played at
// the student's level first. The server asks the explorer for the shares, so the page reads this
// when the panel opens and never with the page.
export type FetchAddableOpenings = () => Promise<AddableOpening[]>;

export const fetchAddableOpeningsFromServer: FetchAddableOpenings = async () => {
  const response = await fetch("/api/openings/addable");
  if (!response.ok) throw new Error(`addable openings: ${response.status}`);
  return AddableOpeningsResponseSchema.parse(await response.json()).entries;
};

// The openings of one position Black leaves the path from, in the order the server gave them.
export interface AddableGroup {
  // The position's line as the book writes it: "1.e4", "1.e4 e5 2.Nf3".
  path: string;
  entries: AddableOpening[];
}

// Grouped by where Black leaves the path, the shorter path first. The group is read off the root
// itself, so no entry is ever left out of the list for a root of an unexpected length.
export function addableGroupsOf(entries: readonly AddableOpening[]): AddableGroup[] {
  const groups = new Map<string, AddableGroup & { plies: number }>();
  for (const entry of entries) {
    const path = entry.root.slice(0, -1);
    const key = path.join(" ");
    const group = groups.get(key) ?? {
      path: repertoireRootText(path),
      plies: path.length,
      entries: [],
    };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.plies - b.plies);
}

// Beside a name: the whole line for Black's first move, and for a later one only that move, since
// the heading over the group already says the path that leads to it.
export const addableMovesText = (entry: AddableOpening): string =>
  entry.root.length <= 2
    ? repertoireRootText(entry.root)
    : repertoireMovesText(entry.root.slice(-1), entry.root.length - 1);

// The line is named with the opening so a screen reader tells two rows apart by it.
export const addableLabelOf = (entry: AddableOpening): string =>
  `${entry.opening_name}, ${repertoireRootText(entry.root)}`;

export const addableGamesText = (games: number): string => `${metGamesText(games)} of yours`;

// What a search compares: lower case, without the dots of the move numbers and with one space
// between words, so "1.e4 c5", "e4 c5" and "1e4  C5" read alike.
const searchableText = (text: string): string =>
  text.toLowerCase().replaceAll(".", "").replace(/\s+/g, " ").trim();

// A row is kept when the text is in its name or in its moves, written in full or as the row shows
// them: what the student types is what the row says, or what the book writes.
export function addableMatches(entry: AddableOpening, query: string): boolean {
  const wanted = searchableText(query);
  if (wanted === "") return true;
  return [entry.opening_name, repertoireRootText(entry.root), addableMovesText(entry)].some(
    (text) => searchableText(text).includes(wanted),
  );
}

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

const NO_SCORE_TEXT = "Not enough games";

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
