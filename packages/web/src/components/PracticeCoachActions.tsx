import { useState } from "react";
import type { ServerApi } from "../hooks/useServer.js";
import { trainingOf } from "../state/practice.js";
import { ASK_COACH_LABEL, coachCommentOffered, whyChipOf } from "../state/practice-item.js";

// Under the coach's reply once an item ended. After a wrong try, one chip with a question about that
// move, sent as the student would type it. After a first-try solve, which the coach leaves
// unanswered, a button that asks for its comment. The client's own, like the Play take-back offer.
export function PracticeCoachActions({
  server,
}: {
  server: Pick<ServerApi, "activity" | "say" | "send">;
}) {
  const [asked, setAsked] = useState<string | null>(null);
  const training = trainingOf(server.activity);
  if (!training) return null;
  const itemKey = `${training.served_at}:${training.item.position_in_queue}`;
  if (coachCommentOffered(training) && asked !== itemKey) {
    return (
      <div className="coach-actions">
        <button
          type="button"
          className="button"
          onClick={() => {
            if (server.send({ type: "ask_coach_about_item", activity_id: training.activity_id })) {
              setAsked(itemKey);
            }
          }}
        >
          {ASK_COACH_LABEL}
        </button>
      </div>
    );
  }
  const chip = whyChipOf(training);
  if (!chip || asked === chip.key) return null;
  return (
    <div className="coach-actions">
      <button
        type="button"
        className="button"
        onClick={() => {
          if (server.say(chip.text)) setAsked(chip.key);
        }}
      >
        {chip.text}
      </button>
    </div>
  );
}
