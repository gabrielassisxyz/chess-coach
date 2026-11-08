import {
  DEFAULT_ANALYSIS_DEPTH,
  MAX_ANALYSIS_DEPTH,
  MAX_ANALYSIS_LINES,
  MIN_ANALYSIS_DEPTH,
} from "@chess-coach/shared";
import { useCallback, useState } from "react";

// The engine strip's settings: whether the student wants the engine once an item ended, how many
// lines it shows and how deep it looks. Stored per browser like the board preferences.
export interface EnginePrefs {
  on: boolean;
  lines: number;
  depth: number;
}

export const DEFAULT_ENGINE_PREFS: EnginePrefs = {
  on: false,
  lines: 1,
  depth: DEFAULT_ANALYSIS_DEPTH,
};

export const ENGINE_PREFS_STORAGE_KEY = "chess-coach.engine-prefs";

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function readEnginePrefs(): EnginePrefs {
  try {
    const raw = window.localStorage.getItem(ENGINE_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_ENGINE_PREFS;
    const stored = JSON.parse(raw) as Partial<Record<keyof EnginePrefs, unknown>>;
    return {
      on: typeof stored.on === "boolean" ? stored.on : DEFAULT_ENGINE_PREFS.on,
      lines: clampInt(stored.lines, 1, MAX_ANALYSIS_LINES, DEFAULT_ENGINE_PREFS.lines),
      depth: clampInt(
        stored.depth,
        MIN_ANALYSIS_DEPTH,
        MAX_ANALYSIS_DEPTH,
        DEFAULT_ENGINE_PREFS.depth,
      ),
    };
  } catch {
    return DEFAULT_ENGINE_PREFS;
  }
}

function storeEnginePrefs(prefs: EnginePrefs): void {
  try {
    window.localStorage.setItem(ENGINE_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be refused (private mode); the choice then lasts for the session only.
  }
}

export function useEnginePrefs(): {
  prefs: EnginePrefs;
  set(change: Partial<EnginePrefs>): void;
} {
  const [prefs, setPrefs] = useState<EnginePrefs>(readEnginePrefs);
  const set = useCallback((change: Partial<EnginePrefs>): void => {
    setPrefs((current) => {
      const next = { ...current, ...change };
      storeEnginePrefs(next);
      return next;
    });
  }, []);
  return { prefs, set };
}
