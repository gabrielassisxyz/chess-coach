import { Chess } from "chess.js";
import type { MoveRecord } from "../db/games.js";
import type { RepertoireResultCounts } from "../db/repertoires.js";
import { EVALUATION_DEPTH } from "../engine/evaluate.js";
import { applyUci } from "../engine/moves.js";
import type { Searcher } from "../engine/uci.js";
import {
  type CachedExplorer,
  EXPLORER_RATINGS,
  type ExplorerPosition,
  gamesOf,
  ITALIAN_WHITE_RATINGS,
} from "./explorer-client.js";
import { positionKey } from "./from-games.js";
import { pickItalianWhiteUci } from "./from-italian.js";
import { REPERTOIRE_SEARCH_CAP_MS } from "./from-repertoire.js";
import type { OpeningNames } from "./names.js";
import type { GameReviewStoredMove, RepertoireLookup } from "./repertoire-review-walk.js";

// White's answer to a reply a game brought is chosen from the same five lines the generator reads.
const GAME_ANSWER_SEARCH_LINES = 5;
// The generator's turn for an answer past a root: no turn has a setup move to prefer. The Italian
// stores a reply from its 6th ply, past every setup move, but a unit rooted at 1.e4 d5 stores one at
// its 4th, where the real turn would prefer 3.Bc4 to the move played most.
const NO_SETUP_PREFERENCE_TURN = 0;

export interface AddedMove {
  positionKey: string;
  ply: number;
  line: string[];
  uci: string;
  san: string;
  share: number | null;
  reach: number;
  openingName: string | null;
}

export interface AddedAnswer extends AddedMove {
  cpLoss: number;
  /** The position after the move, in centipawns from White's side. */
  evalCp: number;
  /** How deep the engine looked for `evalCp` and `cpLoss`; null when the engine did not say. */
  evalDepth: number | null;
  results: RepertoireResultCounts | null;
}

export interface GameReviewAddition {
  reply: AddedMove;
  /** Null when the position after the reply already holds a White move of the repertoire. */
  answer: AddedAnswer | null;
  /** White's move after the reply, whether it was added now or was already stored. */
  answerSan: string;
}

export interface GameReviewSources {
  explorer: CachedExplorer;
  engine: Searcher;
  names: OpeningNames;
  lookup: RepertoireLookup;
}

function playUciAt(fen: string, uci: string): { san: string; after: string } | null {
  const board = new Chess(fen);
  try {
    const move = applyUci(board, uci);
    return { san: move.san, after: board.fen() };
  } catch {
    return null;
  }
}

// The explorer writes castling as king-takes-rook, so its moves are matched by playing the SAN.
function uciOfSanAt(fen: string, san: string): string | null {
  try {
    const move = new Chess(fen).move(san);
    return `${move.from}${move.to}${move.promotion ?? ""}`;
  } catch {
    return null;
  }
}

function shareOfMove(position: ExplorerPosition, fen: string, uci: string): number | null {
  const total = gamesOf(position);
  const listed = position.moves.find((move) => uciOfSanAt(fen, move.san) === uci);
  return listed && total > 0 ? gamesOf(listed) / total : null;
}

export const openingNameAfter = (
  names: OpeningNames,
  moves: readonly MoveRecord[],
  plies: number,
): string | null => names.ofGame(moves.slice(0, plies).map((move) => move.fenAfter))?.name ?? null;

// The generator's rule: the likeliest move at the better players' rating that stays within the
// margin of the engine's best, else the best. A position with no move to play has no answer.
async function chooseWhiteAnswer(
  sources: GameReviewSources,
  move: MoveRecord,
  reply: AddedMove,
  moves: readonly MoveRecord[],
): Promise<AddedAnswer | null> {
  const fen = move.fenAfter;
  if (new Chess(fen).moves().length === 0) return null;
  const position = await sources.explorer.position(fen, ITALIAN_WHITE_RATINGS);
  const searched = await sources.engine.search({
    fen,
    depth: EVALUATION_DEPTH,
    multipv: GAME_ANSWER_SEARCH_LINES,
    capMs: REPERTOIRE_SEARCH_CAP_MS,
  });
  const uci = pickItalianWhiteUci(fen, position, searched.lines, NO_SETUP_PREFERENCE_TURN);
  const best = searched.lines[0];
  const scored = searched.lines.find((line) => line.moves[0] === uci);
  const played = uci ? playUciAt(fen, uci) : null;
  if (!uci || !best || !scored || !played) return null;
  const after = await sources.explorer.position(played.after, EXPLORER_RATINGS);
  return {
    positionKey: positionKey(fen),
    ply: move.ply + 1,
    line: [...reply.line, move.san],
    uci,
    san: played.san,
    share: shareOfMove(position, fen, uci),
    reach: reply.reach,
    openingName: openingNameAfter(sources.names, moves, move.ply),
    cpLoss: Math.max(0, best.score - scored.score),
    evalCp: scored.score,
    evalDepth: searched.depth ?? null,
    results:
      gamesOf(after) > 0 ? { wins: after.white, draws: after.draws, losses: after.black } : null,
  };
}

/**
 * The rows a Black reply the repertoire lacks would add. The reply is kept whatever its share, since
 * it was played at this level and will be met again; null when no White answer can follow it.
 */
export async function planGameReviewAddition(
  sources: GameReviewSources,
  move: MoveRecord,
  parent: GameReviewStoredMove | null,
  moves: readonly MoveRecord[],
): Promise<GameReviewAddition | null> {
  const before = await sources.explorer.position(move.fenBefore, EXPLORER_RATINGS);
  const share = shareOfMove(before, move.fenBefore, move.uci);
  const reply: AddedMove = {
    positionKey: positionKey(move.fenBefore),
    ply: move.ply,
    line: moves.slice(0, move.ply - 1).map((played) => played.san),
    uci: move.uci,
    san: move.san,
    share,
    reach: (parent?.reach ?? 0) * (share ?? 0),
    openingName: openingNameAfter(sources.names, moves, move.ply - 1),
  };
  const stored = sources.lookup.ownMoveAt(positionKey(move.fenAfter));
  if (stored) return { reply, answer: null, answerSan: stored.move_san };
  const answer = await chooseWhiteAnswer(sources, move, reply, moves);
  return answer ? { reply, answer, answerSan: answer.san } : null;
}
