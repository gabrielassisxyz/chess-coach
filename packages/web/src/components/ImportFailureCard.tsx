import type { FailureCard } from "../state/import-failure.js";

export function ImportFailureCard({ card }: { card: FailureCard }) {
  const { failure } = card;
  if (!failure) return null;
  const missing = failure.failed.length;
  const total = failure.saved + missing;
  return (
    <div className="games__failure" role="alert">
      <h3 className="games__failure-title">Import didn't finish</h3>
      <p>
        {`${failure.saved} of ${total} games were saved and are being graded; the other ${missing} could not be fetched.`}
        {failure.failed[0] ? ` ${failure.failed[0].message}` : ""}
      </p>
      <p className="screen__note">{`Retrying fetches only the missing ${missing} again.`}</p>
      {card.error ? <p className="games__failure-error">{card.error}</p> : null}
      <div className="games__bar">
        <button
          type="button"
          className="button button--primary"
          disabled={card.busy}
          onClick={card.retry}
        >
          {`Retry the ${missing}`}
        </button>
        <button type="button" className="button" onClick={card.dismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
