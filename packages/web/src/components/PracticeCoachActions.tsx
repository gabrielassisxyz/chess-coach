import { REPERTOIRE_IDEA_MAX_LENGTH } from "@chess-coach/shared";
import { useState } from "react";
import type { ServerApi } from "../hooks/useServer.js";
import { trainingOf } from "../state/practice.js";
import { ASK_COACH_LABEL, coachCommentOffered, whyChipOf } from "../state/practice-item.js";
import { type SaveRepertoireNote, saveRepertoireNote } from "../state/repertoire-note-api.js";
import { type LineCard, SHOW_LINE_LABEL } from "../state/tool-summary.js";
import type { RepertoireNoteOffer } from "../state/transcript.js";

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

// Under the coach's reply to an "Ask for the idea" request: opens the reply for editing and saves
// it as the move's note via the HTTP route, keeping the position_id from the request.
export function CoachNoteCard({
  offer,
  onSaved,
  saveNote = saveRepertoireNote,
}: {
  offer: RepertoireNoteOffer;
  onSaved: () => void;
  saveNote?: SaveRepertoireNote;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(offer.replyText);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  if (offer.saved) {
    return (
      <div className="note-save" data-testid="note-save-card">
        <p className="note-save__saved">Nota salva</p>
      </div>
    );
  }

  const promptLabel = offer.hadNote
    ? `Substituir a nota de ${offer.moveLabel}`
    : `Salvar como nota de ${offer.moveLabel}`;

  if (!editing) {
    return (
      <div className="note-save note-save--closed" data-testid="note-save-card">
        <button
          type="button"
          className="button"
          onClick={() => {
            setDraft(offer.replyText);
            setFailed(false);
            setEditing(true);
          }}
        >
          {promptLabel}
        </button>
      </div>
    );
  }

  const length = draft.trim().length;
  const overLimit = length > REPERTOIRE_IDEA_MAX_LENGTH;
  const canSave = !saving && length > 0 && !overLimit;

  const submit = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    setFailed(false);
    try {
      await saveNote(offer.positionId, draft.trim());
      onSaved();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="note-save" data-testid="note-save-card">
      <textarea
        className="input note-save__input"
        aria-label={promptLabel}
        rows={4}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="note-save__footer">
        <span
          className={overLimit ? "note-save__count note-save__count--over" : "note-save__count"}
          data-testid="note-save-count"
        >
          {length}/{REPERTOIRE_IDEA_MAX_LENGTH}
        </span>
        <div className="note-save__actions">
          <button
            type="button"
            className="button"
            disabled={saving}
            onClick={() => {
              setEditing(false);
              setFailed(false);
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!canSave}
            onClick={() => void submit()}
          >
            Salvar
          </button>
        </div>
      </div>
      {failed ? (
        <p className="note-save__error" role="alert">
          A nota não foi salva.
        </p>
      ) : null}
    </div>
  );
}
