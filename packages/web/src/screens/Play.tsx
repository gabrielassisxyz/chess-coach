import type { PromotionPiece } from "@chess-coach/shared";
import { Board, type BoardFactory } from "../components/Board.js";
import { Controls } from "../components/Controls.js";
import { EvalBar } from "../components/EvalBar.js";
import { MoveList } from "../components/MoveList.js";
import { ServiceBanner } from "../components/ServiceBanner.js";
import type { ServerApi } from "../hooks/useServer.js";
import type { ServiceNotice } from "../state/health.js";
import { evalView, movesOf } from "../state/play.js";

export interface PlayProps {
  server: ServerApi;
  createBoard?: BoardFactory | undefined;
  notice?: ServiceNotice | null;
}

export function Play({ server, createBoard, notice = null }: PlayProps) {
  const { activity, currentElo } = server;
  const moves = movesOf(activity);

  const move = (from: string, to: string, promotion?: PromotionPiece): void => {
    server.send({ type: "move", from, to, promotion, activity_id: activity?.activity_id });
  };

  return (
    <>
      <section className="screen play" aria-label="Play">
        <h2 className="screen__title">Play</h2>
        <ServiceBanner notice={notice} />
        <EvalBar view={evalView(moves)} />
        {activity ? null : (
          <p className="screen__note">No game on the board. Start one with New game.</p>
        )}
        <Controls
          activity={activity}
          send={server.send}
          newGameBlocked={notice !== null}
          currentElo={currentElo}
        />
        <MoveList moves={moves} />
      </section>
      <div className="stage">
        {activity ? (
          <Board
            activity={activity}
            onMove={move}
            syncToken={server.errorCount}
            createBoard={createBoard}
          />
        ) : null}
      </div>
    </>
  );
}
