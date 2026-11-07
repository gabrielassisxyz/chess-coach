import type { ActivityState, DemoActivity, TrainingMode } from "@chess-coach/shared";
import { useEffect, useRef, useState } from "react";
import { Board, type BoardFactory } from "../components/Board.js";
import { BoardSettingsPanel } from "../components/BoardSettings.js";
import { CoachLoginCard } from "../components/CoachLoginCard.js";
import { EngineMissingCard } from "../components/EngineMissingCard.js";
import { PracticeColumn, type PracticeColumnActions } from "../components/PracticeColumn.js";
import { PracticeHub, ResumeCard } from "../components/PracticeHub.js";
import { PuzzleBoardBar } from "../components/PuzzleBoardBar.js";
import { useElapsed } from "../hooks/useElapsed.js";
import { type FetchHealth, useHealth } from "../hooks/useHealth.js";
import { useLoaded } from "../hooks/useLoaded.js";
import { usePracticeBoard } from "../hooks/usePracticeBoard.js";
import type { ServerApi } from "../hooks/useServer.js";
import { useBoardTheme } from "../state/board-theme.js";
import { coachErrorHint, isCoachAuthError } from "../state/coach-hint.js";
import { serviceNotice } from "../state/health.js";
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
  trainingOf,
  trainingView,
} from "../state/practice.js";
import { stateCardOf } from "../state/practice-item.js";
import { type FetchProgress, fetchProgressFromServer } from "../state/progress-api.js";

export interface PracticeProps {
  server: ServerApi;
  createBoard?: BoardFactory | undefined;
  fetchMotifs?: FetchMotifs;
  fetchProgress?: FetchProgress;
  fetchHealth?: FetchHealth | undefined;
}

const ANY_MOTIF = "";

interface Starting {
  mode: TrainingMode;
  motif: string;
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
        startFailureText(starting.mode, starting.motif, server.lastErrorCode, server.lastError),
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
  return { starting, failure, begin };
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
  fetchHealth,
  lastSession,
}: Required<Pick<PracticeProps, "server" | "fetchMotifs" | "fetchProgress">> &
  Pick<PracticeProps, "fetchHealth"> & { lastSession: LastSession | null }) {
  const motifs = useLoaded(fetchMotifs);
  const progress = useLoaded(fetchProgress);
  const [size, setSize] = useState<DrillSize>(DEFAULT_DRILL_SIZE);
  const [retries, setRetries] = useState(0);
  const notice = serviceNotice(useHealth(retries, fetchHealth ? { fetchHealth } : {}));
  const login = useCoachLogin(server);
  const { starting, failure, begin } = useStartOutcome(server, size);
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
        engineMissing={engineMissing}
        starting={starting}
        failure={failure}
        size={size}
        onSize={setSize}
        onStart={begin}
        lastSession={lastSession}
      />
    </div>
  );
}

function demoOverTraining(activity: ActivityState | null): DemoActivity | null {
  if (activity?.kind === "demo" && activity.returns_to === "training") return activity;
  return null;
}

// The puzzle column beside the board, the board with its bar, and the settings under it.
function Item({
  server,
  createBoard,
}: {
  server: ServerApi;
  createBoard: BoardFactory | undefined;
}) {
  const training = trainingOf(server.activity) as NonNullable<ReturnType<typeof trainingOf>>;
  const view = trainingView(training);
  const board = usePracticeBoard(training, server.send);
  const elapsedMs = useElapsed(training.served_at, view.open);
  const theme = useBoardTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const activityId = training.activity_id;
  const exposureId = training.exposure_id;
  const card = stateCardOf(training, view, board.scratchLine, elapsedMs);
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
      />
      <div className="stage">
        <div className="puzzle-stage">
          <Board
            activity={board.activity}
            onMove={board.move}
            syncToken={server.errorCount}
            bothSides={board.bothSides}
            hintSquare={board.hintSquare}
            line={board.line}
            orientation={board.orientation}
            badge={board.badge}
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
            <BoardSettingsPanel
              theme={theme.theme}
              onChoose={theme.choose}
              onClose={() => setSettingsOpen(false)}
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
    setLastSession((prev) => {
      if (prev && prev.solved === summary.solved && prev.failed === summary.failed) return prev;
      saveLastSession(summary);
      return { solved: summary.solved, failed: summary.failed };
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
          fetchHealth={fetchHealth}
          lastSession={lastSession}
        />
      </section>
    );
  }

  return <Item server={server} createBoard={createBoard} />;
}
