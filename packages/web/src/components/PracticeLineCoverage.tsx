import {
  type RepertoireCoverage as Coverage,
  type CoverageReply,
  repertoireRootText,
} from "@chess-coach/shared";
import { type ReactNode, useCallback, useId, useState } from "react";
import { useLoaded } from "../hooks/useLoaded.js";
import { NONE } from "../state/practice.js";
import {
  COVERAGE_STATUS_TEXT,
  type FetchCoverage,
  oneInText,
  percentText,
  replyChanceText,
  replyMoveText,
} from "../state/repertoires-api.js";

// "expected score 80.2% · soundness 99 · largest gap: none". A score nothing was measured for holds
// the no-value dash, and the largest gap names the reply it is, since the card shows one position
// at a time.
function scoresText(coverage: Coverage): string {
  const { scores, largest_gap: largest, goal_one_in: goal } = coverage;
  const expected = scores.expected_score === null ? NONE : percentText(scores.expected_score);
  const soundness = scores.soundness === null ? NONE : String(scores.soundness);
  const gap = largest
    ? `${replyMoveText(largest.line.slice(0, -1), largest.line.at(-1) ?? "")}, ${oneInText(largest.incidence, goal)}`
    : "none";
  return `expected score ${expected} · soundness ${soundness} · largest gap: ${gap}`;
}

function Reply({
  line,
  reply,
  goalOneIn,
  onOpen,
}: {
  line: readonly string[];
  reply: CoverageReply;
  goalOneIn: number;
  onOpen(position: number): void;
}) {
  const move = replyMoveText(line, reply.san);
  const cells = (
    <>
      <span className="line-reply__move">{move}</span>{" "}
      <span className="line-reply__chance">{replyChanceText(reply, goalOneIn)}</span>{" "}
      <span className="line-reply__status" data-status={reply.status}>
        {COVERAGE_STATUS_TEXT[reply.status]}
      </span>
    </>
  );
  const next = reply.next;
  return (
    <li className="line-replies__item">
      {next === null ? (
        <div className="line-reply">{cells}</div>
      ) : (
        <button
          type="button"
          className="line-reply line-reply--open"
          title={`Open the position after ${move}`}
          onClick={() => onOpen(next)}
        >
          {cells}
        </button>
      )}
    </li>
  );
}

// Black's replies in one position, the likeliest first. A reply the line answers opens the position
// White answers from, and Up one move goes back along the line.
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
    <>
      {parent === null ? null : (
        <div className="line-coverage__up">
          <button type="button" className="button button--quiet" onClick={() => onSelect(parent)}>
            Up one move
          </button>
        </div>
      )}
      <p className="line-card__note" aria-live="polite">
        Black's replies after{" "}
        <span className="line-coverage__line">{repertoireRootText(position.line)}</span>, the
        likeliest first
      </p>
      {position.replies.length === 0 ? (
        <p className="line-card__note">No reply is stored after this move.</p>
      ) : (
        <ul className="line-replies" aria-label="Black's replies">
          {position.replies.map((reply) => (
            <Reply
              key={reply.san}
              line={position.line}
              reply={reply}
              goalOneIn={coverage.goal_one_in}
              onOpen={onSelect}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function CoverageBody({ coverage }: { coverage: Coverage }) {
  const [selected, setSelected] = useState(coverage.start);
  if (coverage.positions.length === 0) {
    return (
      <p className="line-card__note" role="status">
        Nothing is stored for this variation yet. Build it first.
      </p>
    );
  }
  return (
    <>
      <p className="line-coverage__scores">{scoresText(coverage)}</p>
      <Replies coverage={coverage} index={selected} onSelect={setSelected} />
    </>
  );
}

function CoverageCard({ children }: { children: ReactNode }) {
  const titleId = useId();
  return (
    <section className="line-card line-coverage" aria-labelledby={titleId}>
      <h3 className="line-card__title" id={titleId}>
        Coverage
      </h3>
      {children}
    </section>
  );
}

// A line read from a PGN file stores no engine figure for the walk to read, so its coverage is not
// measured: the card says so and asks the server for nothing.
export function PracticeImportedLineCoverage() {
  return (
    <CoverageCard>
      <p className="line-card__note">Coverage is not measured for an imported line.</p>
    </CoverageCard>
  );
}

// What the line covers, read from its stored moves when its page opens, and again after each
// rebuild: the page remounts this card then, so it never shows moves a rebuild has replaced.
export function PracticeLineCoverage({
  repertoireId,
  fetchCoverage,
}: {
  repertoireId: number;
  fetchCoverage: FetchCoverage;
}) {
  const load = useCallback(() => fetchCoverage(repertoireId), [fetchCoverage, repertoireId]);
  const loaded = useLoaded(load);
  if (loaded.status === "loading") {
    return (
      <CoverageCard>
        <p className="line-card__note" role="status">
          Loading the coverage.
        </p>
      </CoverageCard>
    );
  }
  if (loaded.status === "failed") {
    return (
      <CoverageCard>
        <p className="practice__failure" role="alert">
          The coverage could not be loaded.
        </p>
        <div className="controls__row">
          <button type="button" className="button" onClick={loaded.retry}>
            Try again
          </button>
        </div>
      </CoverageCard>
    );
  }
  return (
    <CoverageCard>
      <CoverageBody coverage={loaded.value} />
    </CoverageCard>
  );
}
