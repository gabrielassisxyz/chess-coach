import { useState } from "react";
import type { ServiceNotice } from "../state/health.js";

export interface EngineMissingCardProps {
  notice: ServiceNotice;
  onRetry(): void;
}

// The fix line is the first command in the health message, so the copy button and the text beside it
// cannot drift apart.
export function fixCommandOf(message: string): string {
  return /`([^`]+)`/.exec(message)?.[1] ?? message;
}

export function EngineMissingCard({ notice, onRetry }: EngineMissingCardProps) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    navigator.clipboard?.writeText(fixCommandOf(notice.message)).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <section className="practice__problem" aria-label="Engine missing" role="alert">
      <h3 className="practice__problem-title">Stockfish isn't running</h3>
      <p>Answers can't be graded and new cards can't be made until the engine is back.</p>
      <p className="practice__fix">{notice.message}</p>
      <div className="controls__row">
        <button type="button" className="button button--primary" onClick={onRetry}>
          Retry
        </button>
        <button type="button" className="button" onClick={copy}>
          {copied ? "Copied" : "Copy the command"}
        </button>
      </div>
      <p className="practice__reading">
        Reading is still fine: your games open normally without the engine.
      </p>
    </section>
  );
}
