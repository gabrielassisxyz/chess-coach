import {
  type MetOpening,
  type OpeningDrill,
  type OpeningDrillColor,
  type OpeningDrillsResponse,
  OpeningDrillsResponseSchema,
  openingFamilyOf,
  UNNAMED_OPENING,
} from "@chess-coach/shared";
import { percent } from "./practice.js";
import { metRootKey } from "./repertoires-api.js";

// The drills from the student's games, grouped by colour and opening family.
export type FetchOpeningDrills = () => Promise<OpeningDrillsResponse>;

export const fetchOpeningDrillsFromServer: FetchOpeningDrills = async () => {
  const response = await fetch("/api/openings/drills");
  if (!response.ok) throw new Error(`drills: ${response.status}`);
  return OpeningDrillsResponseSchema.parse(await response.json());
};

// What the hub needs to start one of those drills: the start in flight, whether the engine can grade
// it, and the call that sends it.
export interface OpeningDrillControls {
  drills: OpeningDrillsResponse;
  engineMissing: boolean;
  starting: { color: OpeningDrillColor; opening: string } | null;
  onStart(color: OpeningDrillColor, opening: string): void;
}

export const UNNAMED_LABEL = "Other positions";

const isUnnamed = (drill: OpeningDrill): boolean => drill.opening === UNNAMED_OPENING;

export const drillNameOf = (drill: OpeningDrill): string =>
  isUnnamed(drill) ? UNNAMED_LABEL : drill.opening;

// Names the start to a screen reader, where "Drill" alone would not say which opening it drills.
export const drillTargetOf = (drill: OpeningDrill, color: OpeningDrillColor): string =>
  `${isUnnamed(drill) ? "other positions" : drill.opening} as ${color === "white" ? "White" : "Black"}`;

export const drillPositionsText = (positions: number): string =>
  `${positions} ${positions === 1 ? "position" : "positions"}`;

// The first-try rate of the last 30 days with the counts behind it, or null when the family had no
// attempt in that time: a rate of nothing is no rate, and the row shows none.
export function drillRateText(drill: OpeningDrill): string | null {
  if (drill.attempts_30d === 0) return null;
  const rate = drill.first_try_30d / drill.attempts_30d;
  return `${percent(rate)} · ${drill.first_try_30d} of ${drill.attempts_30d}`;
}

// Where each drill of a colour goes, so that an opening appears once: in the menu of the stored
// opening that has its name, else on the row of an opening met in games that is not stored yet, else
// on a row of its own. The unnamed positions are never an opening, so they always have a row.
export interface DrillPlacement {
  inMenu: ReadonlyMap<string, OpeningDrill>;
  onMetRow: ReadonlyMap<string, OpeningDrill>;
  plain: OpeningDrill[];
}

export function placeDrills(
  drills: readonly OpeningDrill[],
  menuNames: ReadonlySet<string>,
  metRows: readonly MetOpening[],
): DrillPlacement {
  const inMenu = new Map<string, OpeningDrill>();
  const onMetRow = new Map<string, OpeningDrill>();
  const plain: OpeningDrill[] = [];
  for (const drill of drills) {
    // Several met roots can share a family; the first, the likeliest, carries its drill.
    const met = metRows.find((row) => openingFamilyOf(row.opening_name) === drill.opening);
    if (isUnnamed(drill)) plain.push(drill);
    else if (menuNames.has(drill.opening)) inMenu.set(drill.opening, drill);
    else if (met) onMetRow.set(metRootKey(met.root), drill);
    else plain.push(drill);
  }
  return { inMenu, onMetRow, plain };
}
