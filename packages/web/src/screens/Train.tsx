import type { PromotionPiece } from "@chess-coach/shared";
import { useEffect, useState } from "react";
import { Board, type BoardFactory } from "../components/Board.js";
import type { ServerApi } from "../hooks/useServer.js";
import {
  type FetchMotifs,
  fetchMotifsFromServer,
  type MotifCount,
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

function ModeChooser({ server, fetchMotifs }: { server: ServerApi; fetchMotifs: FetchMotifs }) {
  const [motifs, setMotifs] = useState<MotifCount[]>([]);
  const [motif, setMotif] = useState(ANY_MOTIF);

  useEffect(() => {
    let live = true;
    fetchMotifs().then(
      (found) => live && setMotifs(found),
      () => live && setMotifs([]),
    );
    return () => {
      live = false;
    };
  }, [fetchMotifs]);

  const drill = (): void => {
    server.send({
      type: "start_training",
      mode: "puzzles",
      ...(motif === ANY_MOTIF ? {} : { motif }),
    });
  };

  return (
    <div className="train__chooser">
      <h2 className="train__title">Train</h2>
      <section className="train__mode" aria-label="Review due cards">
        <p>Answer the cards that are due, then rate how well you knew each one.</p>
        <button
          type="button"
          className="button button--primary"
          onClick={() => server.send({ type: "start_training", mode: "srs" })}
        >
          Review due cards
        </button>
      </section>
      <section className="train__mode" aria-label="Drill puzzles">
        <label className="train__field">
          Motif
          <select value={motif} onChange={(event) => setMotif(event.target.value)}>
            <option value={ANY_MOTIF}>Any motif</option>
            {motifs.map((entry) => (
              <option key={entry.motif} value={entry.motif}>
                {entry.motif} ({entry.count})
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="button button--primary" onClick={drill}>
          Drill puzzles
        </button>
      </section>
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
