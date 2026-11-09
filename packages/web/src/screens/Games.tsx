import type { GameDetail, GameSummary } from "@chess-coach/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BoardFactory } from "../components/Board.js";
import { ConnectionsPanel } from "../components/ConnectionsPanel.js";
import { GamesTable } from "../components/GamesTable.js";
import { ImportFailureCard } from "../components/ImportFailureCard.js";
import { ImportPanel } from "../components/ImportPanel.js";
import { OpenGame } from "../components/OpenGame.js";
import type { ServerApi } from "../hooks/useServer.js";
import { type ConnectionsApi, serverConnectionsApi } from "../state/connections-api.js";
import {
  filterGames,
  gradingCount,
  type ResultFilter,
  type SourceFilter,
  sourceCounts,
  totalsOf,
} from "../state/games.js";
import { type GamesApi, serverGamesApi } from "../state/games-api.js";
import { STATUS_POLL_MS, useGradingStatus } from "../state/grading-status.js";
import { type ImportApi, serverImportApi } from "../state/import-api.js";
import { useImportFailure } from "../state/import-failure.js";

export interface GamesProps {
  server: ServerApi;
  api?: GamesApi;
  importApi?: ImportApi;
  connectionsApi?: ConnectionsApi;
  createBoard?: BoardFactory | undefined;
  pollMs?: number;
  /** "Start a coached game" on the empty screen. */
  onOpenPlay?(): void;
  /** Words for the coach panel's idle state while a game is open; null puts the default back. */
  onCoachIdle?(label: string | null): void;
}

type Listing =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; games: GameSummary[] };

function useGameList(api: GamesApi): { listing: Listing; reload(): void; retry(): void } {
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger
  useEffect(() => {
    let current = true;
    api.listGames().then(
      (games) => current && setListing({ status: "ready", games }),
      () => current && setListing({ status: "failed" }),
    );
    return () => {
      current = false;
    };
  }, [api, attempt]);
  // A refresh after an import keeps the table on screen; only a retry after a failure blanks it.
  const reload = useCallback((): void => setAttempt((count) => count + 1), []);
  const retry = (): void => {
    setListing({ status: "loading" });
    reload();
  };
  return { listing, reload, retry };
}

const SOURCE_TABS: { id: SourceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "coach", label: "Coached" },
  { id: "chesscom", label: "Chess.com" },
  { id: "lichess", label: "Lichess" },
  { id: "pgn", label: "PGN" },
];

const RESULT_TABS: { id: ResultFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
  { id: "drawn", label: "Drawn" },
];

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: { id: T; text: string }[];
  onChange(id: T): void;
}

function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>) {
  return (
    <fieldset className="games__segmented" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="games__segment"
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
        >
          {option.text}
        </button>
      ))}
    </fieldset>
  );
}

function gradingText(count: number): string {
  return `Grading ${count} ${count === 1 ? "game" : "games"}…`;
}

export function Games({
  server,
  api = serverGamesApi,
  importApi = serverImportApi,
  connectionsApi = serverConnectionsApi,
  createBoard,
  pollMs = STATUS_POLL_MS,
  onOpenPlay,
  onCoachIdle,
}: GamesProps) {
  const { listing, reload, retry } = useGameList(api);
  const [game, setGame] = useState<GameDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState<SourceFilter>("all");
  const [result, setResult] = useState<ResultFilter>("all");
  const [importing, setImporting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const { send } = server;

  const grading = useGradingStatus(importApi, pollMs, reload);
  const changed = (): void => {
    reload();
    grading.refresh();
  };
  const card = useImportFailure(importApi, changed);

  const open = useCallback(
    (id: number): void => {
      setFailed(false);
      api.getGame(id).then(
        (detail) => {
          setGame(detail);
          send({ type: "open_game", game_id: id });
        },
        () => setFailed(true),
      );
    },
    [api, send],
  );

  const games = listing.status === "ready" ? listing.games : [];
  const shown = useMemo(() => filterGames(games, source, result), [games, source, result]);
  const counts = useMemo(() => sourceCounts(games), [games]);

  if (game) {
    return (
      <OpenGame
        key={game.id}
        server={server}
        game={game}
        summary={games.find((entry) => entry.id === game.id)}
        createBoard={createBoard}
        onClose={() => setGame(null)}
        {...(onCoachIdle ? { onCoachIdle } : {})}
      />
    );
  }

  const queued = gradingCount(grading.status);
  const gradingFailures = grading.status?.failed ?? 0;
  const panel = (
    <ImportPanel
      api={importApi}
      connections={connectionsApi}
      connectionRevision={connectionRevision}
      onChanged={changed}
      onImported={card.report}
    />
  );
  const connectionsPanel = (
    <ConnectionsPanel
      api={connectionsApi}
      onChanged={() => setConnectionRevision((revision) => revision + 1)}
    />
  );

  return (
    <section className="screen screen--wide games" aria-label="Games">
      <div className="games__top">
        <h2 className="screen__title">Games</h2>
        {listing.status === "ready" && games.length > 0 ? (
          <>
            <Segmented<SourceFilter>
              label="Source"
              value={source}
              options={SOURCE_TABS.filter((tab) => tab.id === "all" || counts[tab.id] > 0).map(
                (tab) => ({ id: tab.id, text: `${tab.label} · ${counts[tab.id]}` }),
              )}
              onChange={setSource}
            />
            <Segmented<ResultFilter>
              label="Result"
              value={result}
              options={RESULT_TABS.map((tab) => ({ id: tab.id, text: tab.label }))}
              onChange={setResult}
            />
            <span className="games__grading" role="status">
              {queued > 0
                ? gradingText(queued)
                : gradingFailures > 0
                  ? `${gradingFailures} games could not be graded.`
                  : ""}
            </span>
            <button
              type="button"
              className="button"
              aria-expanded={importing}
              onClick={() => setImporting(!importing)}
            >
              Import from Chess.com…
            </button>
            <button
              type="button"
              className="button"
              aria-expanded={connecting}
              onClick={() => setConnecting(!connecting)}
            >
              Connections…
            </button>
          </>
        ) : null}
      </div>
      {failed ? (
        <p className="screen__note" role="alert">
          That game could not be loaded. Try it again, or pick another game.
        </p>
      ) : null}
      <ImportFailureCard card={card} />
      {listing.status === "loading" ? (
        <p className="screen__note" role="status">
          Loading games.
        </p>
      ) : null}
      {listing.status === "failed" ? (
        <div className="games__empty" role="alert">
          <p className="screen__note">
            The games could not be loaded. Check that the server is running, then try again.
          </p>
          <button type="button" className="button" onClick={retry}>
            Try again
          </button>
        </div>
      ) : null}
      {listing.status === "ready" && games.length === 0 ? connectionsPanel : null}
      {listing.status === "ready" && games.length === 0 ? (
        <div className="games__first">
          {panel}
          <section className="games__play" aria-label="Play a coached game">
            <h3 className="import__title">Or play one here</h3>
            <p className="screen__note">
              A coached game against Stockfish appears in this list the moment it ends, already
              graded.
            </p>
            {onOpenPlay ? (
              <button type="button" className="button button--primary" onClick={onOpenPlay}>
                Start a coached game →
              </button>
            ) : null}
          </section>
        </div>
      ) : null}
      {listing.status === "ready" && games.length > 0 ? (
        <>
          {importing ? panel : null}
          {connecting ? connectionsPanel : null}
          {shown.length === 0 ? (
            <p className="screen__note">No games match these filters.</p>
          ) : (
            <GamesTable games={shown} totals={totalsOf(shown)} onOpen={open} />
          )}
        </>
      ) : null}
    </section>
  );
}
