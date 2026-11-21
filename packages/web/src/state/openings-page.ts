import type {
  RepertoireFigures,
  RepertoireGroupSummary,
  RepertoireLevel,
  RepertoireScope,
  RepertoireScopeCounts,
  RepertoireSummary,
  RepertoiresResponse,
} from "@chess-coach/shared";
import { NONE } from "./practice.js";
import { levelAnchorOf, SCOPE_LABEL } from "./repertoires-api.js";

export type OpeningsSide = RepertoireSummary["side"];
export type OpeningsFilter = "all" | OpeningsSide;

export const OPENINGS_FILTERS: readonly { value: OpeningsFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "white", label: "As White" },
  { value: "black", label: "As Black" },
];

export const OPENINGS_SIDES: readonly OpeningsSide[] = ["white", "black"];

export const SIDE_HEADING: Record<OpeningsSide, string> = { white: "White", black: "Black" };

// An opening is the variations that share a name. The server's group entry carries what the whole
// opening serves and its figures, and the variations under it come from the same answer.
export interface OpeningCardModel {
  group: RepertoireGroupSummary;
  variations: RepertoireSummary[];
}

export interface OpeningsSectionModel {
  side: OpeningsSide;
  openings: OpeningCardModel[];
  // What a drill of the whole side serves; null while the answer holds no entry for the side.
  moves: RepertoireScopeCounts | null;
}

// Both colours are always drawn, an empty one saying so, so the page never loses a section the
// student expects to find there.
export function sectionsOf(listing: RepertoiresResponse): OpeningsSectionModel[] {
  return OPENINGS_SIDES.map((side) => ({
    side,
    openings: (listing.groups ?? [])
      .filter((group) => group.side === side)
      .map((group) => ({
        group,
        variations: listing.repertoires.filter(
          (variation) => variation.side === side && variation.group_name === group.group_name,
        ),
      }))
      .filter((opening) => opening.variations.length > 0),
    moves: listing.sides?.find((entry) => entry.side === side)?.moves ?? null,
  }));
}

export const sectionAnchorOf = (section: OpeningsSectionModel): number | null =>
  levelAnchorOf(section.openings.flatMap((opening) => opening.variations));

const pluralOf = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

export const openingsCountText = (count: number): string => pluralOf(count, "opening", "openings");

export const variationsCountText = (count: number): string =>
  pluralOf(count, "variation", "variations");

export const NO_LINE_TEXT = "no line yet";

// Beside a colour's heading: how many openings it holds and how many moves are due in all of them.
export function sectionSummaryText(section: OpeningsSectionModel): string {
  if (section.openings.length === 0) return NO_LINE_TEXT;
  return `${openingsCountText(section.openings.length)} · ${section.moves?.due ?? 0} due`;
}

// Under an opening's name: how many variations it has, then the moves they all start with.
export function openingMetaText(variations: number, line: string | null | undefined): string {
  const count = variationsCountText(variations);
  return line ? `${count} · ${line}` : count;
}

// What a card or a row draws in its five cells. A variation and an opening carry the same figures,
// which a fixture may leave out.
export type FigureSource = { moves: RepertoireScopeCounts } & {
  [Key in keyof RepertoireFigures]?: RepertoireFigures[Key] | undefined;
};

export interface FigureValues {
  moves: string;
  due: number;
  remembered: string;
  // The bar's fill as a share of the games that reached the line; null draws no bar.
  inLineShare: number | null;
  // "S of G games", or the no-value dash when no game reached the line.
  inLineText: string;
  coverage: string;
}

const wholePercentText = (percent: number): string => `${Math.round(percent)}%`;

export function figureValuesOf(source: FigureSource): FigureValues {
  const remembered = source.remembered_30d;
  const inLine = source.in_line;
  const reached = inLine !== undefined && inLine.of > 0;
  return {
    moves: source.moves_total === undefined ? NONE : String(source.moves_total),
    due: source.moves.due,
    remembered:
      remembered === undefined || remembered.of === 0
        ? NONE
        : wholePercentText((remembered.right * 100) / remembered.of),
    inLineShare: reached ? Math.min(1, inLine.stayed / inLine.of) : null,
    inLineText: reached
      ? `${inLine.stayed} of ${inLine.of} ${inLine.of === 1 ? "game" : "games"}`
      : NONE,
    coverage:
      source.covered_percent === null || source.covered_percent === undefined
        ? NONE
        : wholePercentText(source.covered_percent),
  };
}

// The start in flight: the repertoire it names, its scope, and the level it widens to.
export interface RepertoireStarting {
  repertoireId: number;
  scope: RepertoireScope;
  level?: RepertoireLevel | undefined;
}

// What a train button drills: one variation, every variation of an opening, or every opening of a
// colour. A level above one variation is started from the first variation it lists, named for a
// screen reader since the buttons of a page read alike.
export interface TrainTarget {
  repertoireId: number;
  level: Extract<RepertoireLevel, "variation" | "group" | "side">;
  name: string;
}

export const isStartingTarget = (
  starting: RepertoireStarting | null,
  target: TrainTarget,
): boolean =>
  starting?.repertoireId === target.repertoireId &&
  (starting.level ?? "variation") === target.level;

export interface TrainMenuEntry {
  scope: RepertoireScope;
  text: string;
  count: number;
}

export interface TrainButtonModel {
  label: string;
  // The scope the main part of the button sends.
  scope: RepertoireScope;
  // What the chevron opens; empty where the button has nothing else to offer.
  menu: TrainMenuEntry[];
  // With no moves to recommend the button is a plain one, since all it can offer is every move.
  outlined: boolean;
}

export const TRAIN_ALL_MOVES_TEXT = "Train all moves";

// Most missed sits between Everything due and All moves and is offered only when a drill of it
// would serve a move: a count of 0, or none sent, leaves it out.
function trainMenuOf(counts: RepertoireScopeCounts): TrainMenuEntry[] {
  const missed = counts.missed ?? 0;
  return [
    { scope: "due", text: SCOPE_LABEL.due, count: counts.due },
    ...(missed > 0 ? [{ scope: "missed" as const, text: SCOPE_LABEL.missed, count: missed }] : []),
    { scope: "all", text: SCOPE_LABEL.all, count: counts.all },
  ];
}

export function trainButtonOf(counts: RepertoireScopeCounts, forSide: boolean): TrainButtonModel {
  if (counts.recommended === 0) {
    // Nothing to recommend leaves a plain button, since all it could offer is every move, unless
    // moves were missed: those are drilled whether or not they are due, so the menu stays.
    const hasMissed = (counts.missed ?? 0) > 0;
    return {
      label: TRAIN_ALL_MOVES_TEXT,
      scope: "all",
      menu: hasMissed ? trainMenuOf(counts) : [],
      outlined: !hasMissed,
    };
  }
  return {
    label: forSide ? `Train all · ${counts.recommended}` : `Train ${counts.recommended}`,
    scope: "recommended",
    menu: trainMenuOf(counts),
    outlined: false,
  };
}
