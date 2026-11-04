import { completeTurn, createGame, recordPlayerMove } from "../src/db/games.js";
import type { Database } from "../src/db/open.js";
import { classifyCpLoss } from "../src/engine/evaluate.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const STUDENT_CP_LOSSES = [0, 45, 80, 81, 150, 420];
export const FIXTURE_STARTED_AT = "2026-01-01T00:00:00.000Z";

// One student move per cp loss, each answered by an engine move; every student move is graded
// from the start position so the stored SAN can be checked. `finish` closes the game on the last turn.
export function insertGradedGame(db: Database, finish = true): number {
  const game = createGame(db, {
    playerColor: "white",
    targetElo: 1200,
    initialFen: START_FEN,
    phase: "player_turn",
    startedAt: FIXTURE_STARTED_AT,
  });
  STUDENT_CP_LOSSES.forEach((cpLoss, index) => {
    const ply = index * 2 + 1;
    const last = index === STUDENT_CP_LOSSES.length - 1;
    recordPlayerMove(
      db,
      game.id,
      { ply, san: "e4", uci: "e2e4", fenBefore: START_FEN, fenAfter: "after", isPlayer: true },
      "",
    );
    completeTurn(db, {
      gameId: game.id,
      evaluation: {
        ply,
        value: {
          evalBeforeCp: 0,
          evalAfterCp: -cpLoss,
          cpLoss,
          classification: classifyCpLoss(cpLoss),
          bestMoveUci: "d2d4",
          bestMoveSan: "d4",
        },
      },
      engineMove: {
        ply: ply + 1,
        san: "e5",
        uci: "e7e5",
        fenBefore: "after",
        fenAfter: "next",
        isPlayer: false,
      },
      pgn: "",
      finish:
        last && finish
          ? { result: "0-1", termination: "resign", finishedAt: "2026-01-01T01:00:00.000Z" }
          : null,
    });
  });
  return game.id;
}
