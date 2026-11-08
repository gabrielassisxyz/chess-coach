import { useEffect, useState } from "react";
import { elapsedSince } from "../state/practice.js";

// The server stamps when an item was served; the clock only has to redraw once a second. Once
// the item ends the reading freezes at that moment, so the card reports the time the item took.
export function useElapsed(servedAt: string, running: boolean): number {
  const [, tick] = useState(0);
  const [frozen, setFrozen] = useState<{ servedAt: string; ms: number } | null>(null);
  useEffect(() => {
    if (running) {
      setFrozen(null);
      const timer = setInterval(() => tick((count) => count + 1), 1000);
      return () => clearInterval(timer);
    }
    setFrozen((current) =>
      current?.servedAt === servedAt
        ? current
        : { servedAt, ms: elapsedSince(servedAt, Date.now()) },
    );
    return undefined;
  }, [running, servedAt]);
  if (!running && frozen?.servedAt === servedAt) return frozen.ms;
  return elapsedSince(servedAt, Date.now());
}
