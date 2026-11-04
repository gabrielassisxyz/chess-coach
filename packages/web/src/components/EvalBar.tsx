import type { EvalView } from "../state/play.js";

export function EvalBar({ view }: { view: EvalView | null }) {
  return (
    <div className="eval" data-testid="eval-bar">
      <div className="eval__track" role="img" aria-label={view?.description ?? "No evaluation yet"}>
        <div
          className="eval__fill"
          style={{ transform: `scaleX(${(view?.fillPercent ?? 50) / 100})` }}
        />
      </div>
      <span className="eval__label" data-testid="eval-label">
        {view?.label ?? "-"}
      </span>
    </div>
  );
}
