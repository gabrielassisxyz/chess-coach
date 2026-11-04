import { Chess } from "chess.js";
import type { Clock } from "../clock.js";
import { getGame, listMoves } from "../db/games.js";
import type { Database } from "../db/open.js";
import { type CardRecord, insertCard } from "../db/srs.js";
import { applyUci } from "../engine/moves.js";
import { SrsError } from "./errors.js";

// 80 is "good" and stays out; inaccuracy starts at 81.
export const CARD_MIN_CP_LOSS = 81;

export interface BatchResult {
  created: number;
  skipped: number;
}

export function createCardsFromGame(db: Database, gameId: number, clock: Clock): BatchResult {
  const game = getGame(db, gameId);
  if (!game) throw new SrsError("game_not_found", `game ${gameId} does not exist`);
  if (game.finishedAt === null) {
    throw new SrsError("game_not_finished", `game ${gameId} is still being played`);
  }
  const createdAt = clock.now().toISOString();
  const result: BatchResult = { created: 0, skipped: 0 };
  db.transaction(() => {
    for (const move of listMoves(db, gameId)) {
      const worth = move.isPlayer && (move.cpLoss ?? 0) >= CARD_MIN_CP_LOSS && move.bestMoveUci;
      if (!worth || !move.bestMoveUci) continue;
      const card = insertCard(db, {
        sourceKind: "game_move",
        sourceGameId: gameId,
        sourceMoveId: move.id,
        promptFen: move.fenBefore,
        studentColor: game.playerColor,
        playedUci: move.uci,
        expectedUci: move.bestMoveUci,
        cpLoss: move.cpLoss,
        classification: move.classification,
        explanation: null,
        createdAt,
      });
      if (card) result.created += 1;
      else result.skipped += 1;
    }
  })();
  return result;
}

// SAN is derived for display; the stored UCI stays the grading key.
export function sanFor(fen: string, uci: string | null): string | null {
  if (uci === null) return null;
  try {
    return applyUci(new Chess(fen), uci).san;
  } catch {
    return null;
  }
}

export interface CardView {
  id: number;
  prompt_fen: string;
  played_san: string | null;
  expected_san: string | null;
  cp_loss: number | null;
  classification: string | null;
  explanation: string | null;
  next_review_at: string;
}

export function cardView(card: CardRecord): CardView {
  return {
    id: card.id,
    prompt_fen: card.promptFen,
    played_san: sanFor(card.promptFen, card.playedUci),
    expected_san: sanFor(card.promptFen, card.expectedUci),
    cp_loss: card.cpLoss,
    classification: card.classification,
    explanation: card.explanation,
    next_review_at: card.nextReviewAt,
  };
}
