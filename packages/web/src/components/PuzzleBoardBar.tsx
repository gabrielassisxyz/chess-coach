import type { ReactNode } from "react";

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

export interface PuzzleBoardBarProps {
  atStart: boolean;
  atEnd: boolean;
  onFirst(): void;
  onPrevious(): void;
  onNext(): void;
  onLast(): void;
  // Free moves on the board: exploration while the item is open, analysis after it ended.
  scratch: boolean;
  onToggleScratch(): void;
  onFlip(): void;
  settingsOpen: boolean;
  onToggleSettings(): void;
}

// The bar under the board: stepping through the item's moves, free moves, flip and the board
// settings, all within reach of the hand that just moved a piece.
export function PuzzleBoardBar(props: PuzzleBoardBarProps) {
  return (
    <div className="board-bar">
      <div className="board-bar__steps">
        <button
          type="button"
          className="icon-button board-bar__step"
          aria-label="First move"
          title="First move"
          disabled={props.atStart}
          onClick={props.onFirst}
        >
          <Icon>
            <path d="M4 3v10M12 3L6.5 8l5.5 5" />
          </Icon>
        </button>
        <button
          type="button"
          className="icon-button board-bar__step"
          aria-label="Previous move"
          title="Previous move"
          disabled={props.atStart}
          onClick={props.onPrevious}
        >
          <Icon>
            <path d="M10 3L5 8l5 5" />
          </Icon>
        </button>
        <button
          type="button"
          className="icon-button board-bar__step"
          aria-label="Next move"
          title="Next move"
          disabled={props.atEnd}
          onClick={props.onNext}
        >
          <Icon>
            <path d="M6 3l5 5-5 5" />
          </Icon>
        </button>
        <button
          type="button"
          className="icon-button board-bar__step"
          aria-label="Last move"
          title="Last move"
          disabled={props.atEnd}
          onClick={props.onLast}
        >
          <Icon>
            <path d="M12 3v10M4 3l5.5 5L4 13" />
          </Icon>
        </button>
      </div>
      <span className="board-bar__hint" aria-hidden="true">
        {"← → to step through"}
      </span>
      <div className="board-bar__actions">
        <button
          type="button"
          className="button board-bar__scratch"
          aria-pressed={props.scratch}
          onClick={props.onToggleScratch}
        >
          <Icon>
            <path d="M3 13l3.5-3.5M13 3l-3.5 3.5M9.5 6.5l-3 3M6.5 9.5L3 13M13 3l-2 4-2-2 4-2z" />
          </Icon>
          Explore
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Flip board"
          title="Flip board"
          onClick={props.onFlip}
        >
          <Icon>
            <path d="M3 5.5h9.5L10 3M13 10.5H3.5L6 13" />
          </Icon>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Board and display settings"
          title="Board and display settings"
          aria-expanded={props.settingsOpen}
          onClick={props.onToggleSettings}
        >
          <Icon>
            <path d="M2 4h12M2 8h12M2 12h12" />
            <circle cx="5.5" cy="4" r="1.6" fill="var(--surface-0)" />
            <circle cx="10.5" cy="8" r="1.6" fill="var(--surface-0)" />
            <circle cx="7" cy="12" r="1.6" fill="var(--surface-0)" />
          </Icon>
        </button>
      </div>
    </div>
  );
}
