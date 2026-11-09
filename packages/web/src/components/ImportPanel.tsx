import type { ChessComListedGame, ImportResult } from "@chess-coach/shared";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type ConnectionsApi, serverConnectionsApi } from "../state/connections-api.js";
import { type TimeClass, timeClassOf } from "../state/games.js";
import { type ImportApi, serverImportApi } from "../state/import-api.js";

export interface ImportPanelProps {
  api?: ImportApi;
  connections?: ConnectionsApi;
  /** Changes when a connection was saved, so the account is read again without resetting the form. */
  connectionRevision?: number;
  /** Called when games were added, so the list and the grading queue can refresh. */
  onChanged(): void;
  /** Called with the result of a Chess.com import, so a partial one can be shown and retried. */
  onImported?(username: string, result: ImportResult): void;
}

const TIME_CLASSES: { id: TimeClass; label: string }[] = [
  { id: "rapid", label: "Rapid" },
  { id: "blitz", label: "Blitz" },
  { id: "bullet", label: "Bullet" },
  { id: "daily", label: "Daily" },
];

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

// A game whose time control the listing did not give stays visible rather than vanishing.
function wanted(game: ChessComListedGame, classes: Set<TimeClass>): boolean {
  const timeClass = timeClassOf(game.time_control);
  return timeClass === null || classes.has(timeClass);
}

export function ImportPanel({
  api = serverImportApi,
  connections = serverConnectionsApi,
  connectionRevision = 0,
  onChanged,
  onImported,
}: ImportPanelProps) {
  const [username, setUsername] = useState("");
  const [from, setFrom] = useState(currentMonth());
  const [to, setTo] = useState(currentMonth());
  const [games, setGames] = useState<ChessComListedGame[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pgn, setPgn] = useState("");
  const [pgnColor, setPgnColor] = useState<"" | "white" | "black">("");
  const [message, setMessage] = useState<string | null>(null);
  const [classes, setClasses] = useState<Set<TimeClass>>(new Set(["rapid", "blitz"]));

  // Only an empty field is filled: the answer can arrive after the student started typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision is what asks for a new read.
  useEffect(() => {
    let live = true;
    connections.get().then(
      ({ chesscom_username: saved }) => {
        if (live && saved !== null) setUsername((typed) => (typed === "" ? saved : typed));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [connections, connectionRevision]);

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
      const visible = found.filter((game) => wanted(game, classes)).length;
      return visible === 0 ? "No games in those months." : `${visible} games found.`;
    });
  };

  const importPicked = (): void => {
    void run(async () => {
      const result = await api.importChessCom(username, [...picked]);
      setGames(await api.listChessCom(username, from, to));
      setPicked(new Set());
      onChanged();
      onImported?.(username, result);
      const failed = result.failed?.length ?? 0;
      return `Imported ${result.imported}, skipped ${result.skipped}${failed > 0 ? `, ${failed} unreadable` : ""}.`;
    });
  };

  const importPasted = (event: FormEvent): void => {
    event.preventDefault();
    void run(async () => {
      const result = await api.importPgn(pgn, pgnColor === "" ? null : pgnColor);
      onChanged();
      return result.imported === 1 ? "Imported the game." : "That game was already imported.";
    });
  };

  const toggle = (uuid: string): void => {
    const next = new Set(picked);
    if (!next.delete(uuid)) next.add(uuid);
    setPicked(next);
  };

  const toggleClass = (id: TimeClass): void => {
    const next = new Set(classes);
    if (!next.delete(id)) next.add(id);
    setClasses(next);
  };

  const shown = games.filter((game) => wanted(game, classes));
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
        <fieldset className="import__classes">
          <legend>Time class</legend>
          {TIME_CLASSES.map((timeClass) => (
            <label key={timeClass.id}>
              <input
                type="checkbox"
                checked={classes.has(timeClass.id)}
                onChange={() => toggleClass(timeClass.id)}
              />
              {timeClass.label}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="button" disabled={username.trim() === ""}>
          Fetch games
        </button>
      </form>
      <p className="screen__note">
        Grading runs in the background, about 20 s per game. You can keep using the app.
      </p>
      {shown.length > 0 ? (
        <>
          <ul className="import__games" aria-label="Chess.com games">
            {shown.map((game) => (
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
    </section>
  );
}
