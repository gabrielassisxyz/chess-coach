import { type RepertoireCoverage as Coverage, repertoireRootText } from "@chess-coach/shared";
import { useCallback, useState } from "react";
import { useLoaded } from "../hooks/useLoaded.js";
import {
  COVERAGE_STATUS_TEXT,
  type FetchCoverage,
  fetchCoverageFromServer,
  oneInText,
  percentText,
  replyChanceText,
  replyMoveText,
  soundnessText,
} from "../state/repertoires-api.js";

// The likeliest gaps are the ones worth fixing first; the rest are counted, not listed.
const GAPS_SHOWN = 10;

export interface RepertoireCoverageProps {
  repertoireId: number;
  // Tells this block from another one open at the same time.
  name: string;
  fetchCoverage?: FetchCoverage | undefined;
}

// A figure is data and reads in mono; where there is none, the words that say so do not.
function Fact({ term, value, empty }: { term: string; value: string; empty: boolean }) {
  return (
    <div className="repertoire-coverage__fact">
      <dt>{term}</dt>
      <dd data-empty={empty ? "" : undefined}>{value}</dd>
    </div>
  );
}

function Facts({ coverage }: { coverage: Coverage }) {
  const { scores, largest_gap: largest, goal_one_in: goal, rating_band: band } = coverage;
  return (
    <>
      <dl className="repertoire-coverage__facts">
        <Fact
          term="Covered"
          value={percentText(coverage.covered_percent)}
          empty={coverage.covered_percent === null}
        />
        <Fact
          term="Expected score"
          value={percentText(scores.expected_score)}
          empty={scores.expected_score === null}
        />
        <Fact
          term="Soundness"
          value={soundnessText(scores.soundness)}
          empty={scores.soundness === null}
        />
        <Fact
          term="Largest gap"
          value={largest ? oneInText(largest.incidence, goal) : "None"}
          empty={largest === null}
        />
      </dl>
      <p className="practice__card-note repertoire-coverage__note">
        Covered is the share of games that stay above 1 in {goal} and end in a line you have
        prepared, not at a reply with no answer.
      </p>
      <p className="practice__card-note repertoire-coverage__note">
        Expected score is White's result at {band} where your lines end, weighted by how often each
        line arises. Soundness runs from 1 to 99: each move may give up 10 centipawns without
        counting against its line, and lines that give up 200 or more on average score 1.
      </p>
    </>
  );
}

function Gaps({ coverage, onShow }: { coverage: Coverage; onShow(position: number): void }) {
  const { gaps, goal_one_in: goal } = coverage;
  if (gaps.length === 0) {
    return (
      <p className="practice__card-note">
        No reply that arises at least 1 in {goal} is missing an answer.
      </p>
    );
  }
  const shown = gaps.slice(0, GAPS_SHOWN);
  return (
    <div className="repertoire-coverage__block">
      <h5 className="repertoire-coverage__heading">Gaps</h5>
      <p className="practice__card-note">Replies with no answer yet, likeliest first.</p>
      <ul className="repertoire-coverage__list" aria-label="Gaps">
        {shown.map((gap) => {
          const line = repertoireRootText(gap.line);
          return (
            <li key={line} className="repertoire-coverage__row">
              <span className="repertoire-coverage__line">{line}</span>
              <span className="repertoire-coverage__chance">{oneInText(gap.incidence, goal)}</span>
              <button
                type="button"
                className="button"
                aria-label={`Show the position of ${line}`}
                onClick={() => onShow(gap.position)}
              >
                Show
              </button>
            </li>
          );
        })}
      </ul>
      {gaps.length > shown.length ? (
        <p className="practice__card-note">
          And {gaps.length - shown.length} more, each less likely.
        </p>
      ) : null}
    </div>
  );
}

function Replies({
  coverage,
  index,
  onSelect,
}: {
  coverage: Coverage;
  index: number;
  onSelect(position: number): void;
}) {
  const position = coverage.positions[index];
  if (!position) return null;
  const parent = position.parent;
  return (
    <div className="repertoire-coverage__block">
      <h5 className="repertoire-coverage__heading">Black's replies</h5>
      <p className="repertoire-coverage__position" aria-live="polite">
        After <span className="repertoire-coverage__line">{repertoireRootText(position.line)}</span>
      </p>
      {parent === null ? null : (
        <button type="button" className="button button--quiet" onClick={() => onSelect(parent)}>
          Up one move
        </button>
      )}
      {position.replies.length === 0 ? (
        <p className="practice__card-note">No reply is stored after this move.</p>
      ) : (
        <ul className="repertoire-coverage__list" aria-label="Black's replies">
          {position.replies.map((reply) => {
            const move = replyMoveText(position.line, reply.san);
            const next = reply.next;
            return (
              <li key={reply.san} className="repertoire-coverage__row">
                <span className="repertoire-coverage__move">{move}</span>
                <span className="repertoire-coverage__chance">
                  {replyChanceText(reply, coverage.goal_one_in)}
                </span>
                <span className="repertoire-coverage__status" data-status={reply.status}>
                  {COVERAGE_STATUS_TEXT[reply.status]}
                </span>
                {next === null ? null : (
                  <button
                    type="button"
                    className="button"
                    aria-label={`Open the position after ${move}`}
                    onClick={() => onSelect(next)}
                  >
                    Open
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CoverageView({ label, coverage }: { label: string; coverage: Coverage }) {
  const [selected, setSelected] = useState(coverage.start);
  return (
    <section className="repertoire-coverage" aria-label={label}>
      <Facts coverage={coverage} />
      <Gaps coverage={coverage} onShow={setSelected} />
      <Replies coverage={coverage} index={selected} onSelect={setSelected} />
    </section>
  );
}

// What a stored variation leaves unanswered and how well it does, read from its stored moves when it
// is opened: three numbers, the replies with no answer, and Black's replies one position at a time.
export function RepertoireCoverage({
  repertoireId,
  name,
  fetchCoverage = fetchCoverageFromServer,
}: RepertoireCoverageProps) {
  const load = useCallback(() => fetchCoverage(repertoireId), [fetchCoverage, repertoireId]);
  const loaded = useLoaded(load);
  if (loaded.status === "loading") {
    return (
      <p className="practice__card-note" role="status">
        Loading the coverage.
      </p>
    );
  }
  if (loaded.status === "failed") {
    return (
      <p className="practice__failure" role="alert">
        The coverage could not be loaded. Close it and open it again to try again.
      </p>
    );
  }
  if (loaded.value.positions.length === 0) {
    return (
      <p className="practice__card-note" role="status">
        Nothing is stored for this variation yet. Build it first.
      </p>
    );
  }
  return <CoverageView label={`Coverage of ${name}`} coverage={loaded.value} />;
}
