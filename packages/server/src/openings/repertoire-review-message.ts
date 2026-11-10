import { Chess } from "chess.js";
import { REPERTOIRE_FLAG_CP } from "../activity/repertoire-session.js";
import type { RepertoireReviewNotification, ReviewedPly } from "../coach/notify.js";
import type { MoveRecord } from "../db/games.js";
import { applyUci } from "../engine/moves.js";
import type { OpeningNames } from "./names.js";
import type { GameReviewAddition } from "./repertoire-review-addition.js";
import type { GameReviewStoredMove, GameVerdict } from "./repertoire-review-walk.js";

export interface GameNoticeInput {
  gameId: number;
  group: string;
  variation: string;
  moves: readonly MoveRecord[];
  /** How many plies matched the repertoire. */
  followed: number;
  /** The opening of the position the game had reached when it left the repertoire. */
  openingName: string | null;
  verdict: GameVerdict;
  /** What a missing reply added; null when nothing could be. */
  addition: GameReviewAddition | null;
  names: OpeningNames;
}

const plyOf = (ply: number, san: string): ReviewedPly => ({ ply, san });

function fenAfterUci(fen: string, uci: string): string {
  const board = new Chess(fen);
  applyUci(board, uci);
  return board.fen();
}

// The drill flags a wrong try the same way: close to the engine's best, and reaching a named opening
// that is not the expected line's own. The loss is the one the grader stored for the move.
export function soundAlternativeOpening(
  names: OpeningNames,
  played: MoveRecord,
  expected: GameReviewStoredMove,
): string | null {
  if (played.cpLoss === null || played.cpLoss > REPERTOIRE_FLAG_CP) return null;
  const reached = names.ofPosition(played.fenAfter)?.name ?? null;
  if (reached === null) return null;
  const expectedName =
    names.ofPosition(fenAfterUci(played.fenBefore, expected.move_uci))?.name ??
    expected.opening_name;
  return reached === expectedName ? null : reached;
}

/** What the coach is told about one game: where it left the repertoire and what that changed. */
export function repertoireReviewNotice(input: GameNoticeInput): RepertoireReviewNotification {
  const { verdict, addition, moves } = input;
  const last = input.followed > 0 ? moves[input.followed - 1] : undefined;
  const base = {
    type: "repertoire_review" as const,
    game_id: input.gameId,
    group: input.group,
    variation: input.variation,
    followed_to: last ? plyOf(last.ply, last.san) : null,
  };
  switch (verdict.kind) {
    case "in_book":
      return { ...base, outcome: "in_book" };
    case "departed":
      return {
        ...base,
        outcome: "departed",
        expected: plyOf(verdict.move.ply, verdict.expected.move_san),
        played: plyOf(verdict.move.ply, verdict.move.san),
        alternative_opening: soundAlternativeOpening(input.names, verdict.move, verdict.expected),
      };
    case "reply_missing": {
      const reply = plyOf(verdict.move.ply, verdict.move.san);
      return addition
        ? {
            ...base,
            outcome: "reply_added",
            reply,
            answer: plyOf(verdict.move.ply + 1, addition.answerSan),
          }
        : { ...base, outcome: "reply_not_stored", reply };
    }
    case "not_reached":
      return {
        ...base,
        outcome: "not_reached",
        left: verdict.left && plyOf(verdict.left.ply, verdict.left.san),
        opening: input.openingName,
      };
  }
}
