import type { RepertoireSummary } from "@chess-coach/shared";
import { useId, useState } from "react";
import type { LineRebuild, LineRebuildOutcome } from "../state/line-rebuild.js";
import { figureValuesOf } from "../state/openings-page.js";
import { NONE } from "../state/practice.js";
import {
  DEFAULT_STYLE_POINTS,
  type FetchCoverage,
  type StylePoints,
  stylePointsLeft,
  stylePointsLeftText,
  stylePointsText,
} from "../state/repertoires-api.js";
import { PracticeLineCoverage } from "./PracticeLineCoverage.js";
import { StylePointRows } from "./RepertoireMenu.js";
import { TrainButton, type TrainControls } from "./TrainButton.js";

const REBUILDING_TEXT =
  "This line is being rebuilt. It keeps working as it was until the rebuild ends.";

const NOT_REBUILDABLE_TEXT =
  "This line was stored before its branch was recorded, so it cannot be rebuilt from here.";

const REBUILD_ENDING_TEXT: Record<LineRebuildOutcome, string> = {
  rebuilt: "The line is rebuilt.",
  stopped: "The rebuild stopped before the end; the line is as it was.",
  busy: "Another opening is being built. Try again when it ends.",
  failed: "The rebuild failed; the line is as it was.",
};

// "R of N": the first attempts the line drill rated in the last 30 days that were right. Nothing
// asked holds the no-value dash, as the list's cell does.
function rememberedCountText(variation: RepertoireSummary): string {
  const remembered = variation.remembered_30d;
  if (remembered === undefined || remembered.of === 0) return NONE;
  return `${remembered.right} of ${remembered.of}`;
}

interface Tile {
  label: string;
  value: string;
  accent?: boolean;
}

// The five figures of the row the list draws, in its order, each as a tile of the page.
function tilesOf(variation: RepertoireSummary): Tile[] {
  const values = figureValuesOf(variation);
  return [
    { label: "Moves in the line", value: values.moves },
    { label: "Due now", value: String(values.due), accent: values.due > 0 },
    { label: "Remembered in 30 days", value: rememberedCountText(variation) },
    { label: "In line", value: values.inLineText },
    { label: "Coverage", value: values.coverage },
  ];
}

function LineTiles({ variation }: { variation: RepertoireSummary }) {
  return (
    <dl className="line-tiles">
      {tilesOf(variation).map(({ label, value, accent = false }) => (
        <div key={label} className="line-tile">
          <dt className="line-tile__label">{label}</dt>
          <dd className={accent ? "line-tile__value line-tile__accent" : "line-tile__value"}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Crumbs({ groupName, onBack }: { groupName: string | null; onBack(): void }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="line-page__crumbs">
        <li className="line-page__crumb">
          <button type="button" className="line-page__back" onClick={onBack}>
            Openings
          </button>
        </li>
        {groupName === null ? null : <li className="line-page__crumb">{groupName}</li>}
      </ol>
    </nav>
  );
}

// What the rebuild button and the sentences under it say. A rebuild is walking the line, whoever
// sent it, or it ended a moment ago.
function RebuildStatus({
  rebuilding,
  rebuildable,
  outcome,
  retry,
}: {
  rebuilding: boolean;
  rebuildable: boolean;
  outcome: LineRebuildOutcome | null;
  // Null while the points cannot be sent, which leaves the retry out of reach.
  retry: (() => void) | null;
}) {
  return (
    <>
      {rebuilding ? (
        <p className="line-card__note" role="status">
          {REBUILDING_TEXT}
        </p>
      ) : null}
      {rebuildable ? null : <p className="line-card__note">{NOT_REBUILDABLE_TEXT}</p>}
      {outcome === null || rebuilding ? null : (
        <div className="line-style__ending">
          <p
            className={outcome === "rebuilt" ? "line-card__note" : "practice__failure"}
            role={outcome === "rebuilt" ? "status" : "alert"}
          >
            {REBUILD_ENDING_TEXT[outcome]}
          </p>
          {outcome === "failed" ? (
            <button
              type="button"
              className="button"
              disabled={retry === null}
              onClick={retry ?? undefined}
            >
              Try again
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}

// The points the line was built with, and three steppers to build it again with other ones. Moving
// a stepper changes nothing stored: the moves change when the rebuild ends.
function LineStyleCard({
  variation,
  rebuildable,
  rebuilding,
  outcome,
  onRebuild,
}: {
  variation: RepertoireSummary;
  rebuildable: boolean;
  rebuilding: boolean;
  outcome: LineRebuildOutcome | null;
  onRebuild(points: StylePoints): void;
}) {
  const titleId = useId();
  const [points, setPoints] = useState<StylePoints>(() => ({
    ...(variation.points ?? DEFAULT_STYLE_POINTS),
  }));
  const builtWith = variation.points
    ? `built with ${stylePointsText(variation.points)}`
    : "built before style points";
  const canRebuild = rebuildable && !rebuilding && stylePointsLeft(points) === 0;
  const rebuild = (): void => onRebuild(points);
  return (
    <section className="line-card line-style" aria-labelledby={titleId}>
      <div className="line-style__head">
        <div className="line-style__titles">
          <h3 className="line-card__title" id={titleId}>
            Style of this line
          </h3>
          <p className="line-style__built">{builtWith}</p>
        </div>
        <button
          type="button"
          className="button button--primary line-style__rebuild"
          disabled={!canRebuild}
          onClick={rebuild}
        >
          {rebuilding ? "Rebuilding…" : "Rebuild with these points"}
        </button>
      </div>
      <div className="line-style__points">
        <StylePointRows points={points} onChange={setPoints} />
        <p className="line-card__note" aria-live="polite">
          {stylePointsLeftText(points)}
        </p>
      </div>
      <p className="line-card__note">Changing the points changes the moves only after a rebuild.</p>
      <RebuildStatus
        rebuilding={rebuilding}
        rebuildable={rebuildable}
        outcome={outcome}
        retry={canRebuild ? rebuild : null}
      />
    </section>
  );
}

export interface PracticeLineProps {
  // The variation as the list gave it; undefined once the list no longer holds it.
  variation: RepertoireSummary | undefined;
  // False for a variation the server could not tell from the first of its group, see
  // `rebuildNamesLine`: rebuilding it would walk another line.
  rebuildable: boolean;
  // The variation a rebuild is walking, whether the list says so or this page sent it.
  rebuildingId: number | null;
  train: TrainControls;
  fetchCoverage: FetchCoverage;
  rebuild: LineRebuild;
  onBack(): void;
}

// One stored variation on a page of its own inside the Openings entry: where it sits, its name and
// moves, what it would train, its five figures, what it covers and the style it was built with.
export function PracticeLine({
  variation,
  rebuildable,
  rebuildingId,
  train,
  fetchCoverage,
  rebuild,
  onBack,
}: PracticeLineProps) {
  const titleId = useId();
  if (variation === undefined) {
    return (
      <section className="line-page" aria-label="Line">
        <Crumbs groupName={null} onBack={onBack} />
        <p className="line-card__note" role="status">
          This line is no longer stored.
        </p>
      </section>
    );
  }
  const name = variation.variation_name;
  const ended = rebuild.ended?.id === variation.id ? rebuild.ended.outcome : null;
  return (
    <section className="line-page" aria-labelledby={titleId}>
      <Crumbs groupName={variation.group_name} onBack={onBack} />
      <header className="line-page__head">
        <div className="line-page__titles">
          <h2 className="line-page__title" id={titleId}>
            {name}
          </h2>
          {variation.line ? <p className="line-page__line">{variation.line}</p> : null}
        </div>
        <TrainButton
          counts={variation.moves}
          target={{ repertoireId: variation.id, level: "variation", name }}
          {...train}
        />
      </header>
      <LineTiles variation={variation} />
      <PracticeLineCoverage
        key={`${variation.id}:${rebuild.endings}`}
        repertoireId={variation.id}
        fetchCoverage={fetchCoverage}
      />
      <LineStyleCard
        variation={variation}
        rebuildable={rebuildable}
        rebuilding={rebuildingId === variation.id}
        outcome={ended}
        onRebuild={(points) => {
          void rebuild.start(variation, points);
        }}
      />
    </section>
  );
}
