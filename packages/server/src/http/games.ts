import type {
  GameDetailResponse,
  GameListResponse,
  GameMove,
  OpeningName,
} from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  type GameRecord,
  type GameSummaryRow,
  getGameSummary,
  listFinishedGames,
  listMoves,
  type MoveRecord,
} from "../db/games.js";
import type { Database } from "../db/open.js";
import type { OpeningNames } from "../openings/names.js";

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

function momentFields(row: GameSummaryRow) {
  return {
    worst_moment: row.worstMoment && {
      ply: row.worstMoment.ply,
      san: row.worstMoment.san,
      cp_loss: row.worstMoment.cpLoss,
      classification: row.worstMoment.classification,
    },
    cards_count: row.cardsCount,
    mistakes_count: row.mistakesCount,
  };
}

function sourceFields(game: GameRecord) {
  return {
    source: game.source,
    source_url: game.sourceUrl,
    opponent: game.opponent,
    student_rating: game.studentRating,
    opponent_rating: game.opponentRating,
    time_control: game.timeControl,
    played_at: game.playedAt,
    grading: game.grading,
  };
}

// The position after each ply, in the order played, is what names a game's opening.
function openingOf(names: OpeningNames, moves: MoveRecord[]): OpeningName | null {
  return names.ofGame(moves.map((move) => move.fenAfter));
}

export function registerGameRoutes(app: FastifyInstance, db: Database, names: OpeningNames): void {
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
        ...momentFields(row),
        opening: openingOf(names, listMoves(db, row.game.id)),
        ...sourceFields(row.game),
      })),
    };
  });

  app.get("/api/games/:id", async (request, reply): Promise<GameDetailResponse | undefined> => {
    const id = Number((request.params as { id: string }).id);
    const summary = Number.isSafeInteger(id) && id > 0 ? getGameSummary(db, id) : undefined;
    if (!summary) {
      await reply.code(404).send({ error: "game_not_found", message: "no such game" });
      return undefined;
    }
    const game = summary.game;
    const moves = listMoves(db, game.id);
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
        ...momentFields(summary),
        opening: openingOf(names, moves),
        ...sourceFields(game),
        moves: moves.map(gameMove),
      },
    };
  });
}
