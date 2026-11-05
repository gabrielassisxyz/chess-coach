import type { ImportStatus } from "@chess-coach/shared";
import { useEffect, useRef, useState } from "react";
import type { ImportApi } from "./import-api.js";

export const STATUS_POLL_MS = 2000;

export interface GradingStatus {
  status: ImportStatus | null;
  refresh(): void;
}

/** Polls the grading queue while it has work, and calls `onChanged` once when it drains. */
export function useGradingStatus(
  api: ImportApi,
  pollMs: number,
  onChanged: () => void,
): GradingStatus {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [tick, setTick] = useState(0);
  const wasBusy = useRef(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the refresh trigger
  useEffect(() => {
    let current = true;
    api.status().then(
      (next) => {
        if (!current) return;
        const busy = next.pending > 0 || next.running !== null;
        if (wasBusy.current && !busy) changed.current();
        wasBusy.current = busy;
        setStatus(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [api, tick]);

  const busy = status !== null && (status.pending > 0 || status.running !== null);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setTick((count) => count + 1), pollMs);
    return () => clearInterval(timer);
  }, [busy, pollMs]);

  return { status, refresh: () => setTick((count) => count + 1) };
}
