import { type Clock, systemClock } from "../clock.js";
import { appendChatMessage } from "../db/chat.js";
import {
  type Finish,
  type GameResult,
  listMoves,
  type NewMove,
  type PlayerColor,
  type Termination,
} from "../db/games.js";
import type { Database } from "../db/open.js";
import type { Classification, PlayerMoveEvaluation } from "../engine/evaluate.js";

export interface TurnNotification {
  type: "turn";
  game_id: number;
  ply: number;
  move_number: number;
  player_san: string;
  player_uci: string;
  cp_loss: number;
  classification: Classification;
  best_san: string | null;
  engine_reply_san: string | null;
  fen: string;
}

export interface CostlyMove {
  ply: number;
  san: string;
  cp_loss: number;
  classification: Classification;
  best_san: string | null;
}

export interface GameEndNotification {
  type: "game_end";
  game_id: number;
  result: GameResult | null;
  termination: Termination;
  player_color: PlayerColor;
  fen: string;
  costliest_moves: CostlyMove[];
}

export type NotificationContent = TurnNotification | GameEndNotification;

/** Where the notification rows go: the coach session that will read them. */
export interface NotificationSink {
  sessionId(): number;
}

const COSTLIEST_COUNT = 3;

export function turnContent(input: {
  gameId: number;
  player: Pick<NewMove, "ply" | "san" | "uci">;
  evaluation: PlayerMoveEvaluation;
  engineReply: Pick<NewMove, "san"> | null;
  fen: string;
}): TurnNotification {
  return {
    type: "turn",
    game_id: input.gameId,
    ply: input.player.ply,
    move_number: Math.ceil(input.player.ply / 2),
    player_san: input.player.san,
    player_uci: input.player.uci,
    cp_loss: input.evaluation.cpLoss,
    classification: input.evaluation.classification,
    best_san: input.evaluation.bestMoveSan,
    engine_reply_san: input.engineReply?.san ?? null,
    fen: input.fen,
  };
}

// Highest cp loss first, the earlier ply winning a tie. Read inside the transaction so the
// move that ended the game is already graded.
export function gameEndContent(
  db: Database,
  input: { gameId: number; finish: Finish; playerColor: PlayerColor; fen: string },
): GameEndNotification {
  const graded = listMoves(db, input.gameId).filter(
    (move) => move.isPlayer && move.cpLoss !== null,
  );
  graded.sort((a, b) => (b.cpLoss as number) - (a.cpLoss as number) || a.ply - b.ply);
  return {
    type: "game_end",
    game_id: input.gameId,
    result: input.finish.result,
    termination: input.finish.termination,
    player_color: input.playerColor,
    fen: input.fen,
    costliest_moves: graded.slice(0, COSTLIEST_COUNT).map((move) => ({
      ply: move.ply,
      san: move.san,
      cp_loss: move.cpLoss as number,
      classification: move.classification as Classification,
      best_san: move.bestMoveSan,
    })),
  };
}

export function writeNotification(
  db: Database,
  sessionId: number,
  content: NotificationContent,
  clock: Clock = systemClock,
): void {
  appendChatMessage(
    db,
    sessionId,
    { role: "user", kind: "notification", contentJson: JSON.stringify(content) },
    clock,
  );
}
