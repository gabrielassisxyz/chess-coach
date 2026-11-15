import type {
  ProgressResponse,
  PuzzleRatingHistoryResponse,
  RepertoireLevel,
  RepertoireScope,
  ThemeStatsResponse,
  TrainingMode,
} from "@chess-coach/shared";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { Loaded } from "../hooks/useLoaded.js";
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
import { PracticeNav } from "./PracticeNav.js";
import { PracticeOpenings } from "./PracticeOpenings.js";
import { type HubStartButton, PracticeOverview, PracticePageHead } from "./PracticeOverview.js";
import { PracticeThemeStats } from "./PracticeThemeStats.js";

export interface PracticeHubProps {
  progress: Loaded<ProgressResponse>;
  engineMissing: boolean;
  // A repertoire start carries its scope in `motif`, names its repertoire and, above one
  // variation, its level.
  starting: {
    mode: TrainingMode;
    motif: string;
    repertoireId?: number;
    level?: RepertoireLevel | undefined;
  } | null;
  failure: string | null;
  onStart(mode: TrainingMode, motif: string): void;
  onStartRepertoire(repertoireId: number, scope: RepertoireScope, level?: RepertoireLevel): void;
  now?: Date;
  // The answer the Openings page and the count beside its entry read, and the call that builds a
  // drill for an opening met in games; the server's by default.
  fetchRepertoireList?: FetchRepertoireList | undefined;
  addOpening?: AddOpening | undefined;
  // What builds a variation at a branch point; the server's by default.
  addVariation?: AddVariation | undefined;
  // Where a variation's coverage comes from when it is opened; the server's by default.
  fetchCoverage?: FetchCoverage | undefined;
  // Where ranked puzzle theme stats come from when a Stats theme page opens; the server's by default.
  fetchThemeStats?: FetchThemeStats | undefined;
  // Optional 7-day rating history and 30-day theme statistics displayed on the Overview tiles.
  ratingHistory?: Loaded<PuzzleRatingHistoryResponse> | undefined;
  overviewThemeStats?: Loaded<ThemeStatsResponse> | undefined;
  // The engine and coach problem cards, which the Overview draws under its title.
  problems?: ReactNode;
}

// The Openings entry counts from the answers the Openings page reads, so the number follows the
// page's retries and the drills it adds, and the count asks the server nothing of its own.
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

// The student's stored lines on a page of their own; the hub's starts arrive already marked with this page.
function OpeningsPage({
  hub,
  fetchList,
  failure,
}: {
  hub: PracticeHubProps;
  fetchList: FetchRepertoireList;
  failure: ReactNode;
}) {
  const { starting } = hub;
  return (
    <>
      <PracticeOpenings
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
      />
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
  const { failure } = props;
  const marked: PracticeHubProps = {
    ...props,
    onStart: pressedHere(props.onStart),
    onStartRepertoire: pressedHere(props.onStartRepertoire),
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

  return (
    <div className="practice-hub" ref={hub}>
      <PracticeNav current={entry} onChoose={onChoose} openingsDue={openingsDue.due} />
      <div className="practice-hub__pages" aria-busy={props.starting !== null}>
        <PageSlot shown={page === "overview"}>
          <PracticeOverview
            progress={props.progress}
            ratingHistory={props.ratingHistory}
            themeStats={props.overviewThemeStats}
            engineMissing={props.engineMissing}
            startButton={startButton}
            starting={marked.starting}
            onStart={marked.onStart}
            problems={props.problems}
            failure={failureOn("overview")}
            themesRef={themes}
            now={props.now ?? new Date()}
          />
        </PageSlot>
        <PageSlot shown={page === "openings"}>
          <OpeningsPage
            hub={marked}
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
