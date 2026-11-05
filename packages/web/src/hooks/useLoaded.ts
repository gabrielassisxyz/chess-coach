import { useEffect, useState } from "react";

export type Loaded<T> =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; value: T };

// Loads once per fetcher; a failure is a state the screen words, never a throw.
export function useLoaded<T>(fetcher: () => Promise<T>): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ status: "loading" });
  useEffect(() => {
    let live = true;
    fetcher().then(
      (value) => live && setLoaded({ status: "ready", value }),
      () => live && setLoaded({ status: "failed" }),
    );
    return () => {
      live = false;
    };
  }, [fetcher]);
  return loaded;
}
