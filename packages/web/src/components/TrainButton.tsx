import type { RepertoireLevel, RepertoireScope, RepertoireScopeCounts } from "@chess-coach/shared";
import { type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import {
  isStartingTarget,
  type RepertoireStarting,
  type TrainTarget,
  trainButtonOf,
} from "../state/openings-page.js";

export interface TrainControls {
  // A start is in flight, or an opening is being added: no drill can start meanwhile.
  disabled: boolean;
  // The start this page sent, whose button says so.
  starting: RepertoireStarting | null;
  // A start of one variation names no level; an opening or a colour names its level.
  onStart(repertoireId: number, scope: RepertoireScope, level?: RepertoireLevel): void;
}

export interface TrainButtonProps extends TrainControls {
  counts: RepertoireScopeCounts;
  target: TrainTarget;
  // A colour's button trains every opening of it, and says so.
  forSide?: boolean;
  // A variation's row is a little lower than the buttons of a card.
  compact?: boolean;
}

export function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

// A menu that is open closes on a press outside it and on Escape, which hands the focus back.
function useDismiss(
  open: boolean,
  box: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onPress = (event: PointerEvent): void => {
      if (event.target instanceof Node && !box.current?.contains(event.target)) close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      close();
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPress);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPress);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, box, trigger, close]);
}

// The label trains what is recommended and the chevron beside it, inside the same shape, opens the
// other scopes. With nothing recommended the button is a plain one that trains every move.
export function TrainButton({
  counts,
  target,
  forSide = false,
  compact = false,
  disabled,
  starting,
  onStart,
}: TrainButtonProps) {
  const model = trainButtonOf(counts, forSide);
  const mine = isStartingTarget(starting, target);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const box = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const close = useCallback((): void => setOpen(false), []);
  useDismiss(open, box, more, close);
  const size = compact ? "train train--compact" : "train";
  const text = mine ? "Starting" : model.label;
  const send = (scope: RepertoireScope): void => {
    close();
    if (target.level === "variation") onStart(target.repertoireId, scope);
    else onStart(target.repertoireId, scope, target.level);
  };

  if (model.outlined) {
    return (
      <button
        type="button"
        className={`button ${size} train--outlined`}
        aria-label={`${text}, ${target.name}`}
        disabled={disabled || mine || counts.all === 0}
        onClick={() => send(model.scope)}
      >
        {text}
      </button>
    );
  }
  return (
    <div className={`${size} train--split`} ref={box}>
      <button
        type="button"
        className="button button--primary train__main"
        aria-label={`${text}, ${target.name}`}
        disabled={disabled || mine}
        onClick={() => send(model.scope)}
      >
        {text}
      </button>
      <button
        type="button"
        className="button button--primary train__more"
        ref={more}
        aria-label={`More ways to train, ${target.name}`}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled || mine}
        onClick={() => setOpen(!open)}
      >
        <ChevronIcon className="train__chevron" />
      </button>
      {open ? (
        // biome-ignore lint/a11y/useSemanticElements: the menu is a set of buttons, which a fieldset would present as form fields
        <div className="train__menu" id={menuId} role="group" aria-label={`Train ${target.name}`}>
          {model.menu.map((entry) => (
            <button
              key={entry.scope}
              type="button"
              className="train__item"
              disabled={entry.count === 0}
              onClick={() => send(entry.scope)}
            >
              {entry.text} <span className="train__count">{entry.count}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
