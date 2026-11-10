import { MAX_ANALYSIS_DEPTH, MAX_ANALYSIS_LINES, MIN_ANALYSIS_DEPTH } from "@chess-coach/shared";
import { type ReactNode, useEffect, useRef } from "react";
import type { EngineView } from "../hooks/useEngineAnalysis.js";

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

export interface EngineStripProps {
  engine: EngineView;
  settingsOpen: boolean;
  onToggleSettings(): void;
  onCloseSettings(): void;
}

// The engine's row in the puzzle column: the switch, what it is doing, the first line's score,
// and the gear for its settings. Off while the item is open, by the server's rule as much as ours.
export function EngineStrip({
  engine,
  settingsOpen,
  onToggleSettings,
  onCloseSettings,
}: EngineStripProps) {
  return (
    <>
      <div className="practice-item__engine">
        <button
          type="button"
          role="switch"
          aria-checked={engine.on}
          aria-label="Engine"
          className="toggle"
          disabled={!engine.enabled}
          title={engine.enabled ? undefined : "Available after solving"}
          onClick={engine.toggle}
        />
        <span>{engine.label}</span>
        {engine.evalText !== null ? (
          <span
            className="practice-item__eval"
            data-tone={engine.evalTone}
            data-testid="engine-eval"
          >
            {engine.evalText}
          </span>
        ) : null}
        <button
          type="button"
          className="icon-button icon-button--quiet"
          aria-label="Engine settings"
          title="Engine settings"
          aria-expanded={settingsOpen}
          onClick={onToggleSettings}
        >
          <Icon>
            <path d="M2 4h12M2 8h12M2 12h12" />
            <circle cx="5.5" cy="4" r="1.6" fill="var(--surface-1)" />
            <circle cx="10.5" cy="8" r="1.6" fill="var(--surface-1)" />
            <circle cx="7" cy="12" r="1.6" fill="var(--surface-1)" />
          </Icon>
        </button>
      </div>
      {settingsOpen ? <EnginePopover engine={engine} onClose={onCloseSettings} /> : null}
    </>
  );
}

function Slider({
  label,
  min,
  max,
  value,
  text,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  text: string;
  onChange(value: number): void;
}) {
  return (
    <div className="popover__row engine-popover__row">
      <span className="popover__label">{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="engine-popover__value">{text}</span>
    </div>
  );
}

// Anchored under the strip, closed by Esc or a click outside; a change re-runs the engine at once.
function EnginePopover({ engine, onClose }: { engine: EngineView; onClose(): void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || !ref.current || ref.current.contains(target)) return;
      if (target instanceof Element && target.closest('[aria-label="Engine settings"]')) return;
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
    <section className="popover engine-popover" aria-label="Engine" ref={ref}>
      <header className="popover__head">
        <span className="popover__title">Engine</span>
        <span className="popover__state">{engine.on ? "on · local" : "off"}</span>
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
        <Slider
          label="Lines"
          min={1}
          max={MAX_ANALYSIS_LINES}
          value={engine.prefs.lines}
          text={`${engine.prefs.lines} / ${MAX_ANALYSIS_LINES}`}
          onChange={(lines) => engine.setPrefs({ lines })}
        />
        <Slider
          label="Depth"
          min={MIN_ANALYSIS_DEPTH}
          max={MAX_ANALYSIS_DEPTH}
          value={engine.prefs.depth}
          text={String(engine.prefs.depth)}
          onChange={(depth) => engine.setPrefs({ depth })}
        />
        <p className="popover__note">
          Runs on this machine with the server&apos;s Stockfish. During a puzzle the engine stays
          off until you solve it or view the solution.
        </p>
      </div>
    </section>
  );
}
