import type { ActivityState } from "@chess-coach/shared";
import { useState } from "react";
import type { ServerApi } from "../hooks/useServer.js";
import { controlState } from "../state/play.js";
import { NewGameForm } from "./NewGameForm.js";

export interface ControlsProps {
  activity: ActivityState | null;
  send: ServerApi["send"];
}

export function Controls({ activity, send }: ControlsProps) {
  const [choosing, setChoosing] = useState(false);
  const enabled = controlState(activity);
  const activityId = activity?.activity_id;

  const start = (color: "white" | "black", elo: number): void => {
    if (send({ type: "new_game", color, elo })) setChoosing(false);
  };

  return (
    <div className="controls">
      <div className="controls__row">
        <button
          type="button"
          className="button"
          disabled={!enabled.newGame}
          onClick={() => setChoosing(true)}
        >
          New game
        </button>
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
          className="button"
          disabled={!enabled.abort}
          onClick={() => send({ type: "abort", activity_id: activityId })}
        >
          Abort
        </button>
        {enabled.backToGame ? (
          <button
            type="button"
            className="button button--primary"
            onClick={() => send({ type: "leave_demo", activity_id: activityId })}
          >
            Back to game
          </button>
        ) : null}
      </div>
      {choosing && enabled.newGame ? (
        <NewGameForm onStart={start} onCancel={() => setChoosing(false)} />
      ) : null}
    </div>
  );
}
