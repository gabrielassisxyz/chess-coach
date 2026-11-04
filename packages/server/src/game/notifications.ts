import { type Clock, systemClock } from "../clock.js";
import { appendChatMessage } from "../db/chat.js";
import {
  type Finish,
  type GameResult,
  getGame,
  listMoves,
  type NewMove,
  type PlayerColor,
  type Termination,
} from "../db/games.js";
import type { Database } from "../db/open.js";
import { findCardIdByMove } from "../db/srs.js";
import type { Classification, PlayerMoveEvaluation } from "../engine/evaluate.js";
import { type BatchResult, createCardsFromGame } from "../srs/cards.js";
import { GameError } from "./errors.js";

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
  fen_before: string;
  // Null when the loss is under the card threshold, so no card exists for the move.
  card_id: number | null;
}

export interface GameEndNotification {
  type: "game_end";
  game_id: number;
  result: GameResult | null;
  termination: Termination;
  player_color: PlayerColor;
  fen: string;
  costliest_moves: CostlyMove[];
  cards: BatchResult;
}

/** The student asked about one ply of a finished game; everything here is read from stored rows. */
export interface PlyQuestionNotification {
  type: "ply_question";
  game_id: number;
  ply: number;
  san: string;
  is_player: boolean;
  fen_before: string;
  cp_loss: number | null;
  classification: Classification | null;
  best_san: string | null;
}

export type NotificationContent = TurnNotification | GameEndNotification | PlyQuestionNotification;

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
// move that ended the game is already graded. The card batch runs here too, inside that same
// transaction and after the finish is written, so the card ids named in the text always exist and a
// failed batch rolls the finish back instead of leaving a game over with nothing to walk through.
export function gameEndContent(
  db: Database,
  input: {
    gameId: number;
    finish: Finish;
    playerColor: PlayerColor;
    fen: string;
    clock?: Clock;
  },
): GameEndNotification {
  const cards = createCardsFromGame(db, input.gameId, input.clock ?? systemClock);
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
      fen_before: move.fenBefore,
      card_id: findCardIdByMove(db, move.id),
    })),
    cards,
  };
}

export function plyQuestionContent(
  db: Database,
  input: { gameId: number; ply: number },
): PlyQuestionNotification {
  if (!getGame(db, input.gameId)) {
    throw new GameError("game_not_found", `game ${input.gameId} does not exist`);
  }
  const move = listMoves(db, input.gameId).find((candidate) => candidate.ply === input.ply);
  if (!move) throw new GameError("invalid_ply", `game ${input.gameId} has no ply ${input.ply}`);
  return {
    type: "ply_question",
    game_id: input.gameId,
    ply: move.ply,
    san: move.san,
    is_player: move.isPlayer,
    fen_before: move.fenBefore,
    cp_loss: move.cpLoss,
    classification: move.classification,
    best_san: move.bestMoveSan,
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
