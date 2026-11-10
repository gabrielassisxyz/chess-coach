import { useState } from "react";
import type { ServerApi } from "../hooks/useServer.js";
import { trainingOf } from "../state/practice.js";
import { ASK_COACH_LABEL, coachCommentOffered, whyChipOf } from "../state/practice-item.js";
import { type LineCard, SHOW_LINE_LABEL } from "../state/tool-summary.js";

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

// Under a coach message that offered a line: the board stays on the practice until the student
// opens it, which asks the server to replay the line as a demo.
export function CoachLineCards({
  cards,
  server,
}: {
  cards: LineCard[];
  server: Pick<ServerApi, "send">;
}) {
  return (
    <>
      {cards.map((card) => (
        <div key={card.key} className="coach-actions line-card" data-testid="line-card">
          <button
            type="button"
            className="button"
            onClick={() => server.send({ type: "show_line", fen: card.fen, moves: card.moves })}
          >
            {SHOW_LINE_LABEL}
          </button>
          <span className="line-card__moves">{card.moves.join(" ")}</span>
        </div>
      ))}
    </>
  );
}
