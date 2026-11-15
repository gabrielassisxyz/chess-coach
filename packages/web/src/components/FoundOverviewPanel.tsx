import type { FoundPositionsResponse, FoundPositionView } from "@chess-coach/shared";
import type { Loaded } from "../hooks/useLoaded.js";
import {
  FOUND_COLOR_LABEL,
  FOUND_EMPTY_TEXT,
  FOUND_FAILED_TEXT,
  FOUND_LOADING_TEXT,
  type FoundStartRequest,
  firstDueFoundPositions,
  foundBestText,
  foundBestToneOf,
  foundLineText,
  foundTitleOf,
  positionsText,
} from "../state/found-api.js";
import { dateLabel } from "../state/games.js";
import type { FoundStarting } from "./PracticeFound.js";

export interface FoundOverviewPanelProps {
  found: Loaded<FoundPositionsResponse>;
  // The found start in flight, which says Starting on the button that made it.
  starting: FoundStarting | null;
  // Any start of the hub is in flight, a found one or not, and every start waits for it.
  busy: boolean;
  onStart(request: FoundStartRequest): void;
  // Opens the From my games page.
  onSeeAll(): void;
  now: Date;
}

const PANEL_ROWS = 3;

// A position reached more than once says how often the student found its best move; a mistake,
// which was met once, says when.
function PanelRow({ position, now }: { position: FoundPositionView; now: Date }) {
  const title = foundTitleOf(position);
  const line = foundLineText(position.line);
  const reached = position.section === "reached";
  return (
    <li className="found-panel__row">
      <span className="found-panel__title" title={title}>
        {title}
      </span>
      <span className="found-panel__side">{FOUND_COLOR_LABEL[position.color]}</span>
      <span className="found-panel__line" title={line}>
        {line}
      </span>
      {reached ? (
        <span className="found-panel__result" data-tone={foundBestToneOf(position)}>
          <span className="sr-only">Found best </span>
          {foundBestText(position)}
        </span>
      ) : (
        <span className="found-panel__result">
          {dateLabel(position.game.played_at ?? position.last_reached_at, now)}
        </span>
      )}
    </li>
  );
}

function PanelBody({ found, starting, busy, onStart, onSeeAll, now }: FoundOverviewPanelProps) {
  if (found.status === "loading") {
    return (
      <p className="practice__card-note" role="status">
        {FOUND_LOADING_TEXT}
      </p>
    );
  }
  if (found.status === "failed") {
    return (
      <>
        <p className="practice__failure" role="alert">
          {FOUND_FAILED_TEXT}
        </p>
        <button type="button" className="button" onClick={found.retry}>
          Try again
        </button>
      </>
    );
  }
  const { positions, counts } = found.value;
  if (positions.length === 0) return <p className="practice__card-note">{FOUND_EMPTY_TEXT}</p>;

  const scope = counts.due > 0 ? "due" : "all";
  const own = starting !== null && starting.position === undefined && starting.scope === scope;
  const rows = firstDueFoundPositions(positions, PANEL_ROWS);
  return (
    <>
      <p className="found-panel__counts">
        {`${counts.due} due · ${counts.by_section.reached} recurring of ${counts.total}`}
      </p>
      {rows.length === 0 ? null : (
        <ul className="found-panel__rows" aria-label="Next positions due">
          {rows.map((position) => (
            <PanelRow key={position.id} position={position} now={now} />
          ))}
        </ul>
      )}
      <div className="found-panel__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={busy}
          onClick={() => onStart({ scope })}
        >
          {own
            ? "Starting"
            : counts.due > 0
              ? `Drill ${positionsText(counts.due)}`
              : "Train all positions"}
        </button>
        <button type="button" className="button button--quiet" onClick={onSeeAll}>
          See all
        </button>
      </div>
    </>
  );
}

// The Overview's glance at the From my games page: what is due, the next few positions, and the
// two ways on, drilling them or opening the page.
export function FoundOverviewPanel(props: FoundOverviewPanelProps) {
  return (
    <section className="practice__card found-panel" aria-label="Positions from your games">
      <h3 className="practice__card-title">Positions from your games</h3>
      <p className="practice__card-note">
        Positions you keep reaching: find the best move before the next game does.
      </p>
      <PanelBody {...props} />
    </section>
  );
}
