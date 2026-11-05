import type { ActivityState } from "@chess-coach/shared";
import { useState } from "react";
import type { ServerApi } from "../hooks/useServer.js";
import { controlState } from "../state/play.js";
import { NewGameForm } from "./NewGameForm.js";

export interface ControlsProps {
  activity: ActivityState | null;
  send: ServerApi["send"];
  // True while the engine is unavailable: a game could be opened but never played.
  newGameBlocked?: boolean;
  currentElo?: number | null | undefined;
}

export function Controls({ activity, send, newGameBlocked = false, currentElo }: ControlsProps) {
  const [choosing, setChoosing] = useState(false);
  const enabled = controlState(activity);
  const canStart = enabled.newGame && !newGameBlocked;
  const activityId = activity?.activity_id;

  const start = (color: "white" | "black", elo: number): void => {
    if (send({ type: "new_game", color, elo })) setChoosing(false);
  };

  return (
    <div className="controls">
      <div className="controls__row controls__row--play">
        <button
          type="button"
          className="button"
          disabled={!enabled.undo}
          onClick={() => send({ type: "undo", activity_id: activityId })}
        >
          Undo
        </button>
        <button
          type="button"
          className="button"
          disabled={!enabled.resign}
          onClick={() => send({ type: "resign", activity_id: activityId })}
        >
          Resign
        </button>
        <button
          type="button"
          className="button controls__wide"
          disabled={!enabled.abort}
          onClick={() => send({ type: "abort", activity_id: activityId })}
        >
          Abort
        </button>
        {enabled.backToGame ? (
          <button
            type="button"
            className="button button--primary controls__wide"
            onClick={() => send({ type: "leave_demo", activity_id: activityId })}
          >
            Back to game
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="button controls__new"
        disabled={!canStart}
        onClick={() => setChoosing(true)}
      >
        New game
      </button>
      {choosing && canStart ? (
        <NewGameForm onStart={start} onCancel={() => setChoosing(false)} defaultElo={currentElo} />
      ) : null}
    </div>
  );
}
