import { useEffect, useState } from "react";
import { elapsedSince } from "../state/practice.js";

// The server stamps when an item was served; the clock only has to redraw once a second.
export function useElapsed(servedAt: string, running: boolean): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => tick((count) => count + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return elapsedSince(servedAt, Date.now());
}
