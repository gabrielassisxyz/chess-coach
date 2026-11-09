import type { ConnectionsStatus } from "@chess-coach/shared";
import { type FormEvent, useEffect, useState } from "react";
import { type ConnectionsApi, serverConnectionsApi } from "../state/connections-api.js";

export interface ConnectionsPanelProps {
  api?: ConnectionsApi;
  /** Called after a connection was saved or removed. */
  onChanged?(): void;
}

export function ConnectionsPanel({ api = serverConnectionsApi, onChanged }: ConnectionsPanelProps) {
  const [status, setStatus] = useState<ConnectionsStatus | null>(null);
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.get().then(
      (loaded) => {
        if (!live) return;
        setStatus(loaded);
        // Only an empty field is filled: the answer can arrive after the student started typing.
        setUsername((typed) => (typed === "" ? (loaded.chesscom_username ?? "") : typed));
      },
      () => {
        if (live) setMessage("The saved connections could not be loaded. Reload to try again.");
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  const apply = async (work: () => Promise<ConnectionsStatus>): Promise<boolean> => {
    setMessage(null);
    try {
      setStatus(await work());
      onChanged?.();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That did not work.");
      return false;
    }
  };

  const saveToken = (event: FormEvent): void => {
    event.preventDefault();
    void apply(() => api.saveLichessToken(token.trim())).then((saved) => {
      if (saved) setToken("");
    });
  };

  const saveAccount = (event: FormEvent): void => {
    event.preventDefault();
    void apply(() => api.saveChessComUsername(username.trim()));
  };

  const removeAccount = (): void => {
    void apply(() => api.removeChessComUsername()).then((removed) => {
      if (removed) setUsername("");
    });
  };

  const tokenSet = status?.lichess_token_set === true;
  const accountSet = status !== null && status.chesscom_username !== null;
  return (
    <section className="import" aria-label="Connections">
      <h3 className="import__title">Connections</h3>
      <form className="import__form" onSubmit={saveToken}>
        <label>
          Lichess API token
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <button type="submit" className="button" disabled={token.trim() === ""}>
          {tokenSet ? "Replace token" : "Save token"}
        </button>
        {tokenSet ? (
          <button
            type="button"
            className="button"
            onClick={() => void apply(() => api.removeLichessToken())}
          >
            Remove token
          </button>
        ) : null}
      </form>
      {status === null ? null : (
        <p className="screen__note">
          {tokenSet
            ? "A token is saved."
            : "No token saved. The opening drills from the Lichess explorer need one, with no scopes."}
        </p>
      )}
      <form className="import__form" onSubmit={saveAccount}>
        <label>
          Chess.com username
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <button type="submit" className="button" disabled={username.trim() === ""}>
          Save account
        </button>
        {accountSet ? (
          <button type="button" className="button" onClick={removeAccount}>
            Remove account
          </button>
        ) : null}
      </form>
      {message ? (
        <p className="screen__note" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
