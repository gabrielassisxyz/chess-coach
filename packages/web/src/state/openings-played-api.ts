import {
  type FoundPositionView,
  type PlayedOpening,
  type PlayedOpeningsResponse,
  PlayedOpeningsResponseSchema,
  type PlayedVariation,
  type PlayedWindow,
} from "@chess-coach/shared";
import type { FoundStartRequest } from "./found-api.js";
import { type FirstTryBarTone, firstTryBarToneOf } from "./theme-stats-api.js";

export type FetchOpeningsPlayed = (days: PlayedWindow) => Promise<PlayedOpeningsResponse>;

export const fetchOpeningsPlayedFromServer: FetchOpeningsPlayed = async (days) => {
  const response = await fetch(`/api/openings/played?days=${encodeURIComponent(days)}`);
  if (!response.ok) throw new Error(`openings played: ${response.status}`);
  return PlayedOpeningsResponseSchema.parse(await response.json());
};

export type PlayedSide = "white" | "black";
export type PlayedSection = "mine" | "against";

export const PLAYED_SIDE_CHOICES: readonly { value: PlayedSide; label: string }[] = [
  { value: "white", label: "As White" },
  { value: "black", label: "As Black" },
];

const SIDE_NAME: Record<PlayedSide, string> = { white: "White", black: "Black" };

export const PLAYED_PAGE_NOTE =
  "Every opening from your own games. Open a row to see the variations; drill any of them.";
export const PLAYED_LOADING_TEXT = "Loading your openings.";
export const PLAYED_FAILED_TEXT = "Your openings could not be loaded.";
export const PLAYED_SECTION_EMPTY_TEXT = "No game in this period yet.";

export const PLAYED_SECTIONS: readonly {
  section: PlayedSection;
  title: string;
  note: string;
}[] = [
  { section: "mine", title: "Your openings", note: "Lines you chose to play" },
  { section: "against", title: "Played against", note: "What your opponents chose against you" },
];

// The side the card on the Dashboard and the total line of the page say a game was played from.
export const playedSideText = (side: PlayedSide): string => `as ${SIDE_NAME[side]}`;

export const playedGamesText = (games: number): string =>
  `${games} ${games === 1 ? "game" : "games"}`;

export const playedTotalText = (games: number, side: PlayedSide): string =>
  `${playedGamesText(games)} ${playedSideText(side)}`;

export const playedNoGamesText = (side: PlayedSide): string =>
  `No game ${playedSideText(side)} in this period. Import games in Games to see your openings here.`;

type Figures = Pick<PlayedOpening, "games" | "wins" | "draws" | "losses">;

// What the student scored, a win counting one and a draw a half, as a whole percentage.
export function playedScoreOf({
  games,
  wins,
  draws,
}: Pick<Figures, "games" | "wins" | "draws">): number {
  if (games <= 0) return 0;
  return Math.round(((wins + draws / 2) / games) * 100);
}

// The band of the figure the student reads, the rounded score, so that a 55 is never drawn red.
export const playedScoreToneOf = (score: number): FirstTryBarTone => firstTryBarToneOf(score);

export const playedCountsText = ({ wins, draws, losses }: Figures): string =>
  `${wins} / ${draws} / ${losses}`;

export const playedBarLabelOf = ({ wins, draws, losses }: Figures): string =>
  `${wins} won, ${draws} drawn, ${losses} lost`;

// The share of the games each outcome holds, in the order the bar draws them.
export function playedSharesOf({ games, wins, draws, losses }: Figures) {
  const share = (count: number): number => (games > 0 ? (count / games) * 100 : 0);
  return [
    { outcome: "won", share: share(wins) },
    { outcome: "drawn", share: share(draws) },
    { outcome: "lost", share: share(losses) },
  ] as const;
}

// A row with nothing in it is not drawn.
export const playedRowsOf = <Row extends Pick<Figures, "games">>(rows: readonly Row[]): Row[] =>
  rows.filter((row) => row.games > 0);

export interface PlayedTopEntry {
  side: PlayedSide;
  section: PlayedSection;
  opening: PlayedOpening;
}

// The openings the Dashboard lists: the ones with the most games across both colours and both
// lists. The sort is stable, so a tie keeps White's before Black's and a chosen line before one
// played against.
export function topPlayedOpeningsOf(data: PlayedOpeningsResponse, limit: number): PlayedTopEntry[] {
  return (["white", "black"] as const)
    .flatMap((side) =>
      PLAYED_SECTIONS.flatMap(({ section }) =>
        playedRowsOf(data[side][section]).map((opening) => ({ side, section, opening })),
      ),
    )
    .sort((first, second) => second.opening.games - first.opening.games)
    .slice(0, limit);
}

// The full names the stored positions of a colour carry; a variation is drilled only where one does.
export function foundOpeningNamesOf(
  positions: readonly FoundPositionView[],
  side: PlayedSide,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const position of positions) {
    if (position.color === side && position.opening_name !== null) names.add(position.opening_name);
  }
  return names;
}

export const playedDrillRequestOf = (
  side: PlayedSide,
  variation: Pick<PlayedVariation, "full_name">,
): FoundStartRequest => ({ scope: "all", color: side, opening: variation.full_name });
