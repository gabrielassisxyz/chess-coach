import {
  type MetOpening,
  type OpeningPuzzles,
  type OpeningPuzzlesResponse,
  OpeningPuzzlesResponseSchema,
  openingFamilyOf,
} from "@chess-coach/shared";
import type { OpeningsSectionModel } from "./openings-page.js";
import { type FirstTryBarTone, firstTryBarToneOf, firstTryPercentOf } from "./theme-stats-api.js";

export type FetchOpeningPuzzles = (names: readonly string[]) => Promise<OpeningPuzzlesResponse>;

// The route takes the names in one parameter, separated by a comma with no space after it: a comma
// inside a name always has one, so the server splits only on the separators.
export const fetchOpeningPuzzlesFromServer: FetchOpeningPuzzles = async (names) => {
  const response = await fetch(
    `/api/puzzles/openings?names=${encodeURIComponent(names.join(","))}`,
  );
  if (!response.ok) throw new Error(`opening puzzles: ${response.status}`);
  return OpeningPuzzlesResponseSchema.parse(await response.json());
};

// A colour's block shows at most this many openings, which is also the most it asks about, well
// under the 40 names the route answers.
export const OPENING_PUZZLE_TILE_LIMIT = 12;

// The openings one colour's block asks about: its stored openings in the page's order and, for
// White, the families of the openings met in games in the order the answer lists them, none twice.
// A met opening with no name has no family and is skipped. Black has no met list: the app reads the
// openings opponents played only in the student's White games.
export function openingPuzzleNamesOf(
  section: OpeningsSectionModel,
  met: readonly Pick<MetOpening, "opening_name">[],
): string[] {
  const stored = section.openings.map(({ group }) => group.group_name);
  const families =
    section.side === "white" ? met.map(({ opening_name }) => openingFamilyOf(opening_name)) : [];
  const names = new Set<string>();
  for (const name of [...stored, ...families]) {
    if (!name || names.size >= OPENING_PUZZLE_TILE_LIMIT) continue;
    names.add(name);
  }
  return [...names];
}

// An opening with no puzzle has nothing to start, so it gets no tile.
export const openingTilesOf = (response: OpeningPuzzlesResponse): OpeningPuzzles[] =>
  response.entries.filter((entry) => entry.puzzles > 0);

// What a tile says of the student's results on its opening: the share solved first try over the
// last 30 days, in the band the theme tiles use, or "new" when nothing was played there yet.
export type OpeningTileFigure =
  | { kind: "rate"; percent: number; tone: FirstTryBarTone }
  | { kind: "new" };

export function openingTileFigureOf(entry: OpeningPuzzles): OpeningTileFigure {
  if (entry.played_30d === 0) return { kind: "new" };
  const percent = firstTryPercentOf({ played: entry.played_30d, first_try: entry.first_try_30d });
  return { kind: "rate", percent, tone: firstTryBarToneOf(percent) };
}

export const puzzleCountText = (count: number): string =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "puzzle" : "puzzles"}`;
