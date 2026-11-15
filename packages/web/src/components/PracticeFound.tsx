import type {
  FoundPositionCounts,
  FoundPositionPhase,
  FoundPositionsQuery,
  FoundPositionsResponse,
  FoundPositionView,
  RepertoireScope,
} from "@chess-coach/shared";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import type { Loaded } from "../hooks/useLoaded.js";
import {
  type FetchFoundPositions,
  FOUND_COLOR_LABEL,
  FOUND_EMPTY_TEXT,
  FOUND_FAILED_TEXT,
  FOUND_LOADING_TEXT,
  FOUND_PAGE_NOTE,
  FOUND_PHASE_LABEL,
  FOUND_SECTIONS,
  type FoundStartRequest,
  foundBestText,
  foundBestToneOf,
  foundDueCount,
  foundLastText,
  foundLineText,
  foundMistakeFootOf,
  foundReachedText,
  foundStateText,
  foundTitleOf,
  positionsText,
} from "../state/found-api.js";
import type { BoardFactory } from "./Board.js";
import { MiniBoard } from "./MiniBoard.js";

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
  starting: FoundStarting | null;
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

// The start a button sends carries the filters the list is narrowed by.
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
// choice's controls.
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

function phaseChoicesOf(
  counts: FoundPositionCounts | null,
): readonly { value: PhaseChoice; label: string }[] {
  const byPhase = counts?.by_phase ?? null;
  const all = byPhase === null ? null : byPhase.opening + byPhase.middlegame + byPhase.endgame;
  return [
    { value: "all", label: withCount("All phases", all) },
    ...(["opening", "middlegame", "endgame"] as const).map((phase) => ({
      value: phase,
      label: withCount(FOUND_PHASE_LABEL[phase], byPhase === null ? null : byPhase[phase]),
    })),
  ];
}

function FilterGroup<Choice extends string>({
  label,
  choices,
  current,
  onChoose,
}: {
  label: string;
  choices: readonly { value: Choice; label: string }[];
  current: Choice;
  onChoose(value: Choice): void;
}) {
  return (
    <fieldset className="found-filter" aria-label={label}>
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          className="found-filter__button"
          aria-pressed={choice.value === current}
          onClick={() => onChoose(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </fieldset>
  );
}

function ChevronDown() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

// "Train N" drills what the server recommends, a few due and new positions; the chevron opens the
// two wider drills. Every start carries the filters the list is narrowed by.
function TrainControl({
  counts,
  filters,
  starting,
  onStart,
}: {
  counts: FoundPositionCounts;
  filters: Filters;
  starting: FoundStarting | null;
  onStart(request: FoundStartRequest): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const busy = starting !== null;
  const recommended = counts.recommended > 0;
  const mainScope: RepertoireScope = recommended ? "recommended" : "all";
  // The menu closes on a start, so the pill says Starting for any start of the header's.
  const headerStarting = starting !== null && starting.position === undefined;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    const onPointer = (event: MouseEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const startFrom = (scope: RepertoireScope): void => {
    setOpen(false);
    onStart(startOf(scope, filters));
  };
  const menu: readonly { scope: RepertoireScope; label: string; count: number }[] = [
    { scope: "due", label: "Everything due", count: counts.due },
    { scope: "all", label: "All positions", count: counts.all },
  ];

  return (
    <div className="found-train" ref={root}>
      <button
        type="button"
        className="found-train__main"
        disabled={busy || counts.all === 0}
        onClick={() => startFrom(mainScope)}
      >
        {headerStarting
          ? "Starting"
          : recommended
            ? `Train ${counts.recommended}`
            : "Train all positions"}
      </button>
      <button
        type="button"
        className="found-train__more"
        ref={toggle}
        aria-label="More ways to train"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={busy}
        onClick={() => setOpen((now) => !now)}
      >
        <ChevronDown />
      </button>
      {open ? (
        <div className="found-train__menu" id={menuId}>
          {menu.map((item) => (
            <button
              key={item.scope}
              type="button"
              className="found-train__item"
              disabled={busy || item.count === 0}
              onClick={() => startFrom(item.scope)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FoundCard({
  position,
  now,
  starting,
  onDrill,
  createBoard,
}: {
  position: FoundPositionView;
  now: Date;
  starting: FoundStarting | null;
  onDrill(position: FoundPositionView): void;
  createBoard: BoardFactory | undefined;
}) {
  const titleId = useId();
  const title = foundTitleOf(position);
  const line = foundLineText(position.line);
  const reached = position.section === "reached";
  return (
    <li className="found-card">
      <MiniBoard fen={position.fen} orientation={position.color} createBoard={createBoard} />
      <div className="found-card__body">
        <div className="found-card__head">
          <span className="found-card__title" id={titleId} title={title}>
            {title}
          </span>
          <span className="found-card__state" data-state={position.state}>
            {foundStateText(position, now)}
          </span>
        </div>
        {line === "" ? null : (
          <p className="found-card__line" title={line}>
            {line}
          </p>
        )}
        <div className="found-card__chips">
          <span className="found-chip">{FOUND_COLOR_LABEL[position.color]}</span>
          <span className="found-chip">{FOUND_PHASE_LABEL[position.phase]}</span>
          {position.from_departure ? (
            <span className="found-chip">Opponent left your line</span>
          ) : null}
          {position.from_mistake ? <span className="found-chip">Mistake</span> : null}
        </div>
        <div className="found-card__foot">
          {reached ? (
            <>
              <span>
                Reached <span className="found-card__figure">{foundReachedText(position)}</span>
              </span>
              <span>
                Found best{" "}
                <span className="found-card__figure" data-tone={foundBestToneOf(position)}>
                  {foundBestText(position)}
                </span>
              </span>
              <span>{foundLastText(position, now)}</span>
            </>
          ) : (
            <span>{foundMistakeFootOf(position, now)}</span>
          )}
          <button
            type="button"
            className="button found-card__drill"
            aria-describedby={titleId}
            disabled={starting !== null}
            onClick={() => onDrill(position)}
          >
            {starting?.position === position.id ? "Starting" : "Drill"}
          </button>
        </div>
      </div>
    </li>
  );
}

function FoundSection({
  title,
  empty,
  positions,
  ...card
}: {
  title: string;
  empty: string;
  positions: readonly FoundPositionView[];
  now: Date;
  starting: FoundStarting | null;
  onDrill(position: FoundPositionView): void;
  createBoard: BoardFactory | undefined;
}) {
  const titleId = useId();
  return (
    <section className="found-section" aria-labelledby={titleId}>
      <div className="found-section__head">
        <h3 className="found-section__title" id={titleId}>
          {title}
        </h3>
        <span className="found-section__count">
          {`${positionsText(positions.length)} · ${foundDueCount(positions)} due`}
        </span>
      </div>
      {positions.length === 0 ? (
        <p className="found-section__empty">{empty}</p>
      ) : (
        <ul className="found-grid">
          {positions.map((position) => (
            <FoundCard key={position.id} position={position} {...card} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FoundBody({
  loaded,
  narrowed,
  onClear,
  ...card
}: {
  loaded: Loaded<FoundPositionsResponse>;
  narrowed: boolean;
  onClear(): void;
  now: Date;
  starting: FoundStarting | null;
  onDrill(position: FoundPositionView): void;
  createBoard: BoardFactory | undefined;
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
  if (positions.length === 0) {
    return narrowed ? (
      <div className="found-state">
        <p>No position from your games matches these filters.</p>
        <button type="button" className="button" onClick={onClear}>
          Clear filters
        </button>
      </div>
    ) : (
      <p className="found-state">{FOUND_EMPTY_TEXT}</p>
    );
  }
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
            {...card}
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
  onStart,
  failure,
  now,
  createBoard,
}: PracticeFoundProps) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const drawn = useEverShown(shown);
  const loaded = useFilteredFound(whole, fetchFound, filters);
  const counts = useLastCounts(loaded);
  if (!drawn) return null;

  const narrowed = isNarrowed(filters);
  // With no position at all there is nothing to narrow or to train.
  const empty = !narrowed && loaded.status === "ready" && loaded.value.positions.length === 0;
  const controls = !empty && counts !== null;
  return (
    <>
      <div className="found-head">
        <div className="found-head__heading">
          <h2 className="screen__title">From my games</h2>
          <p className="screen__note">{FOUND_PAGE_NOTE}</p>
        </div>
        {controls ? (
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
            {loaded.status === "ready" ? (
              <TrainControl
                counts={loaded.value.counts}
                filters={filters}
                starting={starting}
                onStart={onStart}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {failure}
      <FoundBody
        loaded={loaded}
        narrowed={narrowed}
        onClear={() => setFilters(NO_FILTERS)}
        now={now}
        starting={starting}
        onDrill={(position) => onStart({ scope: "all", position: position.id })}
        createBoard={createBoard}
      />
    </>
  );
}
