import type { FoundPositionCounts, RepertoireScope } from "@chess-coach/shared";
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";

export function FilterGroup<Choice extends string>({
  label,
  choices,
  current,
  onChoose,
}: {
  label: string;
  choices: readonly { value: Choice; label: string }[];
  current: Choice;
  onChoose(value: Choice): void;
}) {
  return (
    <fieldset className="found-filter" aria-label={label}>
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          className="found-filter__button"
          aria-pressed={choice.value === current}
          onClick={() => onChoose(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </fieldset>
  );
}

function ChevronDown() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

// Closes what is open on Escape, which gives the focus back to its toggle, and when the pointer or
// the focus goes outside it. The focus is read from focusin and not from blur: Safari does not focus
// a button that is clicked, so a blur would close the menu before the click on an item landed.
function useDismiss(
  open: boolean,
  root: RefObject<HTMLElement | null>,
  toggle: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      close();
      toggle.current?.focus();
    };
    const onOutside = (event: Event): void => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("focusin", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("focusin", onOutside);
    };
  }, [open, root, toggle, close]);
}

export interface TrainControlProps {
  counts: FoundPositionCounts;
  // Nothing can start: a start is in flight, or the counts are not those of the list shown yet.
  disabled: boolean;
  // A start of the header's own is in flight; the pill says so, whichever item of the menu made it.
  starting: boolean;
  onStart(scope: RepertoireScope): void;
}

const trainLabelOf = (counts: FoundPositionCounts, starting: boolean): string => {
  if (starting) return "Starting";
  return counts.recommended > 0 ? `Train ${counts.recommended}` : "Train all positions";
};

// "Train N" drills what the server recommends, a few due and new positions; the chevron opens the
// two wider drills. A start the counts say would be empty is disabled.
export function TrainControl({ counts, disabled, starting, onStart }: TrainControlProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback((): void => setOpen(false), []);
  useDismiss(open, root, toggle, close);

  const startFrom = (scope: RepertoireScope): void => {
    close();
    onStart(scope);
  };
  const wider: readonly { scope: RepertoireScope; label: string; count: number }[] = [
    { scope: "due", label: "Everything due", count: counts.due },
    { scope: "all", label: "All positions", count: counts.all },
  ];

  return (
    <div className="found-train" ref={root}>
      <button
        type="button"
        className="found-train__main"
        disabled={disabled || counts.all === 0}
        onClick={() => startFrom(counts.recommended > 0 ? "recommended" : "all")}
      >
        {trainLabelOf(counts, starting)}
      </button>
      <button
        type="button"
        className="found-train__more"
        ref={toggle}
        aria-label="More ways to train"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((isOpen) => !isOpen)}
      >
        <ChevronDown />
      </button>
      {open ? (
        <div className="found-train__menu" id={menuId}>
          {wider.map((item) => (
            <button
              key={item.scope}
              type="button"
              className="found-train__item"
              disabled={disabled || item.count === 0}
              onClick={() => startFrom(item.scope)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
