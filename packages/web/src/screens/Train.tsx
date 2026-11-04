import type { PromotionPiece, TrainingMode } from "@chess-coach/shared";
import { useEffect, useState } from "react";
import { Board, type BoardFactory } from "../components/Board.js";
import type { ServerApi } from "../hooks/useServer.js";
import {
  type FetchMotifs,
  fetchMotifsFromServer,
  type MotifCount,
  OFFLINE_START_TEXT,
  startFailureText,
  trainingOf,
  trainingView,
} from "../state/train.js";

export interface TrainProps {
  server: ServerApi;
  createBoard?: BoardFactory | undefined;
  fetchMotifs?: FetchMotifs;
}

const QUALITIES = [0, 1, 2, 3, 4, 5] as const;
const ANY_MOTIF = "";

type Motifs =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; list: MotifCount[] };

function useMotifs(fetchMotifs: FetchMotifs): Motifs {
  const [motifs, setMotifs] = useState<Motifs>({ status: "loading" });
  useEffect(() => {
    let live = true;
    fetchMotifs().then(
      (list) => live && setMotifs({ status: "ready", list }),
      () => live && setMotifs({ status: "failed" }),
    );
    return () => {
      live = false;
    };
  }, [fetchMotifs]);
  return motifs;
}

interface Starting {
  mode: TrainingMode;
  motif: string;
  errorsBefore: number;
}

// A start has no reply of its own: success is the activity arriving, refusal is an error event,
// and a dropped socket ends the wait because the answer can no longer come.
function useStartOutcome(server: ServerApi) {
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
    const command = mode === "srs" ? { mode } : { mode, ...(motif === ANY_MOTIF ? {} : { motif }) };
    if (server.send({ type: "start_training", ...command })) {
      setStarting({ mode, motif, errorsBefore: server.errorCount });
    } else {
      setFailure(OFFLINE_START_TEXT);
    }
  };
  return { starting, failure, begin };
}

function motifNote(motifs: Motifs): string | null {
  if (motifs.status === "loading") return "Loading motifs.";
  if (motifs.status === "failed") {
    return "The motif list could not be loaded. You can still drill with Any motif.";
  }
  return motifs.list.length === 0
    ? "No puzzles are loaded. Restart the server to load the puzzle library."
    : null;
}

function ModeChooser({ server, fetchMotifs }: { server: ServerApi; fetchMotifs: FetchMotifs }) {
  const motifs = useMotifs(fetchMotifs);
  const [motif, setMotif] = useState(ANY_MOTIF);
  const { starting, failure, begin } = useStartOutcome(server);
  const busy = starting !== null;
  const list = motifs.status === "ready" ? motifs.list : [];
  const note = motifNote(motifs);
  const label = (mode: TrainingMode, idle: string): string =>
    starting?.mode === mode ? "Starting" : idle;

  return (
    <div className="train__chooser" aria-busy={busy}>
      <h2 className="train__title">Train</h2>
      <section className="train__mode" aria-label="Review due cards">
        <p>Answer the cards that are due, then rate how well you knew each one.</p>
        <button
          type="button"
          className="button button--primary"
          disabled={busy}
          onClick={() => begin("srs", ANY_MOTIF)}
        >
          {label("srs", "Review due cards")}
        </button>
      </section>
      <section className="train__mode" aria-label="Drill puzzles">
        <label className="train__field">
          Motif
          <select
            value={motif}
            disabled={busy || motifs.status === "loading"}
            onChange={(event) => setMotif(event.target.value)}
          >
            <option value={ANY_MOTIF}>Any motif</option>
            {list.map((entry) => (
              <option key={entry.motif} value={entry.motif}>
                {entry.motif} ({entry.count})
              </option>
            ))}
          </select>
        </label>
        {note ? <p role="status">{note}</p> : null}
        <button
          type="button"
          className="button button--primary"
          disabled={busy}
          onClick={() => begin("puzzles", motif)}
        >
          {label("puzzles", "Drill puzzles")}
        </button>
      </section>
      {failure ? (
        <p className="train__failure" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

export function Train({ server, createBoard, fetchMotifs = fetchMotifsFromServer }: TrainProps) {
  const training = trainingOf(server.activity);
  if (!training) {
    return (
      <section className="train" aria-label="Train">
        <ModeChooser server={server} fetchMotifs={fetchMotifs} />
      </section>
    );
  }

  const view = trainingView(training);
  const activityId = training.activity_id;
  const move = (from: string, to: string, promotion?: PromotionPiece): void => {
    server.send({ type: "move", from, to, promotion, activity_id: activityId });
  };
  const exposureId = training.exposure_id;

  return (
    <section className="train" aria-label="Train">
      <header className="train__header">
        <h2 className="train__title">{view.header}</h2>
        <p className="train__status" role="status">
          {view.status}
          {view.expected ? (
            <span className="train__expected"> Expected {view.expected}</span>
          ) : null}
        </p>
      </header>
      <Board
        activity={training}
        onMove={move}
        syncToken={server.errorCount}
        createBoard={createBoard}
      />
      {view.summary ? (
        <p className="train__summary" data-testid="summary">
          Queue finished: {view.summary.solved} solved, {view.summary.failed} failed.
        </p>
      ) : null}
      {view.canRate && exposureId ? (
        <fieldset className="train__rating" aria-label="Rate your recall">
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
  );
}
