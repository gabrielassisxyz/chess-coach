import type { OpeningDrill, OpeningDrillColor } from "@chess-coach/shared";
import type { ReactNode } from "react";
import {
  type DrillPlacement,
  drillNameOf,
  drillPositionsText,
  drillRateText,
  drillTargetOf,
  type OpeningDrillControls,
} from "../state/openings-api.js";

// The drills from the student's games sit in three places, never two at once for one opening: a
// line in the menu of the stored opening that has the family's name, a line under an opening met in
// games that has no drill yet, and a row of their own for every other family. They share one start.

interface DrillProps {
  color: OpeningDrillColor;
  drill: OpeningDrill;
  controls: OpeningDrillControls;
  // Any start is in flight, from this card or another: every button waits.
  busy: boolean;
}

function DrillStart({ color, drill, controls, busy }: DrillProps) {
  const mine = controls.starting?.color === color && controls.starting.opening === drill.opening;
  return (
    <button
      type="button"
      className="button"
      aria-label={`${mine ? "Starting" : "Drill"} ${drillTargetOf(drill, color)}`}
      disabled={busy || controls.engineMissing}
      onClick={() => controls.onStart(color, drill.opening)}
    >
      {mine ? "Starting" : "Drill"}
    </button>
  );
}

// The cell is always there, empty when the family had no attempt in the last 30 days, so the
// buttons of the rows above and below it keep their column.
function RateCell({ drill }: { drill: OpeningDrill }) {
  const rate = drillRateText(drill);
  return (
    <span
      className="repertoire-menu__drill-rate"
      title={rate === null ? undefined : "First try, last 30 days"}
    >
      {rate}
    </span>
  );
}

export function OpeningDrillLine(props: DrillProps) {
  return (
    <div className="repertoire-menu__drill-line">
      <span className="repertoire-menu__drill-name">
        {`Positions from your games (${props.drill.positions})`}
      </span>
      <RateCell drill={props.drill} />
      <DrillStart {...props} />
    </div>
  );
}

function DrillRow(props: DrillProps) {
  return (
    <li className="repertoire-menu__drill-row">
      <span className="repertoire-menu__drill-name">{drillNameOf(props.drill)}</span>
      <span className="repertoire-menu__drill-count">
        {drillPositionsText(props.drill.positions)}
      </span>
      <RateCell drill={props.drill} />
      <DrillStart {...props} />
    </li>
  );
}

// The families that have neither a menu nor a row of games met, one row each.
export function DrillRows({
  color,
  drills,
  controls,
  busy,
}: {
  color: OpeningDrillColor;
  drills: readonly OpeningDrill[];
  controls: OpeningDrillControls;
  busy: boolean;
}) {
  if (drills.length === 0) return null;
  return (
    <div className="repertoire-menu__drills">
      <h4 className="repertoire-menu__name">Positions from your games</h4>
      <p className="practice__card-note">
        Best move in the positions that came up in your games, one opening at a time. First try,
        last 30 days.
      </p>
      <ul
        className="repertoire-menu__drill-list"
        aria-label={`Positions from your games as ${color === "white" ? "White" : "Black"}`}
      >
        {drills.map((drill) => (
          <DrillRow
            key={drill.opening}
            color={color}
            drill={drill}
            controls={controls}
            busy={busy}
          />
        ))}
      </ul>
    </div>
  );
}

// What a side of the menu draws from its placement: the line for an opening's menu, the line for a
// met row, and the rows left over.
export interface DrillSlots {
  menuLine(openingName: string): ReactNode;
  metLine(rootKey: string): ReactNode;
  rows: ReactNode;
}

export function drillSlotsOf(
  color: OpeningDrillColor,
  controls: OpeningDrillControls,
  busy: boolean,
  placement: DrillPlacement,
): DrillSlots {
  const line = (drill: OpeningDrill | undefined): ReactNode =>
    drill ? <OpeningDrillLine color={color} drill={drill} controls={controls} busy={busy} /> : null;
  return {
    menuLine: (openingName) => line(placement.inMenu.get(openingName)),
    metLine: (rootKey) => line(placement.onMetRow.get(rootKey)),
    rows: <DrillRows color={color} drills={placement.plain} controls={controls} busy={busy} />,
  };
}
