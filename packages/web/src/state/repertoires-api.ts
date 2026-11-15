import {
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
