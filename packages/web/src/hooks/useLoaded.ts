import { useCallback, useEffect, useState } from "react";

export type Loaded<T> =
  | { status: "loading" }
  | { status: "failed"; retry(): void }
  | { status: "ready"; value: T };

// Loads once per fetcher; a failure carries a retry that returns to loading and calls it again.
export function useLoaded<T>(fetcher: () => Promise<T>): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback((): void => {
    setLoaded({ status: "loading" });
    setAttempt((count) => count + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger
  useEffect(() => {
    let live = true;
    fetcher().then(
      (value) => live && setLoaded({ status: "ready", value }),
      () => live && setLoaded({ status: "failed", retry }),
    );
    return () => {
      live = false;
    };
  }, [fetcher, attempt, retry]);
  return loaded;
}
