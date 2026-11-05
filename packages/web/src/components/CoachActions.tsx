import { useState } from "react";
import type { ServerApi } from "../hooks/useServer.js";
import { plyLabel, takeBackOffer } from "../state/play.js";

// Fixed contextual actions under the coach's message after a student blunder. They are the
// client's own: nothing on the server attaches actions to a message.
export function CoachActions({ server }: { server: Pick<ServerApi, "activity" | "send"> }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { activity } = server;
  const blunder = takeBackOffer(activity);
  if (!blunder || activity?.kind !== "live_game") return null;
  const key = `${activity.game_id}:${blunder.ply}`;
  if (dismissed === key) return null;

  return (
    <div className="coach-actions">
      <button
        type="button"
        className="button button--primary"
        onClick={() => server.send({ type: "undo", activity_id: activity.activity_id })}
      >
        {`Take back ${plyLabel(blunder.ply, blunder.san)}`}
      </button>
      <button type="button" className="button" onClick={() => setDismissed(key)}>
        Keep playing
      </button>
    </div>
  );
}
