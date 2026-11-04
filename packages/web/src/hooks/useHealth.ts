import type { HealthResponse } from "@chess-coach/shared";
import { useCallback, useEffect, useState } from "react";

export type FetchHealth = () => Promise<HealthResponse>;

export const HEALTH_POLL_MS = 10_000;

async function fetchHealthFromServer(): Promise<HealthResponse> {
  const response = await fetch("/api/health");
  return (await response.json()) as HealthResponse;
}

export interface UseHealthOptions {
  fetchHealth?: FetchHealth;
  intervalMs?: number;
}

// The WebSocket carries no readiness, so the page asks. It polls only while the server is not
// ready, and asks again whenever `refreshToken` changes (the caller passes its error count, since
// an engine fault reaches the browser as a refused command). A failed request keeps the last answer.
export function useHealth(
  refreshToken: number,
  options: UseHealthOptions = {},
): HealthResponse | null {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const ready = health?.ready === true;
  const fetchHealth = options.fetchHealth ?? fetchHealthFromServer;
  const intervalMs = options.intervalMs ?? HEALTH_POLL_MS;

  const poll = useCallback(() => {
    fetchHealth().then(
      (answer) => setHealth(answer),
      () => {},
    );
  }, [fetchHealth]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken only exists to re-run this effect
  useEffect(poll, [poll, refreshToken]);

  useEffect(() => {
    if (ready) return;
    const timer = setInterval(poll, intervalMs);
    return () => clearInterval(timer);
  }, [ready, poll, intervalMs]);

  return health;
}
