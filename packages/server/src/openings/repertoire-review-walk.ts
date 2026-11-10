import type { MoveRecord } from "../db/games.js";
import type { Database } from "../db/open.js";
import { positionKey } from "./from-games.js";
import { REPERTOIRE_MAX_PLY } from "./from-repertoire.js";

export interface GameReviewStoredMove {
  id: number;
  move_uci: string;
  move_san: string;
  reach: number;
  opening_name: string | null;
}

export interface RepertoireLookup {
  ownMoveAt(key: string): GameReviewStoredMove | undefined;
  hasReplyAt(key: string, uci: string): boolean;
}

/** A move of the repertoire a game played, so its card can be rated. */
export interface CardMove {
  positionKey: string;
  uci: string;
}

export type WalkEnding =
  | { kind: "game_over" }
  | { kind: "repertoire_ends"; move: MoveRecord }
  | { kind: "departed"; move: MoveRecord; expected: GameReviewStoredMove }
  | { kind: "reply_missing"; move: MoveRecord; parent: GameReviewStoredMove | null };

export interface GameWalk {
  /** How many plies, from the first, matched the repertoire. */
  followed: number;
  /** The student's moves among them, each a card to rate as passed. */
  passes: CardMove[];
  ending: WalkEnding;
}

export type GameVerdict =
  | { kind: "not_reached"; left: MoveRecord | null }
  | { kind: "in_book" }
  | { kind: "departed"; move: MoveRecord; expected: GameReviewStoredMove }
  | { kind: "reply_missing"; move: MoveRecord; parent: GameReviewStoredMove | null };

export function repertoireLookupOf(db: Database, repertoireId: number): RepertoireLookup {
  const own = db.prepare(
    `SELECT id, move_uci, move_san, reach, opening_name FROM repertoire_positions
     WHERE repertoire_id = ? AND position_key = ? AND kind = 'own'`,
  );
  const reply = db.prepare(
    `SELECT 1 FROM repertoire_positions
     WHERE repertoire_id = ? AND position_key = ? AND move_uci = ? AND kind = 'reply'`,
  );
  return {
    ownMoveAt: (key) => own.get(repertoireId, key) as GameReviewStoredMove | undefined,
    hasReplyAt: (key, uci) => reply.get(repertoireId, key, uci) !== undefined,
  };
}

// The fixed opening moves are the ones stored as setup: the variation starts after the last of them.
export function repertoireStartPly(db: Database, repertoireId: number): number {
  const row = db
    .prepare(
      `SELECT MAX(ply) AS ply FROM repertoire_positions
       WHERE repertoire_id = ? AND kind = 'own' AND source = 'setup'`,
    )
    .get(repertoireId) as { ply: number | null };
  return row.ply ?? 0;
}

/**
 * Follows a game from its first move while every position is in the repertoire: White's move must be
 * the stored one and Black's must be a stored reply. Only plies up to the repertoire's depth count.
 */
export function walkGameAgainstRepertoire(
  moves: readonly MoveRecord[],
  lookup: RepertoireLookup,
): GameWalk {
  const passes: CardMove[] = [];
  let followed = 0;
  let lastOwn: GameReviewStoredMove | null = null;
  for (const move of moves) {
    if (move.ply > REPERTOIRE_MAX_PLY) break;
    const key = positionKey(move.fenBefore);
    if (move.ply % 2 === 1) {
      const expected = lookup.ownMoveAt(key);
      if (!expected) return { followed, passes, ending: { kind: "repertoire_ends", move } };
      if (expected.move_uci !== move.uci) {
        return { followed, passes, ending: { kind: "departed", move, expected } };
      }
      passes.push({ positionKey: key, uci: move.uci });
      lastOwn = expected;
    } else if (!lookup.hasReplyAt(key, move.uci)) {
      return { followed, passes, ending: { kind: "reply_missing", move, parent: lastOwn } };
    }
    followed = move.ply;
  }
  return { followed, passes, ending: { kind: "game_over" } };
}

/** A unit a game can be compared with: the moves it is rooted at, as UCI from the first ply. */
export interface RootedUnit {
  id: number;
  root: readonly string[];
  lookup: RepertoireLookup;
}

// A game plays the opening a unit teaches when the unit's root is the start of its moves, whatever
// either side did after it.
const gameReachesRoot = (moves: readonly MoveRecord[], root: readonly string[]): boolean =>
  root.every((uci, index) => moves[index]?.uci === uci);

/**
 * Walks a game against every unit whose root it reaches and keeps the one it followed for the most
 * plies. Variations of one opening share a root, so a tie goes to the lowest id, whatever the order
 * the units come in. Null when the game reaches no unit's root.
 */
export function walkLongestFollowedUnit<Unit extends RootedUnit>(
  moves: readonly MoveRecord[],
  units: readonly Unit[],
): { unit: Unit; walk: GameWalk } | null {
  let longest: { unit: Unit; walk: GameWalk } | null = null;
  for (const unit of units) {
    if (!gameReachesRoot(moves, unit.root)) continue;
    const walk = walkGameAgainstRepertoire(moves, unit.lookup);
    const beatsLongest =
      longest === null ||
      walk.followed > longest.walk.followed ||
      (walk.followed === longest.walk.followed && unit.id < longest.unit.id);
    if (beatsLongest) longest = { unit, walk };
  }
  return longest;
}

export function gameVerdictOf(walk: GameWalk, startPly: number): GameVerdict {
  const { ending } = walk;
  if (walk.followed < startPly) {
    return { kind: "not_reached", left: ending.kind === "game_over" ? null : ending.move };
  }
  if (ending.kind === "departed") return ending;
  // White's answer sits one ply later, and a reply stored where that answer cannot be would read as
  // a gap that no later run could fill.
  if (ending.kind === "reply_missing" && ending.move.ply + 1 <= REPERTOIRE_MAX_PLY) return ending;
  return { kind: "in_book" };
}
