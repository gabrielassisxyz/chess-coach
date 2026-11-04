import type { ChessComListedGame, ImportStatus } from "@chess-coach/shared";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { type ImportApi, serverImportApi } from "../state/import-api.js";

export const STATUS_POLL_MS = 2000;

export interface ImportPanelProps {
  api?: ImportApi;
  pollMs?: number;
  /** Called when games were added or finished grading, so the list can refresh. */
  onChanged(): void;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function progressText(status: ImportStatus | null): string | null {
  if (!status) return null;
  if (status.running) {
    const { graded_plies: done, total_plies: total } = status.running;
    return `Grading a game: ${done} of ${total} moves${status.pending > 0 ? `, ${status.pending} more waiting` : ""}.`;
  }
  if (status.pending > 0) return `${status.pending} games waiting to be graded.`;
  return status.failed > 0 ? `${status.failed} games could not be graded.` : null;
}

function useGradingStatus(api: ImportApi, pollMs: number, onChanged: () => void) {
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

export function ImportPanel({
  api = serverImportApi,
  pollMs = STATUS_POLL_MS,
  onChanged,
}: ImportPanelProps) {
  const [username, setUsername] = useState("");
  const [from, setFrom] = useState(currentMonth());
  const [to, setTo] = useState(currentMonth());
  const [games, setGames] = useState<ChessComListedGame[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pgn, setPgn] = useState("");
  const [pgnColor, setPgnColor] = useState<"" | "white" | "black">("");
  const [message, setMessage] = useState<string | null>(null);
  const { status, refresh } = useGradingStatus(api, pollMs, onChanged);

  const run = useCallback(async (work: () => Promise<string>): Promise<void> => {
    setMessage(null);
    try {
      setMessage(await work());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That did not work.");
    }
  }, []);

  const list = (event: FormEvent): void => {
    event.preventDefault();
    void run(async () => {
      const found = await api.listChessCom(username, from, to);
      setGames(found);
      setPicked(new Set());
      return found.length === 0 ? "No games in those months." : `${found.length} games found.`;
    });
  };

  const importPicked = (): void => {
    void run(async () => {
      const result = await api.importChessCom(username, [...picked]);
      setGames(await api.listChessCom(username, from, to));
      setPicked(new Set());
      onChanged();
      refresh();
      const failed = result.failed?.length ?? 0;
      return `Imported ${result.imported}, skipped ${result.skipped}${failed > 0 ? `, ${failed} unreadable` : ""}.`;
    });
  };

  const importPasted = (event: FormEvent): void => {
    event.preventDefault();
    void run(async () => {
      const result = await api.importPgn(pgn, pgnColor === "" ? null : pgnColor);
      onChanged();
      refresh();
      return result.imported === 1 ? "Imported the game." : "That game was already imported.";
    });
  };

  const toggle = (uuid: string): void => {
    const next = new Set(picked);
    if (!next.delete(uuid)) next.add(uuid);
    setPicked(next);
  };

  const progress = progressText(status);
  return (
    <section className="import" aria-label="Import games">
      <h3 className="import__title">Import from Chess.com</h3>
      <form className="import__form" onSubmit={list}>
        <label>
          Username
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          From
          <input
            className="input"
            type="month"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          To
          <input
            className="input"
            type="month"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button type="submit" className="button" disabled={username.trim() === ""}>
          List games
        </button>
      </form>
      {games.length > 0 ? (
        <>
          <ul className="import__games" aria-label="Chess.com games">
            {games.map((game) => (
              <li key={game.uuid}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.has(game.uuid)}
                    disabled={game.already_imported}
                    onChange={() => toggle(game.uuid)}
                  />
                  {`${game.played_at.slice(0, 10)}, ${game.student_color} vs ${game.opponent}, ${game.result ?? "no result"}${game.already_imported ? ", imported" : ""}`}
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="button"
            disabled={picked.size === 0}
            onClick={importPicked}
          >
            Import selected
          </button>
        </>
      ) : null}
      <form className="import__form" onSubmit={importPasted}>
        <label>
          Paste a PGN
          <textarea
            className="input"
            rows={4}
            value={pgn}
            onChange={(e) => setPgn(e.target.value)}
          />
        </label>
        <label>
          You played
          <select
            className="input"
            value={pgnColor}
            onChange={(e) => setPgnColor(e.target.value as "" | "white" | "black")}
          >
            <option value="">detect from the names</option>
            <option value="white">white</option>
            <option value="black">black</option>
          </select>
        </label>
        <button type="submit" className="button" disabled={pgn.trim() === ""}>
          Import PGN
        </button>
      </form>
      {message ? (
        <p className="screen__note" role="status">
          {message}
        </p>
      ) : null}
      {progress ? (
        <p className="screen__note" role="status" data-testid="import-progress">
          {progress}
        </p>
      ) : null}
    </section>
  );
}
