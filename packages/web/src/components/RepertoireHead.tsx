import type { RepertoireDrill, TrainingActivity } from "@chess-coach/shared";
import { useLoaded } from "../hooks/useLoaded.js";
import { drillFactsOf, variationNameOf } from "../state/repertoire-drill.js";
import { type FetchRepertoires, fetchRepertoiresFromServer } from "../state/repertoires-api.js";

export interface RepertoireHeadProps {
  training: TrainingActivity;
  drill: RepertoireDrill;
  fetchRepertoires?: FetchRepertoires | undefined;
}

// Above the move list of a line drill: the variation in play, always, and the counts that say how
// far the session has come. The list is read once, for the variation of a position with no book
// name of its own.
export function RepertoireHead({
  training,
  drill,
  fetchRepertoires = fetchRepertoiresFromServer,
}: RepertoireHeadProps) {
  const listed = useLoaded(fetchRepertoires);
  const name = variationNameOf(drill, listed.status === "ready" ? listed.value : null);
  const missing =
    listed.status === "failed" ? "Variation name not available" : "Loading the variation name";
  return (
    <div className="repertoire-head">
      <h3 className="repertoire-head__name" data-testid="variation-name">
        {name ?? missing}
      </h3>
      <dl className="repertoire-head__facts">
        {drillFactsOf(training, drill).map((fact) => (
          <div key={fact.key} className="repertoire-head__fact" data-testid={`fact-${fact.key}`}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
