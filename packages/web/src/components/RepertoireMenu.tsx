import {
  type MetOpening,
  type RepertoireBranch,
  type RepertoireBranchChoice,
  type RepertoiresResponse,
  repertoireRootText,
} from "@chess-coach/shared";
import { useId, useState } from "react";
import { useLoaded } from "../hooks/useLoaded.js";
import {
  type AddedOpening,
  type AddVariation,
  branchKey,
  type FetchRepertoireList,
  isDefaultStylePoints,
  moveStylePoint,
  replyMoveText,
  STYLE_MEASURES,
  STYLE_POINTS_TOTAL,
  type StylePoints,
  stylePointsLeft,
  stylePointsLeftText,
} from "../state/repertoires-api.js";

// What the Openings page does when the student asks for another opening or another variation: the
// state of a run that takes minutes, the rows that offer one and the split of style points a line
// is built by. The page draws the openings; this holds what happens around an add.

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

interface RefreshFailure {
  origin: AddOrigin;
  // Set when an add finished cleanly before the list read failed, so a retry restores its built note.
  builtName: string | null;
}

export interface OpeningAdds {
  // The whole answer as last read, and as an add last read it; null until it has been read.
  listing: RepertoiresResponse | null;
  // The openings the student's games met; null until the list has been read.
  met: MetOpening[] | null;
  // The first list read is still in flight, and no add has read it since.
  loading: boolean;
  // The list could not be read, and no add has read it since.
  unreadable: boolean;
  // Retries the initial list read after a failure.
  retry(): void;
  // A post-add list refresh is in flight for this origin.
  refreshing: AddOrigin | null;
  // The post-add list refresh failed for this origin.
  refreshFailure: RefreshFailure | null;
  // Retries a failed post-add list refresh.
  retryRefresh(): Promise<void>;
  // Reads the list again after something other than an add changed a line, such as a rebuild.
  // Answers whether it could; a read that fails leaves the answer as it was.
  refresh(): Promise<boolean>;
  // The adds whose last run stopped short: their drill is partial, and adding again resumes it.
  unfinished: ReadonlySet<string>;
  adding: { key: string; origin: AddOrigin } | null;
  outcome: AddOutcome | null;
  add(request: AddRequest): Promise<void>;
}

const addFailureText = (error: unknown): string =>
  error instanceof Error && error.message !== ""
    ? error.message
    : "The drill could not be built. Try again.";

// A new opening's card joins the page above the area that added it. A new variation's row joins the
// card that offered it, which has to be opened to show it, so only the first says where it went.
const builtText = (name: string, listed: boolean, origin: AddOrigin): string =>
  listed && origin === "met" ? `${name} is built. Its drill is listed above.` : `${name} is built.`;

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
export function useOpeningAdds(fetchList: FetchRepertoireList): OpeningAdds {
  const opened = useLoaded(fetchList);
  const [listing, setListing] = useState<RepertoiresResponse | null>(null);
  const [adding, setAdding] = useState<OpeningAdds["adding"]>(null);
  const [outcome, setOutcome] = useState<AddOutcome | null>(null);
  const [refreshing, setRefreshing] = useState<AddOrigin | null>(null);
  const [refreshFailure, setRefreshFailure] = useState<RefreshFailure | null>(null);
  const [unfinished, setUnfinished] = useState<ReadonlySet<string>>(new Set());

  const add = async ({ key, name, origin, run }: AddRequest): Promise<void> => {
    setAdding({ key, origin });
    setOutcome(null);
    setRefreshFailure(null);
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
    else setOutcome({ origin, failed: false, text: builtText(name, refreshed, origin) });
    setRefreshFailure(
      refreshed ? null : { origin, builtName: failure === null && !truncated ? name : null },
    );
  };

  const retryRefresh = async (): Promise<void> => {
    const failed = refreshFailure;
    if (failed === null || refreshing !== null) return;
    setRefreshing(failed.origin);
    setRefreshFailure(null);
    try {
      setListing(await fetchList());
      if (failed.builtName !== null) {
        setOutcome({
          origin: failed.origin,
          failed: false,
          text: builtText(failed.builtName, true, failed.origin),
        });
      }
    } catch {
      setRefreshFailure(failed);
    } finally {
      setRefreshing(null);
    }
  };

  const refresh = async (): Promise<boolean> => {
    try {
      setListing(await fetchList());
      return true;
    } catch {
      return false;
    }
  };

  const current = listing ?? (opened.status === "ready" ? opened.value : null);
  return {
    listing: current,
    met: current?.met ?? null,
    loading: current === null && opened.status === "loading",
    unreadable: current === null && opened.status === "failed",
    retry: opened.status === "failed" ? opened.retry : () => undefined,
    refreshing,
    refreshFailure,
    retryRefresh,
    refresh,
    unfinished,
    adding,
    outcome,
    add,
  };
}

// A held choice says where it is: the variation built with it, or the one that already plays it
// there, which can be a variation named after another move.
function heldText(choice: RepertoireBranchChoice, holderName: string | null): string {
  return holderName === null || holderName === choice.variation_name
    ? "In your repertoire"
    : `Played in ${holderName}`;
}

// What a row that adds a variation needs besides the choice it is for.
export interface ChoiceContext {
  adds: OpeningAdds;
  busy: boolean;
  addVariation: AddVariation;
  variationName(id: number): string | null;
}

function ChoiceRow({
  branch,
  choice,
  adds,
  busy,
  addVariation,
  variationName,
}: { branch: RepertoireBranch; choice: RepertoireBranchChoice } & ChoiceContext) {
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
          disabled={busy || adds.adding !== null || adds.refreshing !== null}
          onClick={add}
        >
          {adding ? "Building" : "Add"}
        </button>
      )}
    </li>
  );
}

// One position where the book gives White more than one move, written as the reply before it.
function BranchPoint({ branch, ...row }: { branch: RepertoireBranch } & ChoiceContext) {
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

// Progress and outcome of the add that was asked from one origin, shown beside the rows that asked.
export function AddStatus({ adds, origin }: { adds: OpeningAdds; origin: AddOrigin }) {
  const outcome = adds.outcome?.origin === origin ? adds.outcome : null;
  const refreshing = adds.refreshing === origin;
  const refreshFailed = adds.refreshFailure?.origin === origin;
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
      {refreshing ? (
        <p className="practice__card-note" role="status">
          Loading openings.
        </p>
      ) : null}
      {refreshFailed ? (
        <>
          <p className="practice__failure" role="alert">
            The openings list could not be loaded.
          </p>
          <div className="controls__row">
            <button
              type="button"
              className="button"
              onClick={() => {
                void adds.retryRefresh();
              }}
            >
              Try again
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}

// The book's other White moves where the opening's first variation goes. Adding one builds a
// variation of the same opening that plays it there and the usual moves everywhere else.
export function BranchChoices({
  branches,
  ...row
}: { branches: readonly RepertoireBranch[] } & ChoiceContext) {
  return (
    <div className="repertoire-menu__branches">
      <p className="practice__card-note">
        Where the book gives White more than one move. A variation added here plays that move there
        and the usual moves everywhere else.
      </p>
      {branches.map((branch) => (
        <BranchPoint key={branch.line.join(" ")} branch={branch} {...row} />
      ))}
    </div>
  );
}

// What a collapsed control says of a split that is not the default, or not complete yet.
function stylePointsSummary(points: StylePoints): string | null {
  const incomplete = stylePointsLeftText(points);
  if (incomplete !== null) return incomplete;
  if (isDefaultStylePoints(points)) return null;
  return STYLE_MEASURES.map(({ key, label }) => `${label} ${points[key]}`).join(", ");
}

// One row for each measure: its name and what it favours, and a stepper that moves a point on or
// off it. The same rows set the points of an add and of a rebuild, so both read alike.
export function StylePointRows({
  points,
  onChange,
}: {
  points: StylePoints;
  onChange(points: StylePoints): void;
}) {
  const left = stylePointsLeft(points);
  return (
    <>
      {STYLE_MEASURES.map(({ key, label, hint }) => (
        <div key={key} className="repertoire-menu__points-row">
          <span className="repertoire-menu__points-name">
            <span>{label}</span>
            <span className="repertoire-menu__points-hint">{hint}</span>
          </span>
          <span className="repertoire-menu__points-stepper">
            <button
              type="button"
              className="button"
              aria-label={`Fewer points for ${label.toLowerCase()}`}
              disabled={points[key] === 0}
              onClick={() => onChange(moveStylePoint(points, key, -1))}
            >
              −
            </button>
            <span className="repertoire-menu__points-value">{points[key]}</span>
            <button
              type="button"
              className="button"
              aria-label={`More points for ${label.toLowerCase()}`}
              disabled={left === 0}
              onClick={() => onChange(moveStylePoint(points, key, 1))}
            >
              +
            </button>
          </span>
        </div>
      ))}
    </>
  );
}

// Where White has more than one good move, an opening or a variation added from the page chooses
// by these points. They are the student's to place, so an add waits until all of them are.
export function StylePointsControl({
  points,
  onChange,
}: {
  points: StylePoints;
  onChange(points: StylePoints): void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const summary = stylePointsSummary(points);
  return (
    <div className="repertoire-menu__points">
      <div className="repertoire-menu__starts">
        <button
          type="button"
          className="button button--quiet"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen(!open)}
        >
          Style points
        </button>
        <span className="repertoire-menu__points-summary" aria-live="polite">
          {summary}
        </span>
      </div>
      {open ? (
        <div id={panelId}>
          <p className="practice__card-note">
            Place {STYLE_POINTS_TOTAL} points. Where White has more than one good move, the openings
            and variations you add choose by them. Each gets 2 until you change it.
          </p>
          <StylePointRows points={points} onChange={onChange} />
        </div>
      ) : null}
    </div>
  );
}

type AddLine = (line: readonly string[], points?: StylePoints) => Promise<AddedOpening>;

// The split goes with an add only once the student has moved it off the default, which the server
// applies by itself: a page nobody touched makes the same call as before.
export const withStylePoints =
  (add: AddLine, points: StylePoints) =>
  (line: readonly string[]): Promise<AddedOpening> =>
    isDefaultStylePoints(points) ? add(line) : add(line, points);
