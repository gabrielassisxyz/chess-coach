import type { PendingPermission } from "../state/transcript.js";
import { pretty } from "./ToolCard.js";

export function ApprovalCard({
  request,
  onAnswer,
}: {
  request: PendingPermission;
  onAnswer: (requestId: string, allow: boolean) => void;
}) {
  return (
    <section className="card" data-testid="approval-card">
      <div className="card__name">The coach wants to use {request.toolName}</div>
      <pre className="card__body">{pretty(request.input)}</pre>
      <div className="card__actions">
        <button
          type="button"
          className="button button--primary"
          onClick={() => onAnswer(request.requestId, true)}
        >
          Allow
        </button>
        <button type="button" className="button" onClick={() => onAnswer(request.requestId, false)}>
          Deny
        </button>
      </div>
    </section>
  );
}
