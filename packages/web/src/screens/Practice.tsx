import type {
  ActivityState,
  DemoActivity,
  OpeningDrillColor,
  RepertoireLevel,
  RepertoireScope,
  TrainingActivity,
  TrainingMode,
} from "@chess-coach/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Board, type BoardFactory } from "../components/Board.js";
import { BoardDisplayPopover } from "../components/BoardDisplayPopover.js";
import { CoachLoginCard } from "../components/CoachLoginCard.js";
import { EngineMissingCard } from "../components/EngineMissingCard.js";
import { EngineStrip } from "../components/EngineStrip.js";
import { PracticeColumn, type PracticeColumnActions } from "../components/PracticeColumn.js";
import { PracticeHub, ResumeCard } from "../components/PracticeHub.js";
import { PuzzleBoardBar } from "../components/PuzzleBoardBar.js";
import { useElapsed } from "../hooks/useElapsed.js";
import { useEngineAnalysis } from "../hooks/useEngineAnalysis.js";
import { type FetchHealth, useHealth } from "../hooks/useHealth.js";
import { useLoaded } from "../hooks/useLoaded.js";
import { usePracticeBoard } from "../hooks/usePracticeBoard.js";
import type { ServerApi } from "../hooks/useServer.js";
import { useBoardPrefs } from "../state/board-prefs.js";
import { useBoardTheme } from "../state/board-theme.js";
import { coachErrorHint, isCoachAuthError } from "../state/coach-hint.js";
import { serviceNotice } from "../state/health.js";
import { type FetchOpeningDrills, fetchOpeningDrillsFromServer } from "../state/openings-api.js";
import {
  clearLastSession,
  DEFAULT_DRILL_SIZE,
  type DrillSize,
  type FetchMotifs,
  fetchMotifsFromServer,
  type LastSession,
  loadLastSession,
  OFFLINE_START_TEXT,
  saveLastSession,
  startFailureText,
  type TrainingView,
  trainingOf,
  trainingView,
} from "../state/practice.js";
import { stateCardOf } from "../state/practice-item.js";
import { type FetchProgress, fetchProgressFromServer } from "../state/progress-api.js";
import { repertoireCardOf } from "../state/repertoire-drill.js";
import {
  type FetchRepertoireList,
  type FetchRepertoires,
  fetchRepertoiresFromServer,
} from "../state/repertoires-api.js";

export interface PracticeProps {
  server: ServerApi;
  createBoard?: BoardFactory | undefined;
  fetchMotifs?: FetchMotifs;
  fetchProgress?: FetchProgress;
  fetchRepertoires?: FetchRepertoires;
  // The whole repertoire answer the openings menu reads its levels and branch points from; the
  // server's by default.
  fetchRepertoireList?: FetchRepertoireList | undefined;
  // The drills from the student's games, grouped by opening family; the server's by default.
  fetchOpeningDrills?: FetchOpeningDrills;
  fetchHealth?: FetchHealth | undefined;
}

const ANY_MOTIF = "";

// The opening a drill named is gone from the list the page holds, which only a reload refreshes.
const UNKNOWN_OPENING_TEXT =
  "That opening has no positions to drill any more. Reload the page to see the current list.";

interface Starting {
  mode: TrainingMode;
  // A repertoire start puts its scope here, where a puzzle start puts its motif, and an opening
  // drill its colour.
  motif: string;
  repertoireId?: number;
  level?: RepertoireLevel;
  opening?: string;
  errorsBefore: number;
}

// A start has no reply of its own: success is the activity arriving, refusal is an error event,
// and a dropped socket ends the wait because the answer can no longer come.
function useStartOutcome(server: ServerApi, size: DrillSize) {
  const [starting, setStarting] = useState<Starting | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!starting) return;
    if (server.connection !== "connected") {
      setStarting(null);
      setFailure(OFFLINE_START_TEXT);
    } else if (server.errorCount > starting.errorsBefore) {
      setStarting(null);
      setFailure(
        server.lastErrorCode === "unknown_opening"
          ? UNKNOWN_OPENING_TEXT
          : startFailureText(starting.mode, starting.motif, server.lastErrorCode, server.lastError),
      );
    }
  }, [starting, server.connection, server.errorCount, server.lastErrorCode, server.lastError]);

  const begin = (mode: TrainingMode, motif: string): void => {
    setFailure(null);
    const command =
      mode === "srs"
        ? { mode }
        : mode === "openings"
          ? { mode, color: motif as "white" | "black" }
          : { mode, ...(motif === ANY_MOTIF ? {} : { motif }) };
    if (server.send({ type: "start_training", ...command, size })) {
      setStarting({ mode, motif, errorsBefore: server.errorCount });
    } else {
      setFailure(OFFLINE_START_TEXT);
    }
  };
  // An opening drill of one family serves at the chosen size like any other queue of puzzles.
  const beginOpening = (color: OpeningDrillColor, opening: string): void => {
    setFailure(null);
    if (server.send({ type: "start_training", mode: "openings", color, opening, size })) {
      setStarting({ mode: "openings", motif: color, opening, errorsBefore: server.errorCount });
    } else {
      setFailure(OFFLINE_START_TEXT);
    }
  };
  // The scope of a line drill decides what it serves, so no drill size goes with it. A drill of
  // one variation names no level, as before levels existed; a group or a side names its own.
  const beginRepertoire = (
    repertoireId: number,
    scope: RepertoireScope,
    level?: RepertoireLevel,
  ): void => {
    setFailure(null);
    const widened = level === undefined || level === "variation" ? {} : { level };
    const sent = server.send({
      type: "start_training",
      mode: "repertoire",
      repertoire_id: repertoireId,
      scope,
      ...widened,
    });
    if (sent) {
      setStarting({
        mode: "repertoire",
        motif: scope,
        repertoireId,
        ...widened,
        errorsBefore: server.errorCount,
      });
    } else {
      setFailure(OFFLINE_START_TEXT);
    }
  };
  return { starting, failure, begin, beginRepertoire, beginOpening };
}

// The login card clears once the student has checked again, and returns on the next auth failure.
function useCoachLogin(server: ServerApi): { fix: string; checkAgain(): void } | null {
  const [seen, setSeen] = useState<string | null>(null);
  const last = server.items.findLast((item) => item.type === "turn_error" || item.type === "text");
  if (last?.type !== "turn_error" || !isCoachAuthError(last.message) || last.key === seen) {
    return null;
  }
  const key = last.key;
  return { fix: coachErrorHint(last.message) ?? "", checkAgain: () => setSeen(key) };
}

function Hub({
  server,
  fetchMotifs,
  fetchProgress,
  fetchRepertoires,
  fetchRepertoireList,
  fetchOpeningDrills,
  fetchHealth,
  lastSession,
}: Required<Pick<PracticeProps, "server" | "fetchMotifs" | "fetchProgress" | "fetchRepertoires">> &
  Required<Pick<PracticeProps, "fetchOpeningDrills">> &
  Pick<PracticeProps, "fetchHealth" | "fetchRepertoireList"> & {
    lastSession: LastSession | null;
  }) {
  const motifs = useLoaded(fetchMotifs);
  const progress = useLoaded(fetchProgress);
  const repertoires = useLoaded(fetchRepertoires);
  const openingDrills = useLoaded(fetchOpeningDrills);
  const [size, setSize] = useState<DrillSize>(DEFAULT_DRILL_SIZE);
  const [retries, setRetries] = useState(0);
  const notice = serviceNotice(useHealth(retries, fetchHealth ? { fetchHealth } : {}));
  const login = useCoachLogin(server);
  const { starting, failure, begin, beginRepertoire, beginOpening } = useStartOutcome(server, size);
  const engineMissing = notice?.reason === "stockfish_missing";

  return (
    <div className="practice__chooser">
      <h2 className="screen__title">Practice</h2>
      <p className="screen__note">Pick a session. The board appears once an item starts.</p>
      {notice && engineMissing ? (
        <EngineMissingCard notice={notice} onRetry={() => setRetries((count) => count + 1)} />
      ) : null}
      {login ? <CoachLoginCard fix={login.fix} onCheckAgain={login.checkAgain} /> : null}
      {server.pausedTraining ? (
        <ResumeCard
          paused={server.pausedTraining}
          engineMissing={engineMissing}
          onResume={() => server.send({ type: "resume_training" })}
          onDiscard={() => server.send({ type: "discard_training" })}
        />
      ) : null}
      <PracticeHub
        progress={progress}
        motifs={motifs}
        repertoires={repertoires}
        engineMissing={engineMissing}
        starting={starting}
        failure={failure}
        size={size}
        onSize={setSize}
        onStart={begin}
        onStartRepertoire={beginRepertoire}
        openingDrills={openingDrills}
        onStartOpening={beginOpening}
        lastSession={lastSession}
        fetchRepertoireList={fetchRepertoireList}
      />
    </div>
  );
}

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

const INTERACTIVE =
  "button, a, input, select, textarea, [role=button], [role=switch], [role=radio]";

// h asks for a hint while the item is open; space continues once it ended. The arrows and f
// live with the board state, which owns stepping and the orientation.
function useItemShortcuts(view: TrainingView, actions: PracticeColumnActions): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target)) return;
      if (event.key === "h" && view.open) {
        event.preventDefault();
        actions.hint();
      } else if (event.key === " " && !view.open && view.canAdvance && !view.summary) {
        // Space on a focused control activates that control; only a bare space continues.
        if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
        event.preventDefault();
        actions.next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.open, view.canAdvance, view.summary, actions]);
}

// With the setting on, a puzzle that ended moves on by itself once its mark has settled. A card
// waits for its rating, so it never auto-advances; neither does an item the student is still
// looking at (analysing, stepping back, or with the engine on).
export const AUTO_NEXT_MS = 1200;
function useAutoNext(
  training: TrainingActivity,
  view: TrainingView,
  enabled: boolean,
  hold: boolean,
  next: () => void,
): void {
  const key = `${training.served_at}:${training.item.position_in_queue}:${training.status}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the ended item
  useEffect(() => {
    if (
      !enabled ||
      hold ||
      view.open ||
      view.summary ||
      training.item.kind === "card" ||
      !view.canAdvance
    ) {
      return;
    }
    const timer = setTimeout(next, AUTO_NEXT_MS);
    return () => clearTimeout(timer);
  }, [key, enabled, hold]);
}

function demoOverTraining(activity: ActivityState | null): DemoActivity | null {
  if (activity?.kind === "demo" && activity.returns_to === "training") return activity;
  return null;
}

// The puzzle column beside the board, the board with its bar, and the settings under it.
function Item({
  server,
  createBoard,
  fetchRepertoires,
}: {
  server: ServerApi;
  createBoard: BoardFactory | undefined;
  fetchRepertoires: FetchRepertoires;
}) {
  const training = trainingOf(server.activity) as NonNullable<ReturnType<typeof trainingOf>>;
  const view = trainingView(training);
  const board = usePracticeBoard(training, server.send);
  const elapsedMs = useElapsed(training.served_at, view.open);
  const theme = useBoardTheme();
  const { prefs, set: setPrefs } = useBoardPrefs();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const [engineOpen, setEngineOpen] = useState(false);
  const closeEngine = useCallback(() => setEngineOpen(false), []);
  const engine = useEngineAnalysis(training, view, board.activity.fen, server);
  const activityId = training.activity_id;
  const exposureId = training.exposure_id;
  const drill = training.repertoire ?? null;
  const card =
    drill && board.scratchLine === null
      ? repertoireCardOf(training, drill, view)
      : stateCardOf(training, view, board.scratchLine, elapsedMs);
  const actions: PracticeColumnActions = {
    showSolution: () => server.send({ type: "show_solution", activity_id: activityId }),
    rate: (quality) => {
      if (exposureId) {
        server.send({
          type: "rate_card",
          exposure_id: exposureId,
          quality,
          activity_id: activityId,
        });
      }
    },
    next: () => server.send({ type: "next_training_item", activity_id: activityId }),
    end: () => server.send({ type: "end_training", activity_id: activityId }),
    hint: () => server.send({ type: "hint", activity_id: activityId }),
    toggleScratch: board.toggleScratch,
    takeBack: board.takeBack,
    resetLine: board.resetLine,
  };
  useItemShortcuts(view, actions);
  const busyWithItem = board.scratchLine !== null || board.shownPly < board.tip || engine.on;
  useAutoNext(training, view, prefs.autoNext, busyWithItem, actions.next);
  // The engine's arrows and the arrow of the move a repertoire drill shows, drawn together.
  const shapes = useMemo(
    () =>
      board.answerShapes.length === 0 ? engine.shapes : [...engine.shapes, ...board.answerShapes],
    [engine.shapes, board.answerShapes],
  );

  return (
    <>
      <PracticeColumn
        training={training}
        view={view}
        actions={actions}
        card={card}
        elapsedMs={elapsedMs}
        scratchLine={board.scratchLine}
        shownPly={board.shownPly}
        fetchRepertoires={fetchRepertoires}
        engineStrip={
          <EngineStrip
            engine={engine}
            settingsOpen={engineOpen}
            onToggleSettings={() => setEngineOpen((open) => !open)}
            onCloseSettings={closeEngine}
          />
        }
      />
      <div className="stage">
        {/* The server refuses free moves on an open line drill, so the bar hides its Explore button. */}
        <div className="puzzle-stage" data-drill={drill && view.open ? "open" : undefined}>
          <Board
            activity={board.activity}
            onMove={board.move}
            syncToken={server.errorCount}
            bothSides={board.bothSides}
            hintSquare={board.hintSquare}
            line={board.line}
            orientation={board.orientation}
            badge={board.badge}
            prefs={prefs}
            shapes={shapes}
            createBoard={createBoard}
          />
          <PuzzleBoardBar
            atStart={board.shownPly === 0}
            atEnd={board.shownPly >= board.tip}
            onFirst={() => board.step(0)}
            onPrevious={() => board.step(board.shownPly - 1)}
            onNext={() => board.step(board.shownPly + 1)}
            onLast={() => board.step(board.tip)}
            scratch={board.scratchLine !== null}
            onToggleScratch={board.toggleScratch}
            onFlip={board.flip}
            settingsOpen={settingsOpen}
            onToggleSettings={() => setSettingsOpen((open) => !open)}
          />
          {settingsOpen ? (
            <BoardDisplayPopover
              theme={theme.theme}
              onTheme={theme.choose}
              prefs={prefs}
              onPrefs={setPrefs}
              onClose={closeSettings}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

export function Practice({
  server,
  createBoard,
  fetchMotifs = fetchMotifsFromServer,
  fetchProgress = fetchProgressFromServer,
  fetchRepertoires = fetchRepertoiresFromServer,
  fetchRepertoireList,
  fetchOpeningDrills = fetchOpeningDrillsFromServer,
  fetchHealth,
}: PracticeProps) {
  const sessionTraining = trainingOf(server.activity);
  const [lastSession, setLastSession] = useState<LastSession | null>(() => loadLastSession());
  const send = server.send;
  const summary = sessionTraining?.summary ?? null;
  const summaryActivityId = sessionTraining?.activity_id ?? null;
  const endedFor = useRef<number | null>(null);
  // A finished queue lands on the hub: keep the tally, then end the run.
  useEffect(() => {
    if (!sessionTraining || !summary || summaryActivityId === null) return;
    const unit: LastSession["unit"] = sessionTraining.repertoire ? "moves" : undefined;
    setLastSession((prev) => {
      const same = prev?.solved === summary.solved && prev.failed === summary.failed;
      if (prev && same && prev.unit === unit) return prev;
      const next: LastSession = { solved: summary.solved, failed: summary.failed, unit };
      saveLastSession(next);
      return next;
    });
    if (endedFor.current !== summaryActivityId) {
      endedFor.current = summaryActivityId;
      send({ type: "end_training", activity_id: summaryActivityId });
    }
  }, [sessionTraining, summary, summaryActivityId, send]);
  // A fresh session replaces the line until it finishes.
  useEffect(() => {
    if (sessionTraining && sessionTraining.summary === null) {
      endedFor.current = null;
      setLastSession((prev) => {
        if (prev === null) return prev;
        clearLastSession();
        return null;
      });
    }
  }, [sessionTraining]);

  const demo = demoOverTraining(server.activity);
  if (demo) {
    const activityId = demo.activity_id;
    return (
      <>
        <section className="screen practice" aria-label="Practice">
          <h2 className="screen__title practice__crumb">Practice · Coach demo</h2>
          <p className="screen__note">The coach is showing a position from your session.</p>
          <div className="controls__row">
            <button
              type="button"
              className="button button--primary"
              onClick={() => server.send({ type: "leave_demo", activity_id: activityId })}
            >
              Back to session
            </button>
          </div>
        </section>
        <div className="stage">
          <Board
            activity={demo}
            onMove={() => undefined}
            syncToken={server.errorCount}
            createBoard={createBoard}
          />
        </div>
      </>
    );
  }

  if (!sessionTraining) {
    return (
      <section className="screen screen--wide practice" aria-label="Practice">
        <Hub
          server={server}
          fetchMotifs={fetchMotifs}
          fetchProgress={fetchProgress}
          fetchRepertoires={fetchRepertoires}
          fetchRepertoireList={fetchRepertoireList}
          fetchOpeningDrills={fetchOpeningDrills}
          fetchHealth={fetchHealth}
          lastSession={lastSession}
        />
      </section>
    );
  }

  return <Item server={server} createBoard={createBoard} fetchRepertoires={fetchRepertoires} />;
}
