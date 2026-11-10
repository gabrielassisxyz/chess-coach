import {
  type MetOpening,
  type OpeningDrillColor,
  REPERTOIRE_SCOPES,
  type RepertoireBranch,
  type RepertoireBranchChoice,
  type RepertoireLevel,
  type RepertoireScope,
  type RepertoireScopeCounts,
  type RepertoireSummary,
  type RepertoiresResponse,
  repertoireRootText,
} from "@chess-coach/shared";
import { type ReactNode, useId, useState } from "react";
import { type Loaded, useLoaded } from "../hooks/useLoaded.js";
import { type OpeningDrillControls, placeDrills } from "../state/openings-api.js";
import {
  type AddedOpening,
  type AddOpening,
  type AddVariation,
  addOpeningToServer,
  addVariationToServer,
  branchesOf,
  branchKey,
  type FetchCoverage,
  type FetchRepertoireList,
  fetchRepertoireListFromServer,
  foundIdsOf,
  levelAnchorOf,
  menuOf,
  metGamesText,
  metLabelOf,
  metNameOf,
  metRootKey,
  metToAdd,
  type OpeningMenu,
  offersFoundStarts,
  offersGroupStarts,
  offersSideStarts,
  replyMoveText,
  SCOPE_LABEL,
  type SideMenu,
} from "../state/repertoires-api.js";
import { DrillRows, type DrillSlots, drillSlotsOf } from "./OpeningDrills.js";
import { RepertoireCoverage } from "./RepertoireCoverage.js";

// The start in flight: the repertoire it names, its scope, and the level it widens to.
export interface RepertoireStarting {
  repertoireId: number;
  scope: RepertoireScope;
  level?: RepertoireLevel | undefined;
}

export interface RepertoireMenuProps {
  repertoires: Loaded<RepertoireSummary[]>;
  // Any start is in flight, from this menu or another card: every button waits.
  busy: boolean;
  // The start this menu sent, whose button says so.
  starting: RepertoireStarting | null;
  // A start of one variation names no level; a group or a side names its level.
  onStart(repertoireId: number, scope: RepertoireScope, level?: RepertoireLevel): void;
  // Where the openings met in games come from, and what builds a drill for one; the server's by default.
  fetchList?: FetchRepertoireList | undefined;
  addOpening?: AddOpening | undefined;
  // What builds a variation at a branch point; the server's by default.
  addVariation?: AddVariation | undefined;
  // Where a variation's coverage comes from when it is opened; the server's by default.
  fetchCoverage?: FetchCoverage | undefined;
  // The drills from the student's games, once read: each joins the opening that has its name, else
  // the met opening it belongs to, else gets a row of its own. Without them the menu shows none.
  openingDrills?: OpeningDrillControls | undefined;
}

type MenuActions = Pick<RepertoireMenuProps, "busy" | "starting" | "onStart">;

// Where an add was asked from, so its progress and its outcome show beside the row that asked.
type AddOrigin = "met" | "branch";

interface AddRequest {
  key: string;
  name: string;
  origin: AddOrigin;
  run(): Promise<AddedOpening>;
}

interface AddOutcome {
  origin: AddOrigin;
  failed: boolean;
  text: string;
}

interface OpeningAdds {
  // The whole answer as last read; null until it has been read.
  listing: RepertoiresResponse | null;
  // The openings the student's games met; null until the list has been read.
  met: MetOpening[] | null;
  // The list could not be read, and no add has read it since.
  unreadable: boolean;
  // The drills as they stand after an add; null before one, when the screen's own list is current.
  built: RepertoireSummary[] | null;
  // The adds whose last run stopped short: their drill is partial, and adding again resumes it.
  unfinished: ReadonlySet<string>;
  // The add being built, if any.
  adding: { key: string; origin: AddOrigin } | null;
  outcome: AddOutcome | null;
  add(request: AddRequest): Promise<void>;
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

const stoppedText = (name: string): string =>
  `The run for ${name} stopped at its request limit. Add it again to carry on.`;

const withKey = (keys: ReadonlySet<string>, key: string, present: boolean): ReadonlySet<string> => {
  const next = new Set(keys);
  if (present) next.add(key);
  else next.delete(key);
  return next;
};

// The list is read once for the met openings and the branch points. An add reads it again when the
// run ends, however it ended: a run cut off midway has stored part of the drill, and the student
// should see what is there. That unit counts as a drill for the list, so an add whose run stopped
// short is kept on offer for as long as the page lives, and adding it again carries on.
function useOpeningAdds(fetchList: FetchRepertoireList): OpeningAdds {
  const opened = useLoaded(fetchList);
  const [listing, setListing] = useState<RepertoiresResponse | null>(null);
  const [adding, setAdding] = useState<OpeningAdds["adding"]>(null);
  const [outcome, setOutcome] = useState<AddOutcome | null>(null);
  const [unfinished, setUnfinished] = useState<ReadonlySet<string>>(new Set());

  const add = async ({ key, name, origin, run }: AddRequest): Promise<void> => {
    setAdding({ key, origin });
    setOutcome(null);
    let failure: string | null = null;
    let truncated = false;
    try {
      truncated = (await run()).truncated;
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
    setUnfinished((keys) => withKey(keys, key, failure !== null || truncated));
    if (failure !== null) setOutcome({ origin, failed: true, text: failure });
    else if (truncated) setOutcome({ origin, failed: true, text: stoppedText(name) });
    else setOutcome({ origin, failed: false, text: builtText(name, refreshed) });
  };

  const current = listing ?? (opened.status === "ready" ? opened.value : null);
  return {
    listing: current,
    met: current?.met ?? null,
    unreadable: current === null && opened.status === "failed",
    built: listing?.repertoires ?? null,
    unfinished,
    adding,
    outcome,
    add,
  };
}

// What a row of starts drills: one variation, or every variation of a group or of a side, named
// for a screen reader since the three rows read alike.
interface StartTarget {
  repertoireId: number;
  level: RepertoireLevel;
  name: string;
}

const isStarting = (
  starting: RepertoireStarting | null,
  target: StartTarget,
  scope: RepertoireScope,
): boolean =>
  starting?.repertoireId === target.repertoireId &&
  starting.scope === scope &&
  (starting.level ?? "variation") === target.level;

function Starts({
  counts,
  target,
  busy,
  starting,
  onStart,
}: { counts: RepertoireScopeCounts; target: StartTarget } & MenuActions) {
  return (
    <div className="repertoire-menu__starts">
      {REPERTOIRE_SCOPES.map((scope) => {
        const count = counts[scope];
        const mine = isStarting(starting, target, scope);
        const text = mine ? "Starting" : `${SCOPE_LABEL[scope]} ${count}`;
        return (
          <button
            key={scope}
            type="button"
            className={scope === "recommended" ? "button button--primary" : "button"}
            aria-label={target.level === "variation" ? undefined : `${text}, ${target.name}`}
            disabled={busy || count === 0}
            onClick={() =>
              target.level === "variation"
                ? onStart(target.repertoireId, scope)
                : onStart(target.repertoireId, scope, target.level)
            }
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

// The starts of a level above one variation: everything under it at once, each move still asked
// against its own variation.
function LevelStarts({
  label,
  counts,
  target,
  ...actions
}: { label: string; counts: RepertoireScopeCounts; target: StartTarget } & MenuActions) {
  return (
    <div className="repertoire-menu__level">
      <p className="repertoire-menu__level-name">{label}</p>
      <Starts counts={counts} target={target} {...actions} />
    </div>
  );
}

// The coverage is read when the student opens it, not with the menu: it walks every stored move.
function Variation({
  variation,
  busy,
  starting,
  onStart,
  fetchCoverage,
}: { variation: RepertoireSummary; fetchCoverage: FetchCoverage | undefined } & MenuActions) {
  const [showingCoverage, setShowingCoverage] = useState(false);
  const target = { repertoireId: variation.id, level: "variation" as const, name: "" };
  return (
    <div className="repertoire-menu__variation">
      <p className="repertoire-menu__variation-name">{variation.variation_name}</p>
      <Starts
        counts={variation.moves}
        target={target}
        busy={busy}
        starting={starting}
        onStart={onStart}
      />
      {variation.moves.due === 0 ? (
        <p className="practice__card-note">
          Nothing is due. Choose All moves to practise every move anyway.
        </p>
      ) : null}
      <div className="repertoire-menu__starts">
        <button
          type="button"
          className="button button--quiet"
          aria-expanded={showingCoverage}
          aria-label={`Coverage of ${variation.variation_name}`}
          onClick={() => setShowingCoverage(!showingCoverage)}
        >
          Coverage
        </button>
      </div>
      {showingCoverage ? (
        <RepertoireCoverage
          repertoireId={variation.id}
          name={variation.variation_name}
          fetchCoverage={fetchCoverage}
        />
      ) : null}
    </div>
  );
}

// A held choice says where it is: the variation built with it, or the one that already plays it
// there, which can be a variation named after another move.
function heldText(choice: RepertoireBranchChoice, holderName: string | null): string {
  return holderName === null || holderName === choice.variation_name
    ? "In your repertoire"
    : `Played in ${holderName}`;
}

function ChoiceRow({
  branch,
  choice,
  adds,
  busy,
  addVariation,
  variationName,
}: {
  branch: RepertoireBranch;
  choice: RepertoireBranchChoice;
  adds: OpeningAdds;
  busy: boolean;
  addVariation: AddVariation;
  variationName(id: number): string | null;
}) {
  const key = branchKey(branch.line, choice.san);
  const holder = choice.repertoire_id;
  const held = holder !== null && !adds.unfinished.has(key);
  const adding = adds.adding?.key === key;
  const name = choice.variation_name;
  const add = (): Promise<void> =>
    adds.add({
      key,
      name,
      origin: "branch",
      run: () => addVariation([...branch.line, choice.san]),
    });
  return (
    <li className="repertoire-menu__met-row">
      <span className="repertoire-menu__met-name">{name}</span>
      <span className="repertoire-menu__met-games">
        {held ? heldText(choice, variationName(holder)) : null}
      </span>
      {held ? null : (
        <button
          type="button"
          className="button"
          aria-label={`${adding ? "Building" : "Add"} ${name}`}
          disabled={busy || adds.adding !== null}
          onClick={add}
        >
          {adding ? "Building" : "Add"}
        </button>
      )}
    </li>
  );
}

// One position where the book gives White more than one move, written as the reply before it.
function BranchPoint({
  branch,
  ...row
}: { branch: RepertoireBranch } & Omit<Parameters<typeof ChoiceRow>[0], "branch" | "choice">) {
  const reply = replyMoveText(branch.line.slice(0, -1), branch.line.at(-1) ?? "");
  return (
    <div className="repertoire-menu__branch">
      <p className="repertoire-menu__branch-at">
        <span>After {reply}</span>
        <span className="repertoire-menu__met-line">{repertoireRootText(branch.line)}</span>
      </p>
      <ul className="repertoire-menu__met-list" aria-label={`White's moves after ${reply}`}>
        {branch.choices.map((choice) => (
          <ChoiceRow key={choice.san} branch={branch} choice={choice} {...row} />
        ))}
      </ul>
    </div>
  );
}

function AddStatus({ adds, origin }: { adds: OpeningAdds; origin: AddOrigin }) {
  const outcome = adds.outcome?.origin === origin ? adds.outcome : null;
  return (
    <>
      {adds.adding?.origin === origin ? (
        <p className="practice__card-note" role="status">
          Building the drill. This takes a few minutes.
        </p>
      ) : null}
      {outcome === null ? null : (
        <p
          className={outcome.failed ? "practice__failure" : "practice__card-note"}
          role={outcome.failed ? "alert" : "status"}
        >
          {outcome.text}
        </p>
      )}
    </>
  );
}

// The book's other White moves where the opening's first variation goes. Adding one builds a
// variation of the same opening that plays it there; the list is opened on demand, being long.
function Branches({
  branches,
  ...row
}: { branches: RepertoireBranch[] } & Omit<Parameters<typeof ChoiceRow>[0], "branch" | "choice">) {
  const [open, setOpen] = useState(false);
  if (branches.length === 0) return null;
  return (
    <div className="repertoire-menu__branches">
      <div className="repertoire-menu__starts">
        <button
          type="button"
          className="button button--quiet"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Add a variation
        </button>
      </div>
      {open ? (
        <>
          <p className="practice__card-note">
            Where the book gives White more than one move. A variation added here plays that move
            there and the usual moves everywhere else.
          </p>
          {branches.map((branch) => (
            <BranchPoint key={branch.line.join(" ")} branch={branch} {...row} />
          ))}
        </>
      ) : null}
      <AddStatus adds={row.adds} origin="branch" />
    </div>
  );
}

function Opening({
  opening,
  adds,
  addVariation,
  fetchCoverage,
  variationName,
  drillLine,
  ...actions
}: {
  opening: OpeningMenu;
  adds: OpeningAdds;
  addVariation: AddVariation;
  fetchCoverage: FetchCoverage | undefined;
  variationName(id: number): string | null;
  drillLine: ReactNode;
} & MenuActions) {
  const anchor = levelAnchorOf(opening.variations);
  return (
    <div className="repertoire-menu__opening">
      <div className="repertoire-menu__head">
        <h4 className="repertoire-menu__name">{opening.name}</h4>
        <span className="repertoire-menu__due">{opening.due} due</span>
      </div>
      {offersGroupStarts(opening) && opening.moves && anchor !== null ? (
        <LevelStarts
          label="Every variation"
          counts={opening.moves}
          target={{
            repertoireId: anchor,
            level: "group",
            name: `every variation of ${opening.name}`,
          }}
          {...actions}
        />
      ) : null}
      {opening.variations.map((variation) => (
        <Variation
          key={variation.id}
          variation={variation}
          fetchCoverage={fetchCoverage}
          {...actions}
        />
      ))}
      <Branches
        branches={branchesOf(adds.listing?.branches, opening.name)}
        adds={adds}
        busy={actions.busy}
        addVariation={addVariation}
        variationName={variationName}
      />
      {drillLine}
    </div>
  );
}

function MetRow({
  entry,
  disabled,
  adding,
  onAdd,
  drillLine,
}: {
  entry: MetOpening;
  disabled: boolean;
  adding: boolean;
  onAdd(entry: MetOpening): void;
  drillLine: ReactNode;
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
      <span className="repertoire-menu__met-games">{metGamesText(entry.games)}</span>
      <button
        type="button"
        className="button"
        aria-label={`${adding ? "Building" : "Add"} ${metLabelOf(entry)}`}
        disabled={disabled}
        onClick={() => onAdd(entry)}
      >
        {adding ? "Building" : "Add"}
      </button>
      {drillLine}
    </li>
  );
}

// The openings the student's reviewed games met and no drill covers yet. Adding one builds its drill,
// which takes minutes, and the new drill joins the added ones above when the run ends.
function MetToAdd({
  entries,
  adds,
  busy,
  addOpening,
  metLine,
}: {
  entries: readonly MetOpening[];
  adds: OpeningAdds;
  busy: boolean;
  addOpening: AddOpening;
  metLine: DrillSlots["metLine"];
}) {
  const add = (entry: MetOpening): Promise<void> =>
    adds.add({
      key: metRootKey(entry.root),
      name: metNameOf(entry),
      origin: "met",
      run: () => addOpening(entry.root),
    });
  return (
    <div className="repertoire-menu__met">
      <p className="practice__card-note">
        Openings your opponents played that have no drill yet. Add one to practise against it.
      </p>
      <ul className="repertoire-menu__met-list" aria-label="Openings met in your games">
        {entries.map((entry) => (
          <MetRow
            key={metRootKey(entry.root)}
            entry={entry}
            disabled={busy || adds.adding !== null}
            adding={adds.adding?.key === metRootKey(entry.root)}
            onAdd={add}
            drillLine={metLine(metRootKey(entry.root))}
          />
        ))}
      </ul>
    </div>
  );
}

// Found in your games: the units built from the openings the student's games met, each with its
// menu, then the openings still to add, then one start that mixes every added one, since a game
// does not say which of them comes next. With nothing built and nothing to add there is no
// section, only what an add or an unreadable list has to say.
function FoundInGames({
  adds,
  busy,
  addOpening,
  metLine,
  openings,
  starts,
}: {
  adds: OpeningAdds;
  busy: boolean;
  addOpening: AddOpening;
  metLine: DrillSlots["metLine"];
  // The menus of the added units, drawn by the side, which holds what they need.
  openings: ReactNode[];
  // The mixed starts, or null where none is offered.
  starts: ReactNode;
}) {
  const headingId = useId();
  const entries = metToAdd(adds.met ?? [], adds.unfinished);
  const running = adds.adding?.origin === "met";
  const told = adds.outcome?.origin === "met";
  if (openings.length === 0 && entries.length === 0) {
    if (!running && !told && !adds.unreadable) return null;
    return (
      <div className="repertoire-menu__met">
        {adds.unreadable ? (
          <p className="practice__card-note">
            The openings met in your games could not be loaded. Reload the page to try again.
          </p>
        ) : null}
        <AddStatus adds={adds} origin="met" />
      </div>
    );
  }
  return (
    <section className="repertoire-menu__found" aria-labelledby={headingId}>
      <h4 id={headingId} className="repertoire-menu__name">
        Found in your games
      </h4>
      {openings}
      {entries.length === 0 ? null : (
        <MetToAdd
          entries={entries}
          adds={adds}
          busy={busy}
          addOpening={addOpening}
          metLine={metLine}
        />
      )}
      <AddStatus adds={adds} origin="met" />
      {starts === null ? null : <div className="repertoire-menu__found-starts">{starts}</div>}
    </section>
  );
}

function Note({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <section className="practice__card" aria-label="White openings">
      <h3 className="practice__card-title">White openings</h3>
      <p className="practice__card-note" role="status">
        {text}
      </p>
      {children}
    </section>
  );
}

const COLORS: readonly OpeningDrillColor[] = ["white", "black"];

// A colour whose openings have no stored drill is a card of drills alone, since nothing above them
// could hold them. Nothing is drawn for a colour with no positions.
function DrillOnlyCard({
  color,
  controls,
  busy,
}: {
  color: OpeningDrillColor;
  controls: OpeningDrillControls | undefined;
  busy: boolean;
}) {
  const drills = controls?.drills[color] ?? [];
  if (!controls || drills.length === 0) return null;
  const heading = `${color === "white" ? "White" : "Black"} openings`;
  const { rows } = drillSlotsOf(color, controls, busy, placeDrills(drills, new Set(), []));
  return (
    <section className="practice__card" aria-label={heading}>
      <h3 className="practice__card-title">{heading}</h3>
      {rows}
    </section>
  );
}

// Where the drills of a side go. They wait for the met openings to be read, so a row never shows and
// then moves onto a met opening that arrives after it.
function drillSlotsOfSide(
  side: SideMenu,
  adds: OpeningAdds,
  busy: boolean,
  controls: OpeningDrillControls | undefined,
): DrillSlots | null {
  const metSettled = side.side !== "white" || adds.met !== null || adds.unreadable;
  if (!controls || !metSettled) return null;
  const met = side.side === "white" ? metToAdd(adds.met ?? [], adds.unfinished) : [];
  const names = new Set([...side.openings, ...side.found].map((opening) => opening.name));
  return drillSlotsOf(
    side.side,
    controls,
    busy,
    placeDrills(controls.drills[side.side], names, met),
  );
}

// The mixed starts of the found openings, drilled from the first added unit the menu lists.
function foundStartsOf(side: SideMenu, actions: MenuActions): ReactNode {
  const anchor = levelAnchorOf(side.found.flatMap((opening) => opening.variations));
  if (!offersFoundStarts(side) || !side.foundMoves || anchor === null) return null;
  return (
    <LevelStarts
      label="Every added opening, mixed"
      counts={side.foundMoves}
      target={{
        repertoireId: anchor,
        level: "found",
        name: "every added opening found in your games",
      }}
      {...actions}
    />
  );
}

function Side({
  side,
  adds,
  addOpening,
  addVariation,
  fetchCoverage,
  openingDrills,
  ...actions
}: {
  side: SideMenu;
  adds: OpeningAdds;
  addOpening: AddOpening;
  addVariation: AddVariation;
  fetchCoverage: FetchCoverage | undefined;
  openingDrills: OpeningDrillControls | undefined;
} & MenuActions) {
  const slots = drillSlotsOfSide(side, adds, actions.busy, openingDrills);
  const variations = [...side.openings, ...side.found].flatMap((opening) => opening.variations);
  const anchor = levelAnchorOf(variations);
  const variationName = (id: number): string | null =>
    variations.find((variation) => variation.id === id)?.variation_name ?? null;
  const every = `every ${side.side === "white" ? "White" : "Black"} opening`;
  const openingMenu = (opening: OpeningMenu): ReactNode => (
    <Opening
      key={opening.name}
      opening={opening}
      adds={adds}
      addVariation={addVariation}
      fetchCoverage={fetchCoverage}
      variationName={variationName}
      drillLine={slots?.menuLine(opening.name) ?? null}
      {...actions}
    />
  );
  return (
    <section className="practice__card" aria-label={side.heading}>
      <h3 className="practice__card-title">{side.heading}</h3>
      <p className="practice__card-note">Lines played from move 1, each move on its own schedule</p>
      {offersSideStarts(side) && side.moves && anchor !== null ? (
        <LevelStarts
          label="Every opening"
          counts={side.moves}
          target={{ repertoireId: anchor, level: "side", name: every }}
          {...actions}
        />
      ) : null}
      {side.openings.map(openingMenu)}
      {side.side === "white" ? (
        <FoundInGames
          adds={adds}
          busy={actions.busy}
          addOpening={addOpening}
          metLine={slots?.metLine ?? (() => null)}
          openings={side.found.map(openingMenu)}
          starts={foundStartsOf(side, actions)}
        />
      ) : null}
      {slots?.rows}
    </section>
  );
}

// The openings the student plays from a stored repertoire, grouped by side and then by opening.
// Each start is a scope of the drill and says how many moves it would serve right now; a side or
// an opening with more than one thing under it also starts everything under it at once. The
// openings built from the student's games sit apart under White openings, and start mixed.
export function RepertoireMenu({
  repertoires,
  busy,
  starting,
  onStart,
  fetchList = fetchRepertoireListFromServer,
  addOpening = addOpeningToServer,
  addVariation = addVariationToServer,
  fetchCoverage,
  openingDrills,
}: RepertoireMenuProps) {
  const adds = useOpeningAdds(fetchList);
  if (repertoires.status === "loading") return <Note text="Loading openings." />;
  if (repertoires.status === "failed") {
    return <Note text="The openings could not be loaded. Reload the page to try again." />;
  }
  const levels = {
    groups: adds.listing?.groups,
    sides: adds.listing?.sides,
    found: adds.listing?.found,
  };
  const sides = menuOf(adds.built ?? repertoires.value, levels, foundIdsOf(adds.met));
  if (sides.length === 0) {
    return (
      <>
        <Note text="No opening is stored yet. Generate the Italian repertoire first.">
          {openingDrills ? (
            <DrillRows
              color="white"
              drills={openingDrills.drills.white}
              controls={openingDrills}
              busy={busy}
            />
          ) : null}
        </Note>
        <DrillOnlyCard color="black" controls={openingDrills} busy={busy} />
      </>
    );
  }
  return (
    <>
      {sides.map((side) => (
        <Side
          key={side.side}
          side={side}
          adds={adds}
          addOpening={addOpening}
          addVariation={addVariation}
          fetchCoverage={fetchCoverage}
          openingDrills={openingDrills}
          busy={busy}
          starting={starting}
          onStart={onStart}
        />
      ))}
      {COLORS.filter((color) => !sides.some((side) => side.side === color)).map((color) => (
        <DrillOnlyCard key={color} color={color} controls={openingDrills} busy={busy} />
      ))}
    </>
  );
}
