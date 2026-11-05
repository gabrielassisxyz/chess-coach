import type { CSSProperties } from "react";
import type { EvalView } from "../state/play.js";

export function EvalBar({ view }: { view: EvalView | null }) {
  const fraction = (view?.fillPercent ?? 50) / 100;
  // The phone bar lies flat and paints its fill from this variable, which the upright one ignores.
  const track = { "--fill": fraction } as CSSProperties;
  return (
    <div className="eval" data-testid="eval-bar">
      <span className="eval__label" data-testid="eval-label">
        {view?.label ?? "-"}
      </span>
      <div
        className="eval__track"
        role="img"
        aria-label={view?.description ?? "No evaluation yet"}
        style={track}
      >
        <div className="eval__fill" style={{ transform: `scaleY(${fraction})` }} />
      </div>
    </div>
  );
}
