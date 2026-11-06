import type {
  ActivityState,
  DemoActivity,
  PromotionPiece,
  TrainingMode,
} from "@chess-coach/shared";
import { useEffect, useRef, useState } from "react";
import { Board, type BoardFactory } from "../components/Board.js";
import { CoachLoginCard } from "../components/CoachLoginCard.js";
import { EngineMissingCard } from "../components/EngineMissingCard.js";
import { PracticeHub, ResumeCard } from "../components/PracticeHub.js";
import { PracticeItem, type PracticeItemActions } from "../components/PracticeItem.js";
import { type FetchHealth, useHealth } from "../hooks/useHealth.js";
import { useLoaded } from "../hooks/useLoaded.js";
import type { ServerApi } from "../hooks/useServer.js";
import { coachErrorHint, isCoachAuthError } from "../state/coach-hint.js";
import { serviceNotice } from "../state/health.js";
import {
  answerUciOf,
  boardOf,
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

  const training = trainingOf(server.activity);
  if (!training) {
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

  const view = trainingView(training);
  const activityId = training.activity_id;
  const explore = (kind: "undo" | "reset"): void => {
    server.send({ type: "explore", kind, activity_id: activityId });
  };
  const move = (from: string, to: string, promotion?: PromotionPiece): void => {
    server.send({
      type: "explore",
      kind: "move",
      uci: `${from}${to}${promotion ?? ""}`,
      activity_id: activityId,
    });
  };
  const answerUci = answerUciOf(training);
  const exposureId = training.exposure_id;
  const actions: PracticeItemActions = {
    answer: () => {
      if (answerUci) server.send({ type: "answer", uci: answerUci, activity_id: activityId });
    },
    takeBack: () => explore("undo"),
    reset: () => explore("reset"),
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
  };

  return (
    <>
      <PracticeItem training={training} view={view} actions={actions} />
      <div className="stage">
        <Board
          activity={boardOf(training)}
          bothSides
          onMove={move}
          syncToken={server.errorCount}
          createBoard={createBoard}
        />
      </div>
    </>
  );
}
