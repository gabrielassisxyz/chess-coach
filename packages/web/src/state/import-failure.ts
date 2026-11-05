import type { ImportResult } from "@chess-coach/shared";
import { useCallback, useState } from "react";
import type { ImportApi } from "./import-api.js";

export interface ImportFailure {
  username: string;
  saved: number;
  failed: { id: string; message: string }[];
}

export function failureOf(username: string, result: ImportResult): ImportFailure | null {
  if (!result.failed || result.failed.length === 0) return null;
  return { username, saved: result.imported + result.skipped, failed: result.failed };
}

export interface FailureCard {
  failure: ImportFailure | null;
  busy: boolean;
  error: string | null;
  report(username: string, result: ImportResult): void;
  retry(): void;
  dismiss(): void;
}

/** The partial-import card: what was saved, and a retry that fetches only the games that failed. */
export function useImportFailure(api: ImportApi, onChanged: () => void): FailureCard {
  const [failure, setFailure] = useState<ImportFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback((username: string, result: ImportResult): void => {
    setError(null);
    setFailure(failureOf(username, result));
  }, []);

  const retry = (): void => {
    if (!failure || busy) return;
    setBusy(true);
    setError(null);
    api
      .importChessCom(
        failure.username,
        failure.failed.map((game) => game.id),
      )
      .then(
        (result) => {
          setBusy(false);
          setFailure(
            failureOf(failure.username, {
              ...result,
              imported: result.imported + failure.saved,
              skipped: result.skipped,
            }),
          );
          onChanged();
        },
        (reason: unknown) => {
          setBusy(false);
          setError(reason instanceof Error ? reason.message : "That did not work.");
        },
      );
  };

  return { failure, busy, error, report, retry, dismiss: () => setFailure(null) };
}
