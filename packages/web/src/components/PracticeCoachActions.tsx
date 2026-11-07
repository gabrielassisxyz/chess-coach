import { useState } from "react";
import type { ServerApi } from "../hooks/useServer.js";
import { trainingOf } from "../state/practice.js";
import { whyChipOf } from "../state/practice-item.js";

// One chip under the coach's reply once an item ended with a wrong try: a question about that
// move, sent as the student would type it. The client's own, like the Play take-back offer.
export function PracticeCoachActions({ server }: { server: Pick<ServerApi, "activity" | "say"> }) {
  const [asked, setAsked] = useState<string | null>(null);
  const training = trainingOf(server.activity);
  const chip = training ? whyChipOf(training) : null;
  if (!training || !chip || asked === chip.key) return null;
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
