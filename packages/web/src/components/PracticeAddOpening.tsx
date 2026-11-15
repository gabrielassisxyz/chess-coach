import { type AddableOpening, type MetOpening, repertoireRootText } from "@chess-coach/shared";
import { type KeyboardEvent, type ReactNode, useCallback, useId, useRef, useState } from "react";
import { type Loaded, useLoaded } from "../hooks/useLoaded.js";
import {
  type AddOpening,
  addableGamesText,
  addableGroupsOf,
  addableLabelOf,
  addableMatches,
  addableMovesText,
  type FetchAddableOpenings,
  metGamesText,
  metLabelOf,
  metNameOf,
  metRootKey,
  metToAddMostMetFirst,
  type StylePoints,
} from "../state/repertoires-api.js";
import { type OpeningAdds, StylePointsControl } from "./RepertoireMenu.js";

// The panel that Add an opening… opens: every opening Black can answer the student's 1.e4 path
// with, and the ones the student's games met that have no line yet. Either way an Add builds the
// whole line from 1.e4, which takes minutes, and the page's add state is what remembers the run.

type AddTab = "all" | "mine";

const ADD_TABS: readonly AddTab[] = ["all", "mine"];

// The keys that move between tabs: the arrows wrap round, Home and End go to the ends.
const TAB_STEP: Readonly<Record<string, (index: number) => number>> = {
  ArrowLeft: (index) => (index + ADD_TABS.length - 1) % ADD_TABS.length,
  ArrowRight: (index) => (index + 1) % ADD_TABS.length,
  Home: () => 0,
  End: () => ADD_TABS.length - 1,
};

const NO_MATCH_TEXT = "No opening matches.";
const NOTHING_TO_ADD_TEXT = "No opening is available to add.";
const EVERY_OPENING_BUILT_TEXT = "Every opening from your games has a line.";

// What a row needs to ask for an add: the page's add state, whether it lets an add run at all (a
// start is in flight, or the style points are not all placed) and the call that asks.
interface RowControls {
  adds: OpeningAdds;
  busy: boolean;
  onAdd(root: readonly string[], name: string): void;
}

function SearchIcon() {
  return (
    <svg
      className="openings-panel__search-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </svg>
  );
}

function AddTabs({
  tab,
  onTab,
  mineCount,
  idBase,
}: {
  tab: AddTab;
  onTab(tab: AddTab): void;
  mineCount: number;
  idBase: string;
}) {
  const buttons = useRef<Partial<Record<AddTab, HTMLButtonElement | null>>>({});
  const labels: Record<AddTab, string> = {
    all: "All openings",
    mine: `From my games (${mineCount})`,
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const step = TAB_STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = ADD_TABS[step(ADD_TABS.indexOf(tab))] ?? tab;
    onTab(next);
    buttons.current[next]?.focus();
  };
  return (
    <div className="openings-panel__tabs" role="tablist" aria-label="Openings to add">
      {ADD_TABS.map((value) => (
        <button
          key={value}
          ref={(node) => {
            buttons.current[value] = node;
          }}
          type="button"
          role="tab"
          id={`${idBase}-${value}-tab`}
          aria-selected={value === tab}
          aria-controls={`${idBase}-${value}-panel`}
          tabIndex={value === tab ? 0 : -1}
          className="openings-panel__tab"
          onClick={() => onTab(value)}
          onKeyDown={onKeyDown}
        >
          {labels[value]}
        </button>
      ))}
    </div>
  );
}

// One row of either list: the name with its moves, what the student has to do with the opening
// (a pill, a count of games, or nothing) and the Add that builds it.
function OpeningRow({
  name,
  moves,
  aside,
  children,
}: {
  name: string;
  moves: string | null;
  aside: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="openings-panel__row">
      <div className="openings-panel__name">
        <span className="openings-panel__opening">{name}</span>
        {moves === null ? null : <span className="openings-panel__moves">{moves}</span>}
      </div>
      {aside}
      {children}
    </li>
  );
}

function AddButton({
  label,
  root,
  name,
  controls,
}: {
  label: string;
  root: readonly string[];
  name: string;
  controls: RowControls;
}) {
  const { adds, busy, onAdd } = controls;
  const adding = adds.adding?.key === metRootKey(root);
  const disabled = busy || adds.adding !== null || adds.refreshing !== null;
  return (
    <button
      type="button"
      className="button openings-panel__add"
      aria-label={`${adding ? "Building" : "Add"} ${label}`}
      disabled={disabled}
      onClick={() => onAdd(root, name)}
    >
      {adding ? "Building" : "Add"}
    </button>
  );
}

// A line whose run stopped short keeps its Add: the unit it left is partial, and adding the root
// again carries it on, so only a whole line says it is already there.
function AllRow({ entry, controls }: { entry: AddableOpening; controls: RowControls }) {
  const built =
    entry.repertoire_id !== null && !controls.adds.unfinished.has(metRootKey(entry.root));
  return (
    <OpeningRow
      name={entry.opening_name}
      moves={addableMovesText(entry)}
      aside={
        entry.games > 0 ? (
          <span className="openings-panel__pill">{addableGamesText(entry.games)}</span>
        ) : null
      }
    >
      {built ? (
        <span className="openings-panel__built">In your openings</span>
      ) : (
        <AddButton
          label={addableLabelOf(entry)}
          root={entry.root}
          name={entry.opening_name}
          controls={controls}
        />
      )}
    </OpeningRow>
  );
}

function MineRow({ entry, controls }: { entry: MetOpening; controls: RowControls }) {
  const name = metNameOf(entry);
  return (
    <OpeningRow
      name={name}
      // The book has no name for it, so the line stands for the name and is not written twice.
      moves={entry.opening_name === null ? null : repertoireRootText(entry.root)}
      aside={<span className="openings-panel__games">{metGamesText(entry.games)}</span>}
    >
      <AddButton label={metLabelOf(entry)} root={entry.root} name={name} controls={controls} />
    </OpeningRow>
  );
}

// Reads the list when the panel opens, and again when an add ends, so a row that was just built
// says so. The list read before stays on screen until the new one arrives.
function useAddableRead(
  fetchAddable: FetchAddableOpenings,
  addsEnded: unknown,
): Loaded<AddableOpening[]> {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the end of an add is what asks for a new read
  const read = useCallback(() => fetchAddable(), [fetchAddable, addsEnded]);
  return useLoaded(read);
}

function AddableSearch({ query, onQuery }: { query: string; onQuery(query: string): void }) {
  return (
    <div className="openings-panel__search">
      <SearchIcon />
      <input
        type="search"
        className="input openings-panel__search-input"
        aria-label="Search openings"
        placeholder="Search by name or by moves"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
    </div>
  );
}

// The footer says how the list is ordered, which is by the share at the student's level only
// where the explorer could be asked.
function addableFootText(entries: readonly AddableOpening[]): string {
  const order = entries.some((entry) => entry.share_0_1199 !== null)
    ? "the most played at your level first"
    : "the ones from your games first";
  return `Black's ways out of your path 1.e4 e5 2.Nf3 Nc6 3.Bc4, ${order}. Add builds the whole line from 1.e4.`;
}

function AddableList({
  entries,
  query,
  controls,
}: {
  entries: readonly AddableOpening[];
  query: string;
  controls: RowControls;
}) {
  const groups = addableGroupsOf(entries.filter((entry) => addableMatches(entry, query)));
  if (entries.length === 0) return <p className="openings-panel__empty">{NOTHING_TO_ADD_TEXT}</p>;
  return (
    <>
      {groups.length === 0 ? <p className="openings-panel__empty">{NO_MATCH_TEXT}</p> : null}
      {groups.map((group) => (
        <div key={group.path} className="openings-panel__group">
          <h5 className="openings-panel__group-title">Against {group.path}</h5>
          <ul className="openings-panel__rows" aria-label={`Against ${group.path}`}>
            {group.entries.map((entry) => (
              <AllRow key={entry.root.join(" ")} entry={entry} controls={controls} />
            ))}
          </ul>
        </div>
      ))}
      <p className="openings-panel__foot">{addableFootText(entries)}</p>
    </>
  );
}

// The first tab. The search is made here on the list already read, and asks the server nothing.
function AllOpeningsTab({
  read,
  controls,
}: {
  read: Loaded<AddableOpening[]>;
  controls: RowControls;
}) {
  const [query, setQuery] = useState("");
  if (read.status === "loading") {
    return (
      <p className="practice__card-note" role="status">
        Loading the list of openings.
      </p>
    );
  }
  if (read.status === "failed") {
    return (
      <>
        <p className="practice__failure" role="alert">
          The list of openings could not be loaded.
        </p>
        <div className="controls__row">
          <button type="button" className="button" onClick={read.retry}>
            Try again
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      {read.value.length === 0 ? null : <AddableSearch query={query} onQuery={setQuery} />}
      <AddableList entries={read.value} query={query} controls={controls} />
    </>
  );
}

// The second tab: what the page already holds of the student's games, with no read of its own.
function FromGamesTab({
  entries,
  controls,
}: {
  entries: readonly MetOpening[];
  controls: RowControls;
}) {
  return (
    <>
      <p className="openings-panel__note">
        Openings your opponents played against you that have no line yet, the most frequent first.
        The position where the opponent left your line stays in From my games.
      </p>
      {entries.length === 0 ? (
        <p className="openings-panel__empty">{EVERY_OPENING_BUILT_TEXT}</p>
      ) : (
        <ul className="openings-panel__rows" aria-label="Openings met in your games">
          {entries.map((entry) => (
            <MineRow key={metRootKey(entry.root)} entry={entry} controls={controls} />
          ))}
        </ul>
      )}
    </>
  );
}

export interface PracticeAddOpeningProps {
  adds: OpeningAdds;
  // A start is in flight or the style points are not all placed yet, so no add can run.
  busy: boolean;
  // Builds the line of a root, carrying the style points when they are not the default.
  addOpening: AddOpening;
  fetchAddable: FetchAddableOpenings;
  points: StylePoints;
  onPoints(points: StylePoints): void;
  onClose(): void;
}

// Both lists stay mounted while the other is shown, so a switch of tab loses neither the search nor
// the list read. The style points sit above both, since the split is one for the page.
export function PracticeAddOpening({
  adds,
  busy,
  addOpening,
  fetchAddable,
  points,
  onPoints,
  onClose,
}: PracticeAddOpeningProps) {
  const [tab, setTab] = useState<AddTab>("all");
  const idBase = useId();
  const read = useAddableRead(fetchAddable, adds.outcome);
  const mine = metToAddMostMetFirst(adds.met ?? [], adds.unfinished);
  const controls: RowControls = {
    adds,
    busy,
    onAdd: (root, name) => {
      void adds.add({
        key: metRootKey(root),
        name,
        origin: "met",
        run: () => addOpening(root),
      });
    },
  };

  return (
    <section className="openings-panel" aria-label="Add an opening">
      <div className="openings-panel__head">
        <h4 className="openings-panel__title">Add an opening</h4>
        <div className="openings-panel__controls">
          <AddTabs tab={tab} onTab={setTab} mineCount={mine.length} idBase={idBase} />
          <button type="button" className="button openings-panel__close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <StylePointsControl points={points} onChange={onPoints} />
      <div
        role="tabpanel"
        id={`${idBase}-all-panel`}
        aria-labelledby={`${idBase}-all-tab`}
        className="openings-panel__body"
        hidden={tab !== "all"}
      >
        <AllOpeningsTab read={read} controls={controls} />
      </div>
      <div
        role="tabpanel"
        id={`${idBase}-mine-panel`}
        aria-labelledby={`${idBase}-mine-tab`}
        className="openings-panel__body"
        hidden={tab !== "mine"}
      >
        <FromGamesTab entries={mine} controls={controls} />
      </div>
    </section>
  );
}
