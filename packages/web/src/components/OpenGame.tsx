import type { GameDetail, GameRepertoireReview, GameSummary } from "@chess-coach/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ServerApi } from "../hooks/useServer.js";
import {
  dateLabel,
  localReviewState,
  moveAt,
  opponentLabel,
  playedAt,
  plyCount,
  plyLabel,
  RESULT_GLYPH,
  repertoireMoveLabel,
  SELECT_DEBOUNCE_MS,
  SOURCE_TAG,
  stepTarget,
  takesTyping,
} from "../state/games.js";
import { CLASSIFICATION_LABEL, evalView } from "../state/play.js";
import { Board, type BoardFactory } from "./Board.js";
import { GameMoves } from "./GameMoves.js";

function PlyDetail({ game, ply }: { game: GameDetail; ply: number }) {
  const move = moveAt(game, ply);
  if (!move) return <p className="games__detail">Starting position.</p>;
  const grade = move.classification ? CLASSIFICATION_LABEL[move.classification] : null;
  return (
    <p className="games__detail" data-testid="ply-detail">
      <strong>{`${Math.ceil(ply / 2)}${ply % 2 === 1 ? "." : "..."} ${move.san}`}</strong>
      {grade && move.cp_loss !== null ? `, ${grade}, cp loss ${move.cp_loss}` : ""}
      {move.best_move_san && move.cp_loss ? `, best was ${move.best_move_san}` : ""}
    </p>
  );
}

function headline(game: GameDetail): string {
  const colour = game.player_color === "white" ? "White" : "Black";
  return `${colour} vs ${opponentLabel(game)}`;
}

function subline(game: GameDetail, summary: GameSummary | undefined): string {
  const parts = [SOURCE_TAG[game.source], dateLabel(playedAt(game))];
  if (game.result)
    parts.push(`${RESULT_GLYPH[game.result]} in ${Math.ceil(game.moves.length / 2)}`);
  if (summary && summary.accuracy !== null) {
    parts.push(`accuracy ${Math.round(summary.accuracy * 100)}%`);
  }
  return parts.join(" · ");
}

function mistakesLabel(count: number): string {
  return `Create cards from ${count} ${count === 1 ? "mistake" : "mistakes"}`;
}

interface RepertoireStripProps {
  gameId: number;
  review: GameRepertoireReview;
  onGoToPly(ply: number): void;
}

function RepertoireStrip({ gameId, review, onGoToPly }: RepertoireStripProps) {
  // Keying the reveal by game id hides the move on the same render when another game opens.
  const [revealedGameId, setRevealedGameId] = useState<number | null>(null);
  const revealed = revealedGameId === gameId;
  const title = `${review.group_name} · ${review.variation_name}`;
  const { left } = review;

  if (!left) {
    const moves = Math.ceil(review.followed_plies / 2);
    return (
      <section
        className="games__repertoire"
        aria-label="Repertoire review"
        data-testid="repertoire-review"
      >
        <p className="games__repertoire-title">{title}</p>
        <p className="games__repertoire-line">
          {`In your line for the first ${moves} ${moves === 1 ? "move" : "moves"}.`}
        </p>
      </section>
    );
  }

  const moveNumber = Math.ceil(left.ply / 2);

  if (left.by === "student") {
    return (
      <section
        className="games__repertoire"
        aria-label="Repertoire review"
        data-testid="repertoire-review"
      >
        <p className="games__repertoire-title">{title}</p>
        <p className="games__repertoire-line">{`You left your line at move ${moveNumber}.`}</p>
        <div className="games__repertoire-actions">
          <button type="button" className="button" onClick={() => onGoToPly(left.ply)}>
            {`Go to move ${moveNumber}`}
          </button>
          {left.line_san !== null ? (
            revealed ? (
              <div className="games__repertoire-reveal">
                <p className="games__repertoire-answer">
                  {`Your line plays ${repertoireMoveLabel(left.ply, left.line_san)}`}
                </p>
                {left.line_note ? <p className="games__repertoire-note">{left.line_note}</p> : null}
              </div>
            ) : (
              <button type="button" className="button" onClick={() => setRevealedGameId(gameId)}>
                Show my line's move
              </button>
            )
          ) : null}
        </div>
      </section>
    );
  }

  const repliesLine =
    left.stored_replies.length > 0
      ? `Your line answers ${left.stored_replies
          .map((san) => repertoireMoveLabel(left.ply, san))
          .join(", ")}.`
      : "Your line has no reply stored here.";

  return (
    <section
      className="games__repertoire"
      aria-label="Repertoire review"
      data-testid="repertoire-review"
    >
      <p className="games__repertoire-title">{title}</p>
      <p className="games__repertoire-line">
        {`Your opponent left your line at move ${moveNumber} with ${repertoireMoveLabel(left.ply, left.played_san)}.`}
      </p>
      <p className="games__repertoire-line">{repliesLine}</p>
      <div className="games__repertoire-actions">
        <button type="button" className="button" onClick={() => onGoToPly(left.ply)}>
          {`Go to move ${moveNumber}`}
        </button>
      </div>
    </section>
  );
}

interface StepsProps {
  ply: number;
  count: number;
  setPly(ply: number): void;
}

function Steps({ ply, count, setPly }: StepsProps) {
  const atStart = ply === 0;
  const atEnd = ply === count;
  return (
    <div className="games__bar games__steps">
      <button type="button" className="button" disabled={atStart} onClick={() => setPly(0)}>
        First
      </button>
      <button type="button" className="button" disabled={atStart} onClick={() => setPly(ply - 1)}>
        Previous
      </button>
      <button type="button" className="button" disabled={atEnd} onClick={() => setPly(ply + 1)}>
        Next
      </button>
      <button type="button" className="button" disabled={atEnd} onClick={() => setPly(count)}>
        Last
      </button>
    </div>
  );
}

export interface OpenGameProps {
  server: ServerApi;
  game: GameDetail;
  summary: GameSummary | undefined;
  createBoard: BoardFactory | undefined;
  // The ply the review opens at; a game from the list starts at 0.
  initialPly?: number | undefined;
  onClose(): void;
  onCoachIdle?(label: string | null): void;
}

export function OpenGame({
  server,
  game,
  summary,
  createBoard,
  initialPly = 0,
  onClose,
  onCoachIdle,
}: OpenGameProps) {
  const [ply, setPly] = useState(initialPly);
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

  useEffect(() => {
    onCoachIdle?.(ply === 0 ? null : `looking at move ${Math.ceil(ply / 2)}`);
  }, [ply, onCoachIdle]);
  useEffect(() => () => onCoachIdle?.(null), [onCoachIdle]);

  const local = useMemo(
    () => localReviewState(game, ply, serverActivityId),
    [game, ply, serverActivityId],
  );
  const evaluation = useMemo(() => evalView(game.moves.slice(0, ply)), [game, ply]);
  const created = server.cardsCreated[game.id];
  const connected = server.connection === "connected";
  const mistakes = game.mistakes_count ?? 0;
  const selected = moveAt(game, ply);

  return (
    <>
      <section className="screen games games--open" aria-label="Games">
        <div className="games__bar">
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
        <header className="games__header">
          <h2 className="games__headline">{headline(game)}</h2>
          {game.opening ? (
            <p className="games__meta" data-testid="game-opening">
              {`${game.opening.name} (${game.opening.eco})`}
            </p>
          ) : null}
          <p className="games__meta">{subline(game, summary)}</p>
        </header>
        {game.repertoire_review ? (
          <RepertoireStrip
            gameId={game.id}
            review={game.repertoire_review}
            onGoToPly={(target) => setPly(Math.min(count, target))}
          />
        ) : null}
        <div className="games__moves">
          <GameMoves moves={game.moves} selectedPly={ply} onSelect={setPly} />
        </div>
        <Steps ply={ply} count={count} setPly={setPly} />
        <PlyDetail game={game} ply={ply} />
        <div className="games__actions">
          <button
            type="button"
            className="button"
            disabled={ply === 0 || !connected}
            onClick={() => server.send({ type: "ask_coach_about_ply", game_id: game.id, ply })}
          >
            {selected
              ? `Ask the coach about ${plyLabel(ply, selected.san)}`
              : "Ask the coach about this move"}
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={created !== undefined || !connected || mistakes === 0}
            onClick={() => server.send({ type: "create_cards", game_id: game.id })}
          >
            {created === undefined ? mistakesLabel(mistakes) : `${created} cards created`}
          </button>
        </div>
      </section>
      <div className="stage games__stage">
        <div className="games__position">
          <span className="games__position-text" data-testid="position-line">
            {`${selected ? `${plyLabel(ply, selected.san)} · ` : ""}move ${ply} of ${count}`}
          </span>
          {evaluation ? (
            <span className="games__eval" title={evaluation.description} data-testid="eval-label">
              {evaluation.label}
            </span>
          ) : null}
        </div>
        <Board activity={demo ?? local} onMove={() => {}} createBoard={createBoard} />
      </div>
    </>
  );
}
