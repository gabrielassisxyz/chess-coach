import { useId } from "react";
import {
  PRACTICE_ENTRY_LABEL,
  PRACTICE_NAV_GROUPS,
  type PracticeEntry,
} from "../state/practice-page.js";

export interface PracticeNavProps {
  current: PracticeEntry;
  onChoose(entry: PracticeEntry): void;
  // The repertoire moves due now, which the Openings entry shows; null or 0 shows no number.
  openingsDue: number | null;
  // The positions from the student's games due now, which the From my games entry shows the same way.
  foundDue?: number | null;
}

// What an entry's number counts, for the screen reader that hears it after the name.
const DUE_TEXT: Partial<Record<PracticeEntry, (count: number) => string>> = {
  openings: (count) => `${count} ${count === 1 ? "move" : "moves"} due`,
  "from-my-games": (count) => `${count} due`,
};

function NavEntry({
  entry,
  current,
  count,
  onChoose,
}: Pick<PracticeNavProps, "current" | "onChoose"> & {
  entry: PracticeEntry;
  count: number | null;
}) {
  const name = PRACTICE_ENTRY_LABEL[entry];
  return (
    <button
      type="button"
      className="practice-nav__entry"
      aria-current={entry === current ? "page" : undefined}
      aria-label={count === null ? undefined : `${name}, ${DUE_TEXT[entry]?.(count)}`}
      onClick={() => onChoose(entry)}
    >
      <span className="practice-nav__name">{name}</span>
      {count === null ? null : <span className="practice-nav__count">{count}</span>}
    </button>
  );
}

function NavGroup({
  group,
  current,
  onChoose,
  openingsDue,
  foundDue = null,
}: PracticeNavProps & { group: (typeof PRACTICE_NAV_GROUPS)[number] }) {
  const labelId = useId();
  const dueOf: Partial<Record<PracticeEntry, number | null>> = {
    openings: openingsDue,
    "from-my-games": foundDue,
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: these are navigation entries, not form fields; a fieldset would present them as a form
    <div className="practice-nav__group" role="group" aria-labelledby={labelId}>
      <div className="practice-nav__label" id={labelId}>
        {group.label}
      </div>
      {group.entries.map((entry) => (
        <NavEntry
          key={entry}
          entry={entry}
          current={current}
          count={dueOf[entry] || null}
          onChoose={onChoose}
        />
      ))}
    </div>
  );
}

// The hub's sections: one entry per page, with Puzzle themes leading into the Overview.
export function PracticeNav(props: PracticeNavProps) {
  return (
    <nav className="practice-nav" aria-label="Practice sections">
      {PRACTICE_NAV_GROUPS.map((group) => (
        <NavGroup key={group.label} group={group} {...props} />
      ))}
    </nav>
  );
}
