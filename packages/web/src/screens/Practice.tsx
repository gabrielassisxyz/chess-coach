import type { PromotionPiece, TrainingMode } from "@chess-coach/shared";
import { useEffect, useState } from "react";
import { Board, type BoardFactory } from "../components/Board.js";
import { CoachLoginCard } from "../components/CoachLoginCard.js";
import { EngineMissingCard } from "../components/EngineMissingCard.js";
import { PracticeHub } from "../components/PracticeHub.js";
import { type FetchHealth, useHealth } from "../hooks/useHealth.js";
import { useLoaded } from "../hooks/useLoaded.js";
import type { ServerApi } from "../hooks/useServer.js";
import { coachErrorHint, isCoachAuthError } from "../state/coach-hint.js";
import { serviceNotice } from "../state/health.js";
import {
  answerUciOf,
  boardOf,
  DEFAULT_DRILL_SIZE,
  type DrillSize,
  type FetchMotifs,
  fetchMotifsFromServer,
  OFFLINE_START_TEXT,
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

const QUALITIES = [0, 1, 2, 3, 4, 5] as const;
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
}: Required<Pick<PracticeProps, "server" | "fetchMotifs" | "fetchProgress">> &
  Pick<PracticeProps, "fetchHealth">) {
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
      <PracticeHub
        progress={progress}
        motifs={motifs}
        engineMissing={engineMissing}
        starting={starting}
        failure={failure}
        size={size}
        onSize={setSize}
        onStart={begin}
      />
    </div>
  );
}

export function Practice({
  server,
  createBoard,
  fetchMotifs = fetchMotifsFromServer,
  fetchProgress = fetchProgressFromServer,
  fetchHealth,
}: PracticeProps) {
  const training = trainingOf(server.activity);
  if (!training) {
    return (
      <section className="screen screen--wide practice" aria-label="Practice">
        <Hub
          server={server}
          fetchMotifs={fetchMotifs}
          fetchProgress={fetchProgress}
          fetchHealth={fetchHealth}
        />
      </section>
    );
  }

  const view = trainingView(training);
  const activityId = training.activity_id;
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

  return (
    <>
      <section className="screen practice" aria-label="Practice">
        <header className="practice__header">
          <h2 className="screen__title practice__title">{view.header}</h2>
          <p className="screen__note" role="status">
            {view.status}
            {view.expected ? (
              <span className="practice__expected"> Expected {view.expected}</span>
            ) : null}
          </p>
        </header>
        {view.summary ? (
          <p className="practice__summary" data-testid="summary">
            Queue finished: {view.summary.solved} solved, {view.summary.failed} failed.
          </p>
        ) : null}
        {view.canRate && exposureId ? (
          <fieldset className="practice__rating" aria-label="Rate your recall">
            {QUALITIES.map((quality) => (
              <button
                key={quality}
                type="button"
                className="button"
                aria-label={`Rate ${quality}`}
                onClick={() =>
                  server.send({
                    type: "rate_card",
                    exposure_id: exposureId,
                    quality,
                    activity_id: activityId,
                  })
                }
              >
                {quality}
              </button>
            ))}
          </fieldset>
        ) : null}
        {view.canExplore ? (
          <div className="controls__row">
            <button
              type="button"
              className="button button--primary"
              disabled={!view.canAnswer || answerUci === null}
              onClick={() =>
                answerUci &&
                server.send({ type: "answer", uci: answerUci, activity_id: activityId })
              }
            >
              Answer
            </button>
            <button
              type="button"
              className="button"
              disabled={!view.canAnswer}
              onClick={() =>
                server.send({ type: "explore", kind: "undo", activity_id: activityId })
              }
            >
              Take back
            </button>
            <button
              type="button"
              className="button"
              disabled={!view.canAnswer}
              onClick={() =>
                server.send({ type: "explore", kind: "reset", activity_id: activityId })
              }
            >
              Reset
            </button>
          </div>
        ) : null}
        <div className="controls__row">
          {view.summary ? null : (
            <button
              type="button"
              className="button button--primary"
              disabled={!view.canAdvance}
              onClick={() => server.send({ type: "next_training_item", activity_id: activityId })}
            >
              {view.advanceLabel}
            </button>
          )}
          <button
            type="button"
            className="button"
            onClick={() => server.send({ type: "end_training", activity_id: activityId })}
          >
            {view.summary ? "Done" : "End training"}
          </button>
        </div>
      </section>
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
