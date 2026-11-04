import type { GameDetailResponse, GameListResponse, GameMove } from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getGame, listFinishedGames, listMoves, type MoveRecord } from "../db/games.js";
import type { Database } from "../db/open.js";

export const DEFAULT_GAME_LIMIT = 50;
export const MAX_GAME_LIMIT = 500;

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_GAME_LIMIT).default(DEFAULT_GAME_LIMIT),
});

function gameMove(move: MoveRecord): GameMove {
  return {
    ply: move.ply,
    san: move.san,
    uci: move.uci,
    is_player: move.isPlayer,
    eval_before_cp: move.evalBeforeCp,
    eval_after_cp: move.evalAfterCp,
    cp_loss: move.cpLoss,
    classification: move.classification,
    best_move_san: move.bestMoveSan,
    fen_after: move.fenAfter,
  };
}

export function registerGameRoutes(app: FastifyInstance, db: Database): void {
  app.get("/api/games", async (request, reply): Promise<GameListResponse | undefined> => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) {
      await reply.code(400).send({ error: "invalid_limit", message: "limit is 1 to 500" });
      return undefined;
    }
    return {
      games: listFinishedGames(db, parsed.data.limit).map((row) => ({
        id: row.game.id,
        started_at: row.game.startedAt,
        // The query keeps only finished games, so the timestamp is always present.
        finished_at: row.game.finishedAt as string,
        player_color: row.game.playerColor,
        target_elo: row.game.targetElo,
        result: row.game.result,
        termination: row.game.termination,
        move_count: row.moveCount,
        accuracy:
          row.gradedStudentMoves === 0 ? null : row.accurateStudentMoves / row.gradedStudentMoves,
      })),
    };
  });

  app.get("/api/games/:id", async (request, reply): Promise<GameDetailResponse | undefined> => {
    const id = Number((request.params as { id: string }).id);
    const game = Number.isSafeInteger(id) && id > 0 ? getGame(db, id) : undefined;
    if (!game) {
      await reply.code(404).send({ error: "game_not_found", message: "no such game" });
      return undefined;
    }
    return {
      game: {
        id: game.id,
        started_at: game.startedAt,
        finished_at: game.finishedAt,
        player_color: game.playerColor,
        target_elo: game.targetElo,
        result: game.result,
        termination: game.termination,
        initial_fen: game.initialFen,
        moves: listMoves(db, game.id).map(gameMove),
      },
    };
  });
}
