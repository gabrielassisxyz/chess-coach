import { type ReactNode, useEffect, useRef } from "react";
import { ANIMATION_OPTIONS, type BoardPrefs, COORDINATE_OPTIONS } from "../state/board-prefs.js";
import { BOARD_THEMES, type BoardTheme } from "../state/board-theme.js";

export interface BoardDisplayPopoverProps {
  theme: BoardTheme;
  onTheme(theme: BoardTheme): void;
  prefs: BoardPrefs;
  onPrefs(change: Partial<BoardPrefs>): void;
  onClose(): void;
}

const COORDINATE_LABEL: Record<BoardPrefs["coordinates"], string> = {
  inside: "Inside",
  edge: "Edge",
  off: "Off",
};
const ANIMATION_LABEL: Record<BoardPrefs["animation"], string> = {
  off: "Off",
  fast: "Fast",
  normal: "Normal",
};

function Segmented<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange(value: T): void;
}) {
  return (
    <div className="popover__row">
      <span className="popover__label" id={`segmented-${label}`}>
        {label}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={`segmented-${label}`}>
        {options.map((option) => (
          // biome-ignore lint/a11y/useSemanticElements: a segmented control is a row of buttons; the radio semantics are what it means
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === value}
            className="segmented__option"
            onClick={() => onChange(option)}
          >
            {labels[option]}
          </button>
        ))}
      </div>
    </div>
  );
}

function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <div className="popover__row">
      <span className="popover__label">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className="toggle"
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// Anchored to the icon that opened it, closed by Esc or a click outside; every change applies
// at once, so there is nothing to save.
export function BoardDisplayPopover(props: BoardDisplayPopoverProps) {
  const { theme, onTheme, prefs, onPrefs, onClose } = props;
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || !ref.current) return;
      if (ref.current.contains(target)) return;
      // The icon that opens the popover also closes it, so a click there is left to its own handler.
      if (target instanceof Element && target.closest('[aria-label="Board and display settings"]'))
        return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [onClose]);

  return (
    <section className="popover board-display" aria-label="Board and display" ref={ref}>
      <header className="popover__head">
        <span className="popover__title">Board &amp; display</span>
        <button
          type="button"
          className="icon-button icon-button--quiet"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <Icon>
            <path d="M4 4l8 8M12 4l-8 8" />
          </Icon>
        </button>
      </header>
      <div className="popover__body">
        <fieldset className="popover__themes">
          <legend className="popover__label">Board theme</legend>
          <div className="swatches">
            {BOARD_THEMES.map((option) => (
              <label key={option.id} className="swatch-choice" data-selected={option.id === theme}>
                <input
                  type="radio"
                  name="board-theme"
                  value={option.id}
                  checked={option.id === theme}
                  onChange={() => onTheme(option.id)}
                />
                <span className="swatch" data-board={option.id} aria-hidden="true">
                  <span className="swatch__light" />
                  <span className="swatch__dark" />
                </span>
                <span className="swatch-choice__name">{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Segmented
          label="Coordinates"
          options={COORDINATE_OPTIONS}
          labels={COORDINATE_LABEL}
          value={prefs.coordinates}
          onChange={(coordinates) => onPrefs({ coordinates })}
        />
        <Segmented
          label="Piece animation"
          options={ANIMATION_OPTIONS}
          labels={ANIMATION_LABEL}
          value={prefs.animation}
          onChange={(animation) => onPrefs({ animation })}
        />
        <hr className="popover__rule" />
        <Switch
          label="Highlight last move"
          checked={prefs.lastMove}
          onChange={(lastMove) => onPrefs({ lastMove })}
        />
        <Switch
          label="Show legal moves"
          checked={prefs.legalMoves}
          onChange={(legalMoves) => onPrefs({ legalMoves })}
        />
        <Switch
          label="Jump to next puzzle automatically"
          checked={prefs.autoNext}
          onChange={(autoNext) => onPrefs({ autoNext })}
        />
      </div>
      <footer className="popover__foot">{"← → moves · f flip · h hint · space next"}</footer>
    </section>
  );
}
