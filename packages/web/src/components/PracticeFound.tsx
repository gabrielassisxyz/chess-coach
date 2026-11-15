import type {
  FoundPositionCounts,
  FoundPositionPhase,
  FoundPositionsQuery,
  FoundPositionsResponse,
  FoundPositionView,
  RepertoireScope,
} from "@chess-coach/shared";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { Loaded } from "../hooks/useLoaded.js";
import {
  type FetchFoundPositions,
  FOUND_EMPTY_TEXT,
  FOUND_FAILED_TEXT,
  FOUND_LOADING_TEXT,
  FOUND_PAGE_NOTE,
  FOUND_PHASE_LABEL,
  FOUND_SECTIONS,
  type FoundStartRequest,
  positionsText,
} from "../state/found-api.js";
import type { BoardFactory } from "./Board.js";
import { FoundSection, type FoundSectionProps } from "./FoundCards.js";
import { FilterGroup, TrainControl } from "./FoundControls.js";

// What the hub is starting, as far as this page tells its own buttons apart: the scope of a header
// start, and the position of a card's.
export interface FoundStarting {
  scope: RepertoireScope;
  position?: string | undefined;
}

export interface PracticeFoundProps {
  // Whether the page is on screen. Its cards, each with a board, are drawn from the first time it is.
  shown: boolean;
  // The whole list, which the hub reads for the navigation and the Overview and which the page shows
  // while no filter is chosen; a filter is read from `fetchFound`.
  whole: Loaded<FoundPositionsResponse>;
  fetchFound: FetchFoundPositions;
  // The found start in flight, which says Starting on the button that made it.
  starting: FoundStarting | null;
  // Any start of the hub is in flight, a found one or not, and every start waits for it.
  busy: boolean;
  onStart(request: FoundStartRequest): void;
  // The alert of a refused start, when the start was pressed on this page.
  failure: ReactNode;
  now: Date;
  createBoard?: BoardFactory | undefined;
}

type ColorChoice = "all" | "white" | "black";
type PhaseChoice = "all" | FoundPositionPhase;
interface Filters {
  color: ColorChoice;
  phase: PhaseChoice;
}

const NO_FILTERS: Filters = { color: "all", phase: "all" };

const COLOR_CHOICES: readonly { value: ColorChoice; label: string }[] = [
  { value: "all", label: "All" },
  { value: "white", label: "As White" },
  { value: "black", label: "As Black" },
];

const isNarrowed = ({ color, phase }: Filters): boolean => color !== "all" || phase !== "all";

const queryOf = ({ color, phase }: Filters): FoundPositionsQuery => ({
  ...(color === "all" ? {} : { color }),
  ...(phase === "all" ? {} : { phase }),
});

// The start a header button sends carries the filters the list is narrowed by.
const startOf = (scope: RepertoireScope, filters: Filters): FoundStartRequest => ({
  scope,
  ...queryOf(filters),
});

function useEverShown(shown: boolean): boolean {
  const [seen, setSeen] = useState(shown);
  if (shown && !seen) setSeen(true);
  return seen || shown;
}

// The answer for the chosen filters: the hub's whole list while none is chosen, else one read per
// choice, which stays loading until its own answer arrives so a list is never shown under another
// choice's controls. A read that lands after the choice was changed again is dropped.
function useFilteredFound(
  whole: Loaded<FoundPositionsResponse>,
  fetchFound: FetchFoundPositions,
  filters: Filters,
): Loaded<FoundPositionsResponse> {
  const { color, phase } = filters;
  const narrowed = isNarrowed(filters);
  const key = `${color}/${phase}`;
  const [read, setRead] = useState<{ key: string; loaded: Loaded<FoundPositionsResponse> } | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback((): void => setAttempt((count) => count + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger
  useEffect(() => {
    if (!narrowed) return;
    let live = true;
    setRead({ key, loaded: { status: "loading" } });
    fetchFound(queryOf({ color, phase })).then(
      (value) => live && setRead({ key, loaded: { status: "ready", value } }),
      () => live && setRead({ key, loaded: { status: "failed", retry } }),
    );
    return () => {
      live = false;
    };
  }, [narrowed, key, color, phase, attempt, fetchFound, retry]);

  if (!narrowed) return whole;
  return read?.key === key ? read.loaded : { status: "loading" };
}

// The controls count from the last answer read, since an answer in flight has no counts yet and
// the controls would otherwise lose theirs for as long as it takes.
function useLastCounts(loaded: Loaded<FoundPositionsResponse>): FoundPositionCounts | null {
  const last = useRef<FoundPositionCounts | null>(null);
  if (loaded.status === "ready") last.current = loaded.value.counts;
  return last.current;
}

const withCount = (label: string, count: number | null): string =>
  count === null ? label : `${label} · ${count}`;

// The phase counts follow the colour alone, so each phase says what choosing it would hold.
function phaseChoicesOf(
  counts: FoundPositionCounts,
): readonly { value: PhaseChoice; label: string }[] {
  const { by_phase: byPhase } = counts;
  const all = byPhase.opening + byPhase.middlegame + byPhase.endgame;
  return [
    { value: "all", label: withCount("All phases", all) },
    ...(["opening", "middlegame", "endgame"] as const).map((phase) => ({
      value: phase,
      label: withCount(FOUND_PHASE_LABEL[phase], byPhase[phase]),
    })),
  ];
}

type SectionProps = Omit<FoundSectionProps, "title" | "empty" | "positions">;

function FoundBody({
  loaded,
  narrowed,
  onClear,
  ...cards
}: SectionProps & {
  loaded: Loaded<FoundPositionsResponse>;
  narrowed: boolean;
  onClear(): void;
}) {
  if (loaded.status === "loading") {
    return (
      <p className="found-state" role="status">
        {FOUND_LOADING_TEXT}
      </p>
    );
  }
  if (loaded.status === "failed") {
    return (
      <div className="found-state">
        <p className="practice__failure" role="alert">
          {FOUND_FAILED_TEXT}
        </p>
        <button type="button" className="button" onClick={loaded.retry}>
          Try again
        </button>
      </div>
    );
  }
  const { positions, counts } = loaded.value;
  if (positions.length === 0 && narrowed) {
    return (
      <div className="found-state">
        <p>No position from your games matches these filters.</p>
        <button type="button" className="button" onClick={onClear}>
          Clear filters
        </button>
      </div>
    );
  }
  if (positions.length === 0) return <p className="found-state">{FOUND_EMPTY_TEXT}</p>;
  return (
    <>
      <p className="found-counts">
        {`${positionsText(counts.total)} · ${counts.due} due · ${counts.new} new`}
      </p>
      <div className="found-sections">
        {FOUND_SECTIONS.map(({ section, title, empty }) => (
          <FoundSection
            key={section}
            title={title}
            empty={empty}
            positions={positions.filter((position) => position.section === section)}
            {...cards}
          />
        ))}
      </div>
    </>
  );
}

/** The From my games page: the positions the server found in the student's games, and their drills. */
export function PracticeFound({
  shown,
  whole,
  fetchFound,
  starting,
  busy,
  onStart,
  failure,
  now,
  createBoard,
}: PracticeFoundProps) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const drawn = useEverShown(shown);
  const loaded = useFilteredFound(whole, fetchFound, filters);
  const counts = useLastCounts(loaded);
  // A card's Drill keeps its identity from one render to the next, so a card that did not change
  // is not drawn again; it reads the latest start through the ref.
  const latestStart = useRef(onStart);
  latestStart.current = onStart;
  const drill = useCallback(
    (position: FoundPositionView): void =>
      latestStart.current({ scope: "all", position: position.id }),
    [],
  );
  if (!drawn) return null;

  const narrowed = isNarrowed(filters);
  // With no position at all there is nothing to narrow or to train.
  const empty = !narrowed && loaded.status === "ready" && loaded.value.positions.length === 0;
  return (
    <>
      <div className="found-head">
        <div className="found-head__heading">
          <h2 className="screen__title">From my games</h2>
          <p className="screen__note">{FOUND_PAGE_NOTE}</p>
        </div>
        {empty || counts === null ? null : (
          <div className="found-head__controls">
            <FilterGroup
              label="Phase"
              choices={phaseChoicesOf(counts)}
              current={filters.phase}
              onChoose={(phase) => setFilters({ ...filters, phase })}
            />
            <FilterGroup
              label="Colour"
              choices={COLOR_CHOICES}
              current={filters.color}
              onChoose={(color) => setFilters({ ...filters, color })}
            />
            <TrainControl
              counts={counts}
              disabled={busy || loaded.status !== "ready"}
              starting={starting !== null && starting.position === undefined}
              onStart={(scope) => onStart(startOf(scope, filters))}
            />
          </div>
        )}
      </div>
      {failure}
      <FoundBody
        loaded={loaded}
        narrowed={narrowed}
        onClear={() => setFilters(NO_FILTERS)}
        now={now}
        busy={busy}
        startingPosition={starting?.position}
        onDrill={drill}
        createBoard={createBoard}
      />
    </>
  );
}
