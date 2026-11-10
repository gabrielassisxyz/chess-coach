import {
  REPERTOIRE_SCOPES,
  type RepertoireScope,
  type RepertoireSummary,
} from "@chess-coach/shared";
import type { Loaded } from "../hooks/useLoaded.js";
import { menuOf, type OpeningMenu, SCOPE_LABEL } from "../state/repertoires-api.js";

export interface RepertoireMenuProps {
  repertoires: Loaded<RepertoireSummary[]>;
  // Any start is in flight, from this menu or another card: every button waits.
  busy: boolean;
  // The start this menu sent, whose button says so.
  starting: { repertoireId: number; scope: RepertoireScope } | null;
  onStart(repertoireId: number, scope: RepertoireScope): void;
}

type MenuActions = Omit<RepertoireMenuProps, "repertoires">;

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
export function RepertoireMenu({ repertoires, busy, starting, onStart }: RepertoireMenuProps) {
  if (repertoires.status === "loading") return <Note text="Loading openings." />;
  if (repertoires.status === "failed") {
    return <Note text="The openings could not be loaded. Reload the page to try again." />;
  }
  const sides = menuOf(repertoires.value);
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
        </section>
      ))}
    </>
  );
}
