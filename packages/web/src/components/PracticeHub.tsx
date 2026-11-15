import type {
  FoundPositionsResponse,
  OpeningDrillColor,
  OpeningDrillsResponse,
  ProgressResponse,
  RepertoireLevel,
  RepertoireScope,
  RepertoireSummary,
  TrainingMode,
} from "@chess-coach/shared";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Loaded } from "../hooks/useLoaded.js";
import {
  type FetchFoundPositions,
  type FoundStartRequest,
  fetchFoundPositionsFromServer,
} from "../state/found-api.js";
import type { OpeningDrillControls } from "../state/openings-api.js";
import {
  italianOpeningCount,
  type MotifCount,
  NEEDS_ENGINE_TEXT,
  NONE,
} from "../state/practice.js";
import {
  openingsDueOf,
  PRACTICE_ENTRY_LABEL,
  type PracticeEntry,
  type PracticePage,
  practicePageOf,
  UNBUILT_PRACTICE_PAGES,
  usePracticeEntry,
} from "../state/practice-page.js";
import {
  type AddOpening,
  type AddVariation,
  type FetchCoverage,
  type FetchRepertoireList,
  fetchRepertoireListFromServer,
} from "../state/repertoires-api.js";
import type { FetchThemeStats } from "../state/theme-stats-api.js";
import type { BoardFactory } from "./Board.js";
import { FoundOverviewPanel } from "./FoundOverviewPanel.js";
import { type FoundStarting, PracticeFound } from "./PracticeFound.js";
import { PracticeNav } from "./PracticeNav.js";
import { type HubStartButton, PracticeOverview, PracticePageHead } from "./PracticeOverview.js";
import { PracticeThemeStats } from "./PracticeThemeStats.js";
import { RepertoireMenu } from "./RepertoireMenu.js";

// The positions found in the student's games, which the hub draws three ways: a count beside its
// navigation entry, a panel on the Overview and a page of cards. A hub given none draws none.
export interface FoundPositionsProps {
  // The whole list, read once for all three.
  positions: Loaded<FoundPositionsResponse>;
  // The read that narrows the page's list by colour and phase; the server's by default.
  fetchPositions?: FetchFoundPositions | undefined;
  onStart(request: FoundStartRequest): void;
  // How the page's boards are made; chessground's by default.
  createBoard?: BoardFactory | undefined;
}

export interface PracticeHubProps {
  progress: Loaded<ProgressResponse>;
  motifs: Loaded<MotifCount[]>;
  repertoires: Loaded<RepertoireSummary[]>;
  engineMissing: boolean;
  // A repertoire start carries its scope in `motif`, names its repertoire and, above one
  // variation, its level. An opening drill carries its colour in `motif` and the family it drills.
  starting: {
    mode: TrainingMode;
    motif: string;
    repertoireId?: number;
    level?: RepertoireLevel | undefined;
    opening?: string | undefined;
    position?: string | undefined;
  } | null;
  failure: string | null;
  onStart(mode: TrainingMode, motif: string): void;
  onStartRepertoire(repertoireId: number, scope: RepertoireScope, level?: RepertoireLevel): void;
  // The drills from the student's games, grouped by opening, and what starts one of them. Without
  // them, or until they are read, the hub lists none.
  openingDrills?: Loaded<OpeningDrillsResponse> | undefined;
  onStartOpening?: ((color: OpeningDrillColor, opening: string) => void) | undefined;
  foundPositions?: FoundPositionsProps | undefined;
  now?: Date;
  // The openings met in games and the call that builds a drill for one; the server's by default.
  fetchRepertoireList?: FetchRepertoireList | undefined;
  addOpening?: AddOpening | undefined;
  // What builds a variation at a branch point; the server's by default.
  addVariation?: AddVariation | undefined;
  // Where a variation's coverage comes from when it is opened; the server's by default.
  fetchCoverage?: FetchCoverage | undefined;
  // Where ranked puzzle theme stats come from when a Stats theme page opens; the server's by default.
  fetchThemeStats?: FetchThemeStats | undefined;
  // The engine and coach problem cards, which the Overview draws under its title.
  problems?: ReactNode;
}

function ItalianRow({
  counts,
  known,
  startButton,
}: {
  counts: MotifCount[];
  known: boolean;
  startButton: HubStartButton;
}): ReactNode {
  const count = italianOpeningCount(counts);
  const empty = known && count === 0;
  return (
    <div className="practice__opening" key="italian">
      <span className="practice__opening-side">As White</span>
      <span className="practice__opening-count">
        {known ? (count === 0 ? NONE : `${count} positions`) : ""}
      </span>
      {startButton({
        mode: "puzzles",
        motif: "opening-italian",
        idle: "Drill",
        disabled: empty,
      })}
      {empty ? <span className="practice__card-note">Generate the Italian drill first</span> : null}
    </div>
  );
}

// The controls of the drills from the student's games, once they are read and something can start them.
function drillControlsOf(props: PracticeHubProps): OpeningDrillControls | undefined {
  const { openingDrills, onStartOpening, starting, engineMissing } = props;
  if (openingDrills?.status !== "ready" || !onStartOpening) return undefined;
  const mine = starting?.mode === "openings" && starting.opening !== undefined;
  return {
    drills: openingDrills.value,
    engineMissing,
    starting: mine
      ? { color: starting.motif as OpeningDrillColor, opening: starting.opening as string }
      : null,
    onStart: onStartOpening,
  };
}

// The Openings entry counts from the answers the openings menu reads, so the number follows the
// menu's retries and the drills it adds, and the count asks the server nothing of its own.
function useOpeningsDue(fetchList: FetchRepertoireList) {
  const [due, setDue] = useState<number | null>(null);
  const counted = useCallback<FetchRepertoireList>(async () => {
    const listing = await fetchList();
    setDue(openingsDueOf(listing));
    return listing;
  }, [fetchList]);
  return { due, fetchList: counted };
}

// The page scrolls in whichever box holds it: the screen on a desktop, the frame on a phone.
function scrollToTop(hub: HTMLElement | null): void {
  for (let box = hub; box !== null; box = box.parentElement) box.scrollTop = 0;
}

// Choosing an entry moves the page: Puzzle themes to the Overview's themes section, which is not a
// page of its own, and any other entry to the top. Puzzle themes kept from a visit before moves there too.
function usePageScroll(
  entry: PracticeEntry,
  choices: number,
  hub: RefObject<HTMLElement | null>,
  themes: RefObject<HTMLElement | null>,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: every choice moves the page, the same entry chosen again too
  useEffect(() => {
    if (entry === "puzzle-themes") themes.current?.scrollIntoView({ block: "start" });
    else scrollToTop(hub.current);
  }, [entry, choices]);
}

// Every page stays mounted and only the one on screen is shown, so a page keeps what the student
// left on it, an opening still being built among it. The outer box has no display rule of its own,
// so the hidden attribute alone hides it.
function PageSlot({ shown, children }: { shown: boolean; children: ReactNode }) {
  return (
    <div hidden={!shown}>
      <div className="practice-page">{children}</div>
    </div>
  );
}

// The older Italian drill row, in the card the hub has always called Openings.
function ItalianCard({ hub, startButton }: { hub: PracticeHubProps; startButton: HubStartButton }) {
  const { motifs, openingDrills, engineMissing } = hub;
  return (
    <section className="practice__card" aria-label="Openings">
      <h3 className="practice__card-title">Openings</h3>
      {openingDrills?.status === "loading" ? (
        <p className="practice__card-note" role="status">
          Loading positions from your games.
        </p>
      ) : null}
      {openingDrills?.status === "failed" ? (
        <>
          <p className="practice__failure" role="alert">
            The positions from your games could not be loaded.
          </p>
          <button type="button" className="button" onClick={openingDrills.retry}>
            Try again
          </button>
        </>
      ) : null}
      <p className="practice__card-note">Italian Opening</p>
      <ItalianRow
        counts={motifs.status === "ready" ? motifs.value : []}
        known={motifs.status === "ready"}
        startButton={startButton}
      />
      {engineMissing ? <p className="practice__card-note">{NEEDS_ENGINE_TEXT}</p> : null}
    </section>
  );
}

// Today's openings menu on a page of its own; the hub's starts arrive already marked with this page.
function OpeningsPage({
  hub,
  startButton,
  fetchList,
  failure,
}: {
  hub: PracticeHubProps;
  startButton: HubStartButton;
  fetchList: FetchRepertoireList;
  failure: ReactNode;
}) {
  const { starting } = hub;
  return (
    <>
      <PracticePageHead title="Openings" />
      <div className="practice-page__cards">
        <RepertoireMenu
          repertoires={hub.repertoires}
          busy={starting !== null}
          starting={
            starting?.mode === "repertoire" && starting.repertoireId !== undefined
              ? {
                  repertoireId: starting.repertoireId,
                  scope: starting.motif as RepertoireScope,
                  level: starting.level,
                }
              : null
          }
          onStart={hub.onStartRepertoire}
          fetchList={fetchList}
          addOpening={hub.addOpening}
          addVariation={hub.addVariation}
          fetchCoverage={hub.fetchCoverage}
          openingDrills={drillControlsOf(hub)}
        />
        <ItalianCard hub={hub} startButton={startButton} />
      </div>
      {failure}
    </>
  );
}

// The pages whose content is still to come, each saying so under its title.
function UnbuiltPages({ page }: { page: PracticePage }) {
  return UNBUILT_PRACTICE_PAGES.map((unbuilt) => (
    <PageSlot key={unbuilt} shown={page === unbuilt}>
      <PracticePageHead title={PRACTICE_ENTRY_LABEL[unbuilt]} note="This page is not built yet." />
    </PageSlot>
  ));
}

// Each start remembers the page it was pressed on, where its refusal is then shown.
function useStartsByPage(props: PracticeHubProps, page: PracticePage) {
  const [startedOn, setStartedOn] = useState<PracticePage>(page);
  const pressedHere = <Args extends unknown[]>(start: (...args: Args) => void) => {
    return (...args: Args): void => {
      setStartedOn(page);
      start(...args);
    };
  };
  const { onStartOpening, foundPositions, failure } = props;
  const marked: PracticeHubProps = {
    ...props,
    onStart: pressedHere(props.onStart),
    onStartRepertoire: pressedHere(props.onStartRepertoire),
    onStartOpening: onStartOpening ? pressedHere(onStartOpening) : undefined,
    foundPositions: foundPositions
      ? { ...foundPositions, onStart: pressedHere(foundPositions.onStart) }
      : undefined,
  };
  const failureOn = (target: PracticePage): ReactNode =>
    failure && startedOn === target ? (
      <p className="practice__failure" role="alert">
        {failure}
      </p>
    ) : null;
  return { marked, failureOn };
}

function startButtonOf({ starting, engineMissing, onStart }: PracticeHubProps): HubStartButton {
  return ({ mode, motif: target, idle, disabled = false }) => {
    const mine = starting?.mode === mode && starting.motif === target;
    return (
      <button
        type="button"
        className="button button--primary"
        disabled={starting !== null || engineMissing || disabled}
        onClick={() => onStart(mode, target)}
      >
        {mine ? "Starting" : idle}
      </button>
    );
  };
}

// A drill of the positions from the student's games names its scope where a puzzle start names its
// motif, and a card's start names its position.
function foundStartingOf(starting: PracticeHubProps["starting"]): FoundStarting | null {
  if (starting?.mode !== "found") return null;
  return { scope: starting.motif as RepertoireScope, position: starting.position };
}

// The number beside From my games is the positions due in the whole list, whatever the page filters.
const foundDueOf = (found: FoundPositionsProps | undefined): number | null =>
  found?.positions.status === "ready" ? found.positions.value.counts.due : null;

// The hub's frame: the navigation of its pages beside a column that shows one page at a time.
export function PracticeHub(props: PracticeHubProps) {
  const { entry, choose } = usePracticeEntry();
  const [choices, setChoices] = useState(0);
  const page = practicePageOf(entry);
  const { marked, failureOn } = useStartsByPage(props, page);
  const openingsDue = useOpeningsDue(props.fetchRepertoireList ?? fetchRepertoireListFromServer);
  const hub = useRef<HTMLDivElement>(null);
  const themes = useRef<HTMLElement>(null);
  usePageScroll(entry, choices, hub, themes);
  const startButton = startButtonOf(marked);
  const onChoose = (next: PracticeEntry): void => {
    choose(next);
    setChoices((count) => count + 1);
  };
  // One clock for as long as the hub is drawn, so the cards, which wait for a change of their own
  // props, are not drawn again at every render.
  const now = useMemo(() => props.now ?? new Date(), [props.now]);
  const found = marked.foundPositions;
  const foundStarting = foundStartingOf(marked.starting);
  const busy = props.starting !== null;

  return (
    <div className="practice-hub" ref={hub}>
      <PracticeNav
        current={entry}
        onChoose={onChoose}
        openingsDue={openingsDue.due}
        foundDue={foundDueOf(found)}
      />
      <div className="practice-hub__pages" aria-busy={props.starting !== null}>
        <PageSlot shown={page === "overview"}>
          <PracticeOverview
            progress={props.progress}
            motifs={props.motifs}
            engineMissing={props.engineMissing}
            startButton={startButton}
            problems={props.problems}
            failure={failureOn("overview")}
            themesRef={themes}
            now={now}
            foundPanel={
              found ? (
                <FoundOverviewPanel
                  found={found.positions}
                  starting={foundStarting}
                  busy={busy}
                  onStart={found.onStart}
                  onSeeAll={() => onChoose("from-my-games")}
                  now={now}
                />
              ) : undefined
            }
          />
        </PageSlot>
        <PageSlot shown={page === "from-my-games"}>
          {found ? (
            <PracticeFound
              shown={page === "from-my-games"}
              whole={found.positions}
              fetchFound={found.fetchPositions ?? fetchFoundPositionsFromServer}
              starting={foundStarting}
              busy={busy}
              onStart={found.onStart}
              failure={failureOn("from-my-games")}
              now={now}
              createBoard={found.createBoard}
            />
          ) : (
            <PracticePageHead title={PRACTICE_ENTRY_LABEL["from-my-games"]} />
          )}
        </PageSlot>
        <PageSlot shown={page === "openings"}>
          <OpeningsPage
            hub={marked}
            startButton={startButton}
            fetchList={openingsDue.fetchList}
            failure={failureOn("openings")}
          />
        </PageSlot>
        {(["improvement-areas", "strengths"] as const).map((kind) => (
          <PageSlot key={kind} shown={page === kind}>
            <PracticeThemeStats
              kind={kind}
              shown={page === kind}
              fetchThemeStats={marked.fetchThemeStats}
              starting={marked.starting}
              engineMissing={marked.engineMissing}
              onStart={marked.onStart}
              failure={failureOn(kind)}
            />
          </PageSlot>
        ))}
        <UnbuiltPages page={page} />
      </div>
    </div>
  );
}
