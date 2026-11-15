import type {
  FoundPositionView,
  PlayedColour,
  PlayedOpening,
  PlayedOpeningsResponse,
  PlayedVariation,
  PlayedWindow,
} from "@chess-coach/shared";
import { type ReactNode, useId, useState } from "react";
import type { Loaded } from "../hooks/useLoaded.js";
import type { FoundStartRequest } from "../state/found-api.js";
import {
  type FetchOpeningsPlayed,
  fetchOpeningsPlayedFromServer,
  foundOpeningNamesOf,
  PLAYED_FAILED_TEXT,
  PLAYED_LOADING_TEXT,
  PLAYED_PAGE_NOTE,
  PLAYED_SECTION_EMPTY_TEXT,
  PLAYED_SECTIONS,
  PLAYED_SIDE_CHOICES,
  type PlayedSection,
  type PlayedSide,
  playedBarLabelOf,
  playedCountsText,
  playedDrillRequestOf,
  playedNoGamesText,
  playedRowsOf,
  playedScoreOf,
  playedScoreToneOf,
  playedSharesOf,
  playedTotalText,
} from "../state/openings-played-api.js";
import { FilterGroup } from "./FoundControls.js";
import { ThemeTimeWindow, useActivatedWindow, useWindowedResource } from "./PracticeThemeStats.js";

type Figures = Pick<PlayedOpening, "games" | "wins" | "draws" | "losses">;

/** The bar of a row: the share of the games won in green, drawn in grey and lost in red. */
export function PlayedBar({ figures }: { figures: Figures }) {
  return (
    <span className="played-bar" role="img" aria-label={playedBarLabelOf(figures)}>
      {playedSharesOf(figures).map(({ outcome, share }) =>
        share > 0 ? (
          <span
            key={outcome}
            className="played-bar__part"
            data-outcome={outcome}
            style={{ width: `${share}%` }}
          />
        ) : null,
      )}
    </span>
  );
}

/** What the student scored in a row, in the colour of its band. */
export function PlayedScore({ figures }: { figures: Figures }) {
  const score = playedScoreOf(figures);
  return (
    <span className="played-score" data-tone={playedScoreToneOf(score)}>
      <span className="sr-only">Score </span>
      {`${score}%`}
    </span>
  );
}

// What a variation needs to offer its drill: the full names the stored positions of the side carry,
// the start in flight and where a start goes. With no start to send, no variation offers one.
interface DrillSupport {
  names: ReadonlySet<string>;
  busy: boolean;
  startingOpening: string | null;
  onDrill: ((request: FoundStartRequest) => void) | undefined;
}

// A row the student opened or closed keeps that choice across a change of side or period; a row
// they never touched is open only when it is the first of the openings they chose.
interface OpenRows {
  isOpen(key: string, startsOpen: boolean): boolean;
  toggle(key: string, startsOpen: boolean): void;
}

function useOpenRows(): OpenRows {
  const [chosen, setChosen] = useState<Readonly<Record<string, boolean>>>({});
  return {
    isOpen: (key, startsOpen) => chosen[key] ?? startsOpen,
    toggle: (key, startsOpen) => setChosen((now) => ({ ...now, [key]: !(now[key] ?? startsOpen) })),
  };
}

function Chevron() {
  return (
    <svg
      className="played-row__chevron"
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
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

function PlayedName({
  title,
  line,
  titleId,
}: {
  title: string;
  line: string;
  titleId?: string | undefined;
}) {
  return (
    <span className="played-row__name">
      <span className="played-row__title" id={titleId}>
        {title}
      </span>
      {line === "" ? null : (
        <span className="played-row__line" title={line}>
          {line}
        </span>
      )}
    </span>
  );
}

function PlayedGames({ games }: { games: number }) {
  return (
    <span className="played-row__games">
      <span className="sr-only">Games </span>
      {games}
    </span>
  );
}

function VariationRow({
  variation,
  side,
  drill,
}: {
  variation: PlayedVariation;
  side: PlayedSide;
  drill: DrillSupport;
}) {
  const titleId = useId();
  const { onDrill } = drill;
  const offered = onDrill !== undefined && drill.names.has(variation.full_name);
  return (
    <li className="played-row played-row--variation">
      <PlayedName title={variation.name} line={variation.line} titleId={titleId} />
      <PlayedGames games={variation.games} />
      <PlayedBar figures={variation} />
      <PlayedScore figures={variation} />
      {offered ? (
        <button
          type="button"
          className="button played-row__drill"
          aria-describedby={titleId}
          disabled={drill.busy}
          onClick={() => onDrill(playedDrillRequestOf(side, variation))}
        >
          {drill.startingOpening === variation.full_name ? "Starting" : "Drill"}
        </button>
      ) : null}
    </li>
  );
}

interface OpeningItemProps {
  opening: PlayedOpening;
  side: PlayedSide;
  open: boolean;
  onToggle(): void;
  drill: DrillSupport;
}

function OpeningItem({ opening, side, open, onToggle, drill }: OpeningItemProps) {
  const variations = playedRowsOf(opening.variations);
  return (
    <li className="played-opening">
      <button
        type="button"
        className="played-row played-row--opening"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Chevron />
        <PlayedName title={opening.opening} line={opening.line} />
        <PlayedGames games={opening.games} />
        <PlayedBar figures={opening} />
        <PlayedScore figures={opening} />
        <span className="played-row__counts">{playedCountsText(opening)}</span>
      </button>
      {open && variations.length > 0 ? (
        <ul className="played-variations" aria-label={`${opening.opening} variations`}>
          {variations.map((variation) => (
            <VariationRow
              key={variation.full_name}
              variation={variation}
              side={side}
              drill={drill}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

interface PlayedTableProps {
  section: PlayedSection;
  title: string;
  side: PlayedSide;
  openings: readonly PlayedOpening[];
  rows: OpenRows;
  drill: DrillSupport;
}

function PlayedTable({ section, title, side, openings, rows, drill }: PlayedTableProps) {
  return (
    <>
      <div className="played-head" aria-hidden="true">
        <span>Opening</span>
        <span className="played-head__games">Games</span>
        <span className="played-head__bar">Win / draw / loss</span>
        <span className="played-head__score">Score</span>
        <span className="played-head__counts" />
      </div>
      <ul className="played-list" aria-label={title}>
        {openings.map((opening, index) => {
          const key = `${side}/${section}/${opening.opening}`;
          const startsOpen = section === "mine" && index === 0;
          return (
            <OpeningItem
              key={key}
              opening={opening}
              side={side}
              open={rows.isOpen(key, startsOpen)}
              onToggle={() => rows.toggle(key, startsOpen)}
              drill={drill}
            />
          );
        })}
      </ul>
    </>
  );
}

function PlayedSectionView({
  section,
  title,
  note,
  ...table
}: PlayedTableProps & { note: string }) {
  const headingId = useId();
  const drawn = playedRowsOf(table.openings);
  return (
    <section className="played-section" aria-labelledby={headingId}>
      <div className="played-section__head">
        <h3 id={headingId} className="played-section__title">
          {title}
        </h3>
        <p className="played-section__note">{note}</p>
      </div>
      <div className="played-panel">
        {drawn.length === 0 ? (
          <p className="played-state">{PLAYED_SECTION_EMPTY_TEXT}</p>
        ) : (
          <PlayedTable section={section} title={title} {...table} openings={drawn} />
        )}
      </div>
    </section>
  );
}

function PlayedLegend() {
  return (
    <span className="played-legend">
      {(["won", "drawn", "lost"] as const).map((outcome) => (
        <span key={outcome} className="played-legend__item">
          <span className="played-legend__swatch" data-outcome={outcome} aria-hidden="true" />
          {outcome}
        </span>
      ))}
    </span>
  );
}

function PlayedColourView({
  colour,
  side,
  rows,
  drill,
}: {
  colour: PlayedColour;
  side: PlayedSide;
  rows: OpenRows;
  drill: DrillSupport;
}) {
  if (colour.games === 0) {
    return (
      <div className="played-panel">
        <p className="played-state">{playedNoGamesText(side)}</p>
      </div>
    );
  }
  return (
    <>
      <p className="played-total">
        <span>{playedTotalText(colour.games, side)}</span>
        <PlayedLegend />
      </p>
      {PLAYED_SECTIONS.map(({ section, title, note }) => (
        <PlayedSectionView
          key={section}
          section={section}
          title={title}
          note={note}
          side={side}
          openings={colour[section]}
          rows={rows}
          drill={drill}
        />
      ))}
    </>
  );
}

function PlayedBody({
  loaded,
  side,
  rows,
  drill,
}: {
  loaded: Loaded<PlayedOpeningsResponse>;
  side: PlayedSide;
  rows: OpenRows;
  drill: DrillSupport;
}) {
  if (loaded.status === "loading") {
    return (
      <div className="played-panel">
        <p className="played-state" role="status">
          {PLAYED_LOADING_TEXT}
        </p>
      </div>
    );
  }
  if (loaded.status === "failed") {
    return (
      <div className="played-panel">
        <div className="played-state">
          <p className="practice__failure" role="alert">
            {PLAYED_FAILED_TEXT}
          </p>
          <button type="button" className="button" onClick={loaded.retry}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  return <PlayedColourView colour={loaded.value[side]} side={side} rows={rows} drill={drill} />;
}

function PlayedHead({
  side,
  onSide,
  days,
  onDays,
}: {
  side: PlayedSide;
  onSide(side: PlayedSide): void;
  days: PlayedWindow;
  onDays(days: PlayedWindow): void;
}) {
  return (
    <div className="practice-themes__top">
      <div className="practice-themes__heading">
        <h2 className="screen__title">Openings played</h2>
        <p className="screen__note">{PLAYED_PAGE_NOTE}</p>
      </div>
      <div className="played-controls">
        <FilterGroup label="Side" choices={PLAYED_SIDE_CHOICES} current={side} onChoose={onSide} />
        <ThemeTimeWindow days={days} onSelect={onDays} />
      </div>
    </div>
  );
}

export interface PracticeOpeningsPlayedProps {
  // Whether the page is on screen. It reads nothing before the first time it is.
  shown: boolean;
  // Where the counts come from; the server's by default.
  fetchPlayed?: FetchOpeningsPlayed | undefined;
  // The positions from the student's games the hub has read. A variation offers Drill when one of
  // its colour carries its full name; until the list is read, none does.
  positions: readonly FoundPositionView[];
  // The opening whose drill is starting, which says Starting on its button.
  startingOpening: string | null;
  // Any start of the hub is in flight, a drill or not, and every start waits for it.
  busy: boolean;
  onDrill?: ((request: FoundStartRequest) => void) | undefined;
  // The alert of a refused start, when the start was pressed on this page.
  failure: ReactNode;
}

/** The Openings played page: the student's games counted by opening for each colour, each opening with its variations and a drill. */
export function PracticeOpeningsPlayed({
  shown,
  fetchPlayed = fetchOpeningsPlayedFromServer,
  positions,
  startingOpening,
  busy,
  onDrill,
  failure,
}: PracticeOpeningsPlayedProps) {
  const { activated, days, selectWindow } = useActivatedWindow(shown);
  const loaded = useWindowedResource(activated, days, fetchPlayed);
  const [side, setSide] = useState<PlayedSide>("white");
  const rows = useOpenRows();
  const drill: DrillSupport = {
    names: foundOpeningNamesOf(positions, side),
    busy,
    startingOpening,
    onDrill,
  };
  return (
    <div className="played">
      <PlayedHead side={side} onSide={setSide} days={days} onDays={selectWindow} />
      {failure}
      {activated ? <PlayedBody loaded={loaded} side={side} rows={rows} drill={drill} /> : null}
    </div>
  );
}
