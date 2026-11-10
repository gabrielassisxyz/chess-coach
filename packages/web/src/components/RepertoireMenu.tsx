import {
  type MetOpening,
  REPERTOIRE_SCOPES,
  type RepertoireScope,
  type RepertoireSummary,
  type RepertoiresResponse,
  repertoireRootText,
} from "@chess-coach/shared";
import { useState } from "react";
import { type Loaded, useLoaded } from "../hooks/useLoaded.js";
import {
  type AddOpening,
  addOpeningToServer,
  type FetchRepertoireList,
  fetchRepertoireListFromServer,
  gamesText,
  menuOf,
  metNameOf,
  type OpeningMenu,
  rootKeyOf,
  SCOPE_LABEL,
  withoutDrill,
} from "../state/repertoires-api.js";

export interface RepertoireMenuProps {
  repertoires: Loaded<RepertoireSummary[]>;
  // Any start is in flight, from this menu or another card: every button waits.
  busy: boolean;
  // The start this menu sent, whose button says so.
  starting: { repertoireId: number; scope: RepertoireScope } | null;
  onStart(repertoireId: number, scope: RepertoireScope): void;
  // Where the openings met in games come from, and what builds a drill for one; the server's by default.
  fetchList?: FetchRepertoireList | undefined;
  addOpening?: AddOpening | undefined;
}

type MenuActions = Pick<RepertoireMenuProps, "busy" | "starting" | "onStart">;

interface AddOutcome {
  failed: boolean;
  text: string;
}

interface OpeningAdds {
  // The openings the student's games met; null until the list has been read.
  met: MetOpening[] | null;
  // The list could not be read, and no add has read it since.
  unreadable: boolean;
  // The drills as they stand after an add; null before one, when the screen's own list is current.
  built: RepertoireSummary[] | null;
  // The root being built, if any.
  adding: string | null;
  outcome: AddOutcome | null;
  add(entry: MetOpening): Promise<void>;
}

const addFailureText = (error: unknown): string =>
  error instanceof Error && error.message !== ""
    ? error.message
    : "The drill could not be built. Try again.";

// The menu above has the new drill only if the list could be read again; if not, the page says so.
const builtText = (name: string, listed: boolean): string =>
  listed
    ? `${name} is built. Its drill is listed above.`
    : `${name} is built. Reload the page to see its drill.`;

// The list is read once for the met openings. An add reads it again when the run ends, however it
// ended: a run cut off midway has stored part of the drill, and the student should see what is there.
function useOpeningAdds(fetchList: FetchRepertoireList, addOpening: AddOpening): OpeningAdds {
  const opened = useLoaded(fetchList);
  const [listing, setListing] = useState<RepertoiresResponse | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AddOutcome | null>(null);

  const add = async (entry: MetOpening): Promise<void> => {
    setAdding(rootKeyOf(entry.root));
    setOutcome(null);
    let failure: string | null = null;
    try {
      await addOpening(entry.root);
    } catch (error) {
      failure = addFailureText(error);
    }
    let refreshed = true;
    try {
      setListing(await fetchList());
    } catch {
      refreshed = false;
    }
    setAdding(null);
    setOutcome(
      failure === null
        ? { failed: false, text: builtText(metNameOf(entry), refreshed) }
        : { failed: true, text: failure },
    );
  };

  const current = listing ?? (opened.status === "ready" ? opened.value : null);
  return {
    met: current?.met ?? null,
    unreadable: current === null && opened.status === "failed",
    built: listing?.repertoires ?? null,
    adding,
    outcome,
    add,
  };
}

function Starts({
  variation,
  busy,
  starting,
  onStart,
}: { variation: RepertoireSummary } & MenuActions) {
  return (
    <div className="repertoire-menu__starts">
      {REPERTOIRE_SCOPES.map((scope) => {
        const count = variation.moves[scope];
        const mine = starting?.repertoireId === variation.id && starting.scope === scope;
        return (
          <button
            key={scope}
            type="button"
            className={scope === "recommended" ? "button button--primary" : "button"}
            disabled={busy || count === 0}
            onClick={() => onStart(variation.id, scope)}
          >
            {mine ? (
              "Starting"
            ) : (
              <>
                {SCOPE_LABEL[scope]} <span className="repertoire-menu__count">{count}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Opening({ opening, busy, starting, onStart }: { opening: OpeningMenu } & MenuActions) {
  return (
    <div className="repertoire-menu__opening">
      <div className="repertoire-menu__head">
        <h4 className="repertoire-menu__name">{opening.name}</h4>
        <span className="repertoire-menu__due">{opening.due} due</span>
      </div>
      {opening.variations.map((variation) => (
        <div key={variation.id} className="repertoire-menu__variation">
          <p className="repertoire-menu__variation-name">{variation.variation_name}</p>
          <Starts variation={variation} busy={busy} starting={starting} onStart={onStart} />
          {variation.moves.due === 0 ? (
            <p className="practice__card-note">
              Nothing is due. Choose All moves to practise every move anyway.
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function MetRow({
  entry,
  disabled,
  adding,
  onAdd,
}: {
  entry: MetOpening;
  disabled: boolean;
  adding: boolean;
  onAdd(entry: MetOpening): void;
}) {
  const name = metNameOf(entry);
  return (
    <li className="repertoire-menu__met-row">
      <div className="repertoire-menu__met-name">
        <span>{name}</span>
        {entry.opening_name === null ? null : (
          <span className="repertoire-menu__met-line">{repertoireRootText(entry.root)}</span>
        )}
      </div>
      <span className="repertoire-menu__met-games">{gamesText(entry.games)}</span>
      <button
        type="button"
        className="button"
        aria-label={`${adding ? "Building" : "Add"} ${name}`}
        disabled={disabled}
        onClick={() => onAdd(entry)}
      >
        {adding ? "Building" : "Add"}
      </button>
    </li>
  );
}

// The openings the student's reviewed games met and no drill covers yet. Adding one builds its drill,
// which takes minutes, and the new drill appears in the menu above when the run ends.
function MetOpenings({ adds, busy }: { adds: OpeningAdds; busy: boolean }) {
  const entries = withoutDrill(adds.met ?? []);
  const running = adds.adding !== null;
  if (entries.length === 0 && !running && adds.outcome === null && !adds.unreadable) return null;
  return (
    <div className="repertoire-menu__met">
      {adds.unreadable ? (
        <p className="practice__card-note">
          The openings met in your games could not be loaded. Reload the page to try again.
        </p>
      ) : null}
      {entries.length === 0 ? null : (
        <>
          <h4 className="repertoire-menu__name">Met in your games</h4>
          <p className="practice__card-note">
            Openings your opponents played that have no drill yet. Add one to practise against it.
          </p>
          <ul className="repertoire-menu__met-list" aria-label="Openings met in your games">
            {entries.map((entry) => (
              <MetRow
                key={rootKeyOf(entry.root)}
                entry={entry}
                disabled={busy || running}
                adding={adds.adding === rootKeyOf(entry.root)}
                onAdd={adds.add}
              />
            ))}
          </ul>
        </>
      )}
      {running ? (
        <p className="practice__card-note" role="status">
          Building the drill. This takes a few minutes.
        </p>
      ) : null}
      {adds.outcome === null ? null : (
        <p
          className={adds.outcome.failed ? "practice__failure" : "practice__card-note"}
          role={adds.outcome.failed ? "alert" : "status"}
        >
          {adds.outcome.text}
        </p>
      )}
    </div>
  );
}

function Note({ text }: { text: string }) {
  return (
    <section className="practice__card" aria-label="White openings">
      <h3 className="practice__card-title">White openings</h3>
      <p className="practice__card-note" role="status">
        {text}
      </p>
    </section>
  );
}

// The openings the student plays from a stored repertoire, grouped by side and then by opening.
// Each start is a scope of the drill and says how many moves it would serve right now.
export function RepertoireMenu({
  repertoires,
  busy,
  starting,
  onStart,
  fetchList = fetchRepertoireListFromServer,
  addOpening = addOpeningToServer,
}: RepertoireMenuProps) {
  const adds = useOpeningAdds(fetchList, addOpening);
  if (repertoires.status === "loading") return <Note text="Loading openings." />;
  if (repertoires.status === "failed") {
    return <Note text="The openings could not be loaded. Reload the page to try again." />;
  }
  const sides = menuOf(adds.built ?? repertoires.value);
  if (sides.length === 0)
    return <Note text="No opening is stored yet. Generate the Italian repertoire first." />;
  return (
    <>
      {sides.map((side) => (
        <section key={side.side} className="practice__card" aria-label={side.heading}>
          <h3 className="practice__card-title">{side.heading}</h3>
          <p className="practice__card-note">
            Lines played from move 1, each move on its own schedule
          </p>
          {side.openings.map((opening) => (
            <Opening
              key={opening.name}
              opening={opening}
              busy={busy}
              starting={starting}
              onStart={onStart}
            />
          ))}
          {side.side === "white" ? <MetOpenings adds={adds} busy={busy} /> : null}
        </section>
      ))}
    </>
  );
}
