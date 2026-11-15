import {
  type FoundPositionCounts,
  type FoundPositionGame,
  type FoundPositionLine,
  type FoundPositionsQuery,
  FoundPositionsQuerySchema,
  type FoundPositionsResponse,
  type FoundPositionView,
} from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import { foundPositionStateOf, selectFoundDrillPositions } from "../activity/found-drill.js";
import { type Clock, systemClock } from "../clock.js";
import {
  countUnlistedFoundPositions,
  type ListedFoundPosition,
  listListedFoundPositions,
} from "../db/found-positions.js";
import { type GameRecord, getGame, listMoves, type MoveRecord } from "../db/games.js";
import type { Database } from "../db/open.js";

// A position this early shows every move that led to it; a later one only its last four plies.
const FOUND_LINE_WHOLE_UNTIL_PLY = 8;
const FOUND_LINE_LAST_PLIES = 4;

/** The shown game's moves before the student's move at `ply`, the ply numbers counted from 1. */
function foundLineOf(moves: readonly MoveRecord[], ply: number): FoundPositionLine {
  const firstPly = ply > FOUND_LINE_WHOLE_UNTIL_PLY ? ply - FOUND_LINE_LAST_PLIES : 1;
  const san = moves.filter((move) => move.ply >= firstPly && move.ply < ply).map((m) => m.san);
  return { first_ply: firstPly, san };
}

// A game has no date of its own when it was played here; it ended when it was played, then.
function foundGameOf(
  game: GameRecord | undefined,
  position: ListedFoundPosition,
): FoundPositionGame {
  return {
    id: position.gameId,
    ply: position.ply,
    opponent: game?.opponent ?? null,
    played_at: game ? (game.playedAt ?? game.finishedAt ?? game.startedAt) : null,
  };
}

// Several positions come from one game, so each game and its moves are read once per answer.
function gameReader(db: Database) {
  const games = new Map<number, { game: GameRecord | undefined; moves: MoveRecord[] }>();
  return (gameId: number) => {
    let read = games.get(gameId);
    if (!read) {
      read = { game: getGame(db, gameId), moves: listMoves(db, gameId) };
      games.set(gameId, read);
    }
    return read;
  };
}

function viewOf(
  position: ListedFoundPosition,
  read: ReturnType<typeof gameReader>,
  now: Date,
): FoundPositionView {
  const { game, moves } = read(position.gameId);
  return {
    id: position.id,
    fen: position.fen,
    color: position.color,
    phase: position.phase,
    section: position.fromRepeat ? "reached" : "mistakes",
    from_mistake: position.fromMistake,
    from_departure: position.fromDeparture,
    opening_name: position.openingName,
    line: foundLineOf(moves, position.ply),
    reached_games: position.reachedGames,
    best_games: position.bestGames,
    last_reached_at: position.lastReachedAt,
    game: foundGameOf(game, position),
    state: foundPositionStateOf(position, now),
    next_review_at: position.nextReviewAt,
  };
}

function foundCountsOf(
  db: Database,
  query: FoundPositionsQuery,
  positions: readonly ListedFoundPosition[],
  now: Date,
): FoundPositionCounts {
  const ofColour = listListedFoundPositions(db, { color: query.color, opening: query.opening });
  const inPhase = (phase: ListedFoundPosition["phase"]): number =>
    ofColour.filter((position) => position.phase === phase).length;
  const reached = ofColour.filter((position) => position.fromRepeat).length;
  return {
    total: positions.length,
    due: selectFoundDrillPositions(positions, "due", now).length,
    new: positions.filter((position) => foundPositionStateOf(position, now) === "new").length,
    recommended: selectFoundDrillPositions(positions, "recommended", now).length,
    all: selectFoundDrillPositions(positions, "all", now).length,
    by_phase: {
      opening: inPhase("opening"),
      middlegame: inPhase("middlegame"),
      endgame: inPhase("endgame"),
    },
    by_section: { reached, mistakes: ofColour.length - reached },
    left_out: countUnlistedFoundPositions(db, query),
  };
}

/**
 * The positions collected from the student's games and the counts the From my games page shows.
 * The list is read by the rule the `found` drill reads it with, and sorted as the `all` drill
 * serves it inside each section, so the page and its drill button agree. The accepted moves and the
 * solution stay on the server.
 */
export function registerFoundPositionRoutes(
  app: FastifyInstance,
  db: Database,
  clock: Clock = systemClock,
): void {
  app.get(
    "/api/found-positions",
    async (request, reply): Promise<FoundPositionsResponse | undefined> => {
      const parsed = FoundPositionsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        await reply.code(400).send({
          error: "invalid_filter",
          message:
            "color is white or black, phase is opening, middlegame or endgame, and opening is 1 to 120 characters",
        });
        return undefined;
      }
      const now = clock.now();
      const query = parsed.data;
      const positions = listListedFoundPositions(db, query);
      const served = selectFoundDrillPositions(positions, "all", now);
      const ordered = [
        ...served.filter((position) => position.fromRepeat),
        ...served.filter((position) => !position.fromRepeat),
      ];
      const read = gameReader(db);
      return {
        positions: ordered.map((position) => viewOf(position, read, now)),
        counts: foundCountsOf(db, query, positions, now),
      };
    },
  );
}
