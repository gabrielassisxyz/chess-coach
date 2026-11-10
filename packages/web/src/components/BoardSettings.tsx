import { BOARD_THEMES, type BoardTheme } from "../state/board-theme.js";

export interface BoardSettingsToggleProps {
  open: boolean;
  onToggle(): void;
}

export function BoardSettingsToggle({ open, onToggle }: BoardSettingsToggleProps) {
  return (
    <button
      type="button"
      className="icon-button board-gear"
      aria-label="Board settings"
      title="Board settings"
      aria-expanded={open}
      onClick={onToggle}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="2.25" />
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
      </svg>
    </button>
  );
}

export interface BoardSettingsPanelProps {
  theme: BoardTheme;
  onChoose(theme: BoardTheme): void;
  onClose(): void;
}

export function BoardSettingsPanel({ theme, onChoose, onClose }: BoardSettingsPanelProps) {
  return (
    <section className="board-settings" aria-label="Board settings">
      <fieldset className="board-settings__themes">
        <legend>Board theme</legend>
        {BOARD_THEMES.map((option) => (
          <label key={option.id} className="board-settings__option">
            <input
              type="radio"
              name="board-theme"
              value={option.id}
              checked={theme === option.id}
              onChange={() => onChoose(option.id)}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <button type="button" className="button" onClick={onClose}>
        Done
      </button>
    </section>
  );
}
