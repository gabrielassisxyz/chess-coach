import type { GameDetail, GameSummary } from "@chess-coach/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Board, type BoardFactory } from "../components/Board.js";
import { ImportPanel } from "../components/ImportPanel.js";
import { ReviewMoves } from "../components/ReviewMoves.js";
import type { ServerApi } from "../hooks/useServer.js";
import { type GamesApi, serverGamesApi } from "../state/games-api.js";
import { type ImportApi, serverImportApi } from "../state/import-api.js";
import { CLASSIFICATION_LABEL } from "../state/play.js";
import {
  localReviewState,
  moveAt,
  plyCount,
  SELECT_DEBOUNCE_MS,
  stepTarget,
  summaryLabel,
  takesTyping,
} from "../state/review.js";

export interface ReviewProps {
  server: ServerApi;
  api?: GamesApi;
  importApi?: ImportApi;
  createBoard?: BoardFactory | undefined;
}

type Listing =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; games: GameSummary[] };

function useGameList(api: GamesApi): { listing: Listing; reload(): void } {
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
  const reload = (): void => {
    setListing({ status: "loading" });
    setAttempt((count) => count + 1);
  };
  return { listing, reload };
}

interface GameListProps {
  listing: Listing;
  onOpen(id: number): void;
  onRetry(): void;
}

function GameList({ listing, onOpen, onRetry }: GameListProps) {
  if (listing.status === "loading") {
    return (
      <p className="screen__note" role="status">
        Loading games.
      </p>
    );
  }
  if (listing.status === "failed") {
    return (
      <div className="review__empty" role="alert">
        <p className="screen__note">
          The games could not be loaded. Check that the server is running, then try again.
        </p>
        <button type="button" className="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (listing.games.length === 0) {
    return (
      <p className="screen__note" role="status">
        No finished games yet. Finish a game on the Play screen and it will show up here.
      </p>
    );
  }
  return (
    <ul className="review__games" aria-label="Finished games">
      {listing.games.map((game) => (
        <li key={game.id}>
          <button type="button" className="review__game" onClick={() => onOpen(game.id)}>
            {summaryLabel(game)}
          </button>
        </li>
      ))}
    </ul>
  );
}

function PlyDetail({ game, ply }: { game: GameDetail; ply: number }) {
  const move = moveAt(game, ply);
  if (!move) return <p className="review__detail">Starting position.</p>;
  const grade = move.classification ? CLASSIFICATION_LABEL[move.classification] : null;
  return (
    <p className="review__detail" data-testid="ply-detail">
      <strong>{`${Math.ceil(ply / 2)}${ply % 2 === 1 ? "." : "..."} ${move.san}`}</strong>
      {grade && move.cp_loss !== null ? `, ${grade}, cp loss ${move.cp_loss}` : ""}
      {move.best_move_san && move.cp_loss ? `, best was ${move.best_move_san}` : ""}
    </p>
  );
}

interface OpenGameProps {
  server: ServerApi;
  game: GameDetail;
  createBoard: BoardFactory | undefined;
  onClose(): void;
}

function OpenGame({ server, game, createBoard, onClose }: OpenGameProps) {
  const [ply, setPly] = useState(0);
  const count = plyCount(game);
  const demo = server.activity?.kind === "demo" ? server.activity : null;
  const serverActivityId = server.activity?.activity_id ?? 1;

  const sendRef = useRef(server.send);
  sendRef.current = server.send;
  const synced = useRef(0);

  // The server learns the selection a beat after the student stops, so a held arrow key costs one
  // command, and the coach's get_game agrees with the board once it settles.
  useEffect(() => {
    if (demo || ply === synced.current) return;
    const timer = setTimeout(() => {
      const sent = sendRef.current({ type: "select_review_ply", game_id: game.id, ply });
      if (sent) synced.current = ply;
    }, SELECT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [ply, game.id, demo]);

  useEffect(() => {
    if (demo) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.altKey || event.metaKey || takesTyping(event.target)) return;
      const target = stepTarget(event.key, ply, count);
      if (target === null) return;
      event.preventDefault();
      setPly(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [demo, ply, count]);

  const local = useMemo(
    () => localReviewState(game, ply, serverActivityId),
    [game, ply, serverActivityId],
  );
  const created = server.cardsCreated[game.id];
  const connected = server.connection === "connected";

  return (
    <>
      <div className="review__bar">
        <button type="button" className="button" onClick={onClose}>
          All games
        </button>
        {demo ? (
          <button
            type="button"
            className="button button--primary"
            onClick={() => server.send({ type: "leave_demo", activity_id: demo.activity_id })}
          >
            Back to review
          </button>
        ) : null}
      </div>
      <Board activity={demo ?? local} onMove={() => {}} createBoard={createBoard} />
      <div className="review__bar">
        <button type="button" className="button" disabled={ply === 0} onClick={() => setPly(0)}>
          Start
        </button>
        <button
          type="button"
          className="button"
          disabled={ply === 0}
          onClick={() => setPly(ply - 1)}
        >
          Back
        </button>
        <button
          type="button"
          className="button"
          disabled={ply === count}
          onClick={() => setPly(ply + 1)}
        >
          Forward
        </button>
        <button
          type="button"
          className="button"
          disabled={ply === count}
          onClick={() => setPly(count)}
        >
          End
        </button>
      </div>
      <PlyDetail game={game} ply={ply} />
      <div className="review__bar">
        <button
          type="button"
          className="button"
          disabled={ply === 0 || !connected}
          onClick={() => server.send({ type: "ask_coach_about_ply", game_id: game.id, ply })}
        >
          Ask the coach about this move
        </button>
        <button
          type="button"
          className="button"
          disabled={created !== undefined || !connected}
          onClick={() => server.send({ type: "create_cards", game_id: game.id })}
        >
          {created === undefined ? "Create cards" : `${created} cards created`}
        </button>
      </div>
      <ReviewMoves moves={game.moves} selectedPly={ply} onSelect={setPly} />
    </>
  );
}

export function Review({
  server,
  api = serverGamesApi,
  importApi = serverImportApi,
  createBoard,
}: ReviewProps) {
  const { listing, reload } = useGameList(api);
  const [game, setGame] = useState<GameDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const { send } = server;

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

  return (
    <section className="screen review" aria-label="Review">
      <h2 className="screen__title">Review</h2>
      {failed ? (
        <p className="screen__note" role="alert">
          That game could not be loaded. Try it again, or pick another game.
        </p>
      ) : null}
      {game ? (
        <OpenGame
          key={game.id}
          server={server}
          game={game}
          createBoard={createBoard}
          onClose={() => setGame(null)}
        />
      ) : (
        <>
          <ImportPanel api={importApi} onChanged={reload} />
          <GameList listing={listing} onOpen={open} onRetry={reload} />
        </>
      )}
    </section>
  );
}
