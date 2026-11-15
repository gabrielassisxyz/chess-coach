import type { OpeningPuzzles, OpeningPuzzlesResponse } from "@chess-coach/shared";
import { useCallback, useId } from "react";
import { type Loaded, useLoaded } from "../hooks/useLoaded.js";
import {
  type FetchOpeningPuzzles,
  openingTileFigureOf,
  openingTilesOf,
  puzzleCountText,
} from "../state/opening-puzzles-api.js";
import { NEEDS_ENGINE_TEXT } from "../state/practice.js";

export interface PracticeOpeningPuzzlesProps {
  // The openings of the colour, which the block asks the server about once; asking again follows a
  // change of the names, never a new render of the same ones.
  names: readonly string[];
  fetchPuzzles: FetchOpeningPuzzles;
  // A start is in flight or an opening is being added: the page cannot leave for a puzzle session.
  busy: boolean;
  // The engine grades the answers, so no tile starts a session without it.
  engineMissing: boolean;
  // The tag of the puzzle start in flight, whose tile says so.
  startingTag: string | null;
  onStart(tag: string): void;
}

// No opening name holds a line break, so one separates the names in the key that stands for them.
const NAME_JOINER = "\n";

const NOTE_TEXT = "Tactics that come out of the openings you and your opponents actually play";

type TileControls = Pick<PracticeOpeningPuzzlesProps, "onStart"> & {
  disabled: boolean;
  startingTag: string | null;
};

function TileStat({ entry, starting }: { entry: OpeningPuzzles; starting: boolean }) {
  if (starting) return <span className="theme-tile__stat">Starting</span>;
  const figure = openingTileFigureOf(entry);
  if (figure.kind === "new") {
    return (
      <span className="theme-tile__stat" data-tone="new">
        new
      </span>
    );
  }
  return (
    <span className="theme-tile__stat" data-tone={figure.tone}>
      {`${figure.percent}%`}
    </span>
  );
}

function OpeningTile({
  entry,
  disabled,
  startingTag,
  onStart,
}: TileControls & { entry: OpeningPuzzles }) {
  return (
    <button
      type="button"
      className="theme-tile"
      disabled={disabled}
      onClick={() => onStart(entry.tag)}
    >
      <span className="theme-tile__name">{entry.name}</span>{" "}
      <TileStat entry={entry} starting={startingTag === entry.tag} />{" "}
      <span className="theme-tile__desc">{puzzleCountText(entry.puzzles)}</span>
    </button>
  );
}

function BlockBody({
  loaded,
  ...controls
}: TileControls & { loaded: Loaded<OpeningPuzzlesResponse> }) {
  if (loaded.status === "loading") {
    return (
      <p className="practice__card-note" role="status">
        Loading the puzzles of your openings.
      </p>
    );
  }
  if (loaded.status === "failed") {
    return (
      <>
        <p className="practice__failure" role="alert">
          The puzzles of your openings could not be loaded.
        </p>
        <div className="controls__row">
          <button type="button" className="button" onClick={loaded.retry}>
            Try again
          </button>
        </div>
      </>
    );
  }
  const tiles = openingTilesOf(loaded.value);
  if (tiles.length === 0) {
    return <p className="practice__card-note">No Lichess puzzle comes from these openings.</p>;
  }
  return (
    <div className="theme-tiles__grid">
      {tiles.map((entry) => (
        <OpeningTile key={entry.name} entry={entry} {...controls} />
      ))}
    </div>
  );
}

// Lichess's puzzles sorted by the opening they came from, for the openings of one colour: a tile for
// each with the share the student solves first try and how many puzzles it holds, which starts a
// session of that opening. A failed read stays inside the block, and an opening with no puzzle is
// not drawn.
export function PracticeOpeningPuzzles({
  names,
  fetchPuzzles,
  busy,
  engineMissing,
  startingTag,
  onStart,
}: PracticeOpeningPuzzlesProps) {
  const titleId = useId();
  const key = names.join(NAME_JOINER);
  const load = useCallback(() => fetchPuzzles(key.split(NAME_JOINER)), [fetchPuzzles, key]);
  const loaded = useLoaded(load);
  return (
    <section className="opening-puzzles" aria-labelledby={titleId}>
      <div className="opening-puzzles__head">
        <h4 className="opening-puzzles__title" id={titleId}>
          Puzzles from these openings
        </h4>
        <p className="opening-puzzles__note">{NOTE_TEXT}</p>
      </div>
      {engineMissing ? <p className="practice__card-note">{NEEDS_ENGINE_TEXT}</p> : null}
      <BlockBody
        loaded={loaded}
        disabled={busy || engineMissing}
        startingTag={startingTag}
        onStart={onStart}
      />
    </section>
  );
}
