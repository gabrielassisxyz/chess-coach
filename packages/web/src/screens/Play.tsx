import type { LiveGameActivity, PromotionPiece } from "@chess-coach/shared";
import { useState } from "react";
import { BlunderCard } from "../components/BlunderCard.js";
import { Board, type BoardFactory } from "../components/Board.js";
import { BoardSettingsPanel, BoardSettingsToggle } from "../components/BoardSettings.js";
import { Controls } from "../components/Controls.js";
import { EvalBar } from "../components/EvalBar.js";
import { MoveList } from "../components/MoveList.js";
import { ServiceBanner } from "../components/ServiceBanner.js";
import type { ServerApi } from "../hooks/useServer.js";
import { useBoardPrefs } from "../state/board-prefs.js";
import { useBoardTheme } from "../state/board-theme.js";
import type { ServiceNotice } from "../state/health.js";
import { evalView, lastBlunder, movesOf } from "../state/play.js";
import {
  dayWords,
  type PlayFactsApi,
  serverPlayFactsApi,
  usePlayFacts,
} from "../state/play-facts.js";

export interface PlayProps {
  server: ServerApi;
  createBoard?: BoardFactory | undefined;
  notice?: ServiceNotice | null;
  factsApi?: PlayFactsApi;
  // The unfinished live game underneath a training run, if any. Kept by the
  // shell while training is on the board, so Play can show it read-only.
  liveGame?: LiveGameActivity | null;
  onGoToPractice?: (() => void) | undefined;
}

function capitalised(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

export function Play({
  server,
  createBoard,
  notice = null,
  factsApi = serverPlayFactsApi,
  liveGame = null,
  onGoToPractice,
}: PlayProps) {
  const { activity, currentElo } = server;
  const live = activity?.kind === "live_game" ? activity : null;
  const moves = movesOf(activity);
  const blunder = lastBlunder(moves);
  const facts = usePlayFacts(live?.game_id ?? null, factsApi);
  const board = useBoardTheme();
  const { prefs } = useBoardPrefs();
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (activity?.kind === "training") {
    const unfinished = liveGame && liveGame.phase !== "finished" ? liveGame : null;
    const goToPractice = onGoToPractice ?? (() => undefined);
    if (!unfinished) {
      return (
        <section className="screen play" aria-label="Play">
          <ServiceBanner notice={notice} />
          <p className="screen__note">A practice session is open</p>
          <div className="controls__row">
            <button type="button" className="button button--primary" onClick={goToPractice}>
              Go to Practice
            </button>
          </div>
        </section>
      );
    }
    const readOnly: LiveGameActivity = { ...unfinished, input_enabled: false, legal_moves: [] };
    const gameMoves = unfinished.moves;
    const gameBlunder = lastBlunder(gameMoves);
    return (
      <>
        <section className="screen play" aria-label="Play">
          <p className="screen__note">A practice session is open</p>
          <div className="controls__row">
            <button type="button" className="button button--primary" onClick={goToPractice}>
              Go to Practice
            </button>
          </div>
          <ServiceBanner notice={notice} />
          <MoveList moves={gameMoves} flaggedPly={gameBlunder?.ply ?? null} />
          {gameBlunder ? <BlunderCard move={gameBlunder} /> : null}
        </section>
        <div className="stage">
          <div className="table">
            <EvalBar view={evalView(gameMoves)} />
            <Board
              activity={readOnly}
              onMove={() => undefined}
              syncToken={server.errorCount}
              prefs={prefs}
              createBoard={createBoard}
            />
          </div>
        </div>
      </>
    );
  }
  const move = (from: string, to: string, promotion?: PromotionPiece): void => {
    server.send({ type: "move", from, to, promotion, activity_id: activity?.activity_id });
  };

  return (
    <>
      <section className="screen play" aria-label="Play">
        {live ? (
          <header className="play__header">
            <span className="play__game">
              {facts.startedAt
                ? `Game ${live.game_id} · ${dayWords(facts.startedAt)}`
                : `Game ${live.game_id}`}
            </span>
            <span className="play__versus">
              {`${capitalised(live.orientation)} vs Stockfish`}
              {facts.engineElo === null ? "" : ` · ${facts.engineElo}`}
            </span>
          </header>
        ) : null}
        <ServiceBanner notice={notice} />
        {settingsOpen ? (
          <BoardSettingsPanel
            theme={board.theme}
            onChoose={board.choose}
            onClose={() => setSettingsOpen(false)}
          />
        ) : null}
        {activity ? (
          <MoveList moves={moves} flaggedPly={blunder?.ply ?? null} />
        ) : (
          <p className="screen__note">No game on the board. Start one with New game.</p>
        )}
        {blunder ? <BlunderCard move={blunder} /> : null}
        <Controls
          activity={activity}
          send={server.send}
          newGameBlocked={notice !== null}
          currentElo={currentElo}
        />
      </section>
      <div className="stage">
        {activity ? (
          <div className="table">
            <EvalBar view={evalView(moves)} />
            <div className="table__top">
              <span className="table__player">
                {live && facts.engineElo !== null ? (
                  <>
                    <strong>Stockfish</strong>
                    <span className="table__rating">{facts.engineElo}</span>
                  </>
                ) : null}
              </span>
              <BoardSettingsToggle
                open={settingsOpen}
                onToggle={() => setSettingsOpen((open) => !open)}
              />
            </div>
            <Board
              activity={activity}
              onMove={move}
              syncToken={server.errorCount}
              prefs={prefs}
              createBoard={createBoard}
            />
            <div className="table__bottom">
              {live && facts.studentRating !== null ? (
                <span className="table__player">
                  <strong>You</strong>
                  <span className="table__rating">{facts.studentRating}</span>
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
