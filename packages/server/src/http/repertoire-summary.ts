import {
  type RepertoireFigures,
  repertoireMovesText,
  repertoireRootText,
} from "@chess-coach/shared";
import {
  mergeRepertoireUnitMoves,
  type RepertoireUnitMoves,
} from "../activity/repertoire-session.js";
import type { Database } from "../db/open.js";
import { countRepertoireFirstAttemptsInWindow } from "../db/repertoire-cards.js";
import {
  countRepertoireGamesInLine,
  findRepertoireAnswerAfter,
  findRepertoireOrigin,
  type RepertoireRow,
  repertoireSetupLine,
} from "../db/repertoires.js";
import { repertoireNamingLineOf } from "../openings/from-repertoire.js";
import { repertoireCoveredPercent } from "../openings/repertoire-coverage.js";
import { ITALIAN_SETUP_SAN } from "../openings/repertoire-root.js";

// An imported unit stores only the replies it answers and no explorer share for the rest, so a walk
// over it reads as complete: its coverage would be a figure nobody measured. It stays out of the walk
// when its opening has other variations too, and an opening of imported units alone has no coverage.
const generatedIdsOf = (db: Database, repertoireIds: readonly number[]): number[] =>
  repertoireIds.filter((id) => findRepertoireOrigin(db, id) === "generated");

// A first attempt and a reviewed game each belong to one variation, so the counts of an opening are
// the sums of its variations' and nothing is counted twice. Two numbers are not sums: the caller
// counts the moves, merging one that two variations share, and the coverage is read over all the
// rows at once, because a reply one variation leaves open can be answered by another.
function figuresOver(
  db: Database,
  repertoireIds: readonly number[],
  movesTotal: number,
  now: Date,
): RepertoireFigures {
  const remembered = { right: 0, of: 0 };
  const inLine = { stayed: 0, of: 0 };
  for (const id of repertoireIds) {
    const attempts = countRepertoireFirstAttemptsInWindow(db, id, now);
    remembered.right += attempts.right;
    remembered.of += attempts.attempts;
    const games = countRepertoireGamesInLine(db, id);
    inLine.stayed += games.stayed;
    inLine.of += games.of;
  }
  return {
    moves_total: movesTotal,
    remembered_30d: remembered,
    in_line: inLine,
    covered_percent: repertoireCoveredPercent(db, generatedIdsOf(db, repertoireIds)),
  };
}

/** The White moves a variation stores, setup included, and the rest of the page's numbers for it. */
export function repertoireVariationFigures(
  db: Database,
  unit: RepertoireUnitMoves,
  now: Date,
): RepertoireFigures {
  return figuresOver(db, [unit.variation.id], unit.moves.length, now);
}

/** The same numbers over all of an opening's variations, a move two of them share counted once. */
export function repertoireGroupFigures(
  db: Database,
  units: readonly RepertoireUnitMoves[],
  now: Date,
): RepertoireFigures {
  const ids = units.map((unit) => unit.variation.id);
  return figuresOver(db, ids, mergeRepertoireUnitMoves(units).length, now);
}

/**
 * The moves every variation of a group starts with, numbered from move 1; null while the group's
 * first variation has stored none, which a run cut short before its first move leaves.
 */
export function repertoireGroupLine(db: Database, first: RepertoireRow): string | null {
  const setup = repertoireSetupLine(db, first.id);
  return setup.length === 0 ? null : repertoireRootText(setup);
}

// The variation is named after White's answer to the naming line, so the text runs from the end of
// the setup through that answer. A first variation whose answer is not stored has no text to give.
function firstVariationLine(db: Database, variation: RepertoireRow): string | null {
  const naming = repertoireNamingLineOf(db, variation);
  const answer = naming ? findRepertoireAnswerAfter(db, variation.id, naming) : undefined;
  if (!naming || answer === undefined) return null;
  const setupLength = repertoireSetupLine(db, variation.id).length;
  return repertoireMovesText([...naming.slice(setupLength), answer], setupLength);
}

/**
 * The moves that tell a variation from the others of its group. A variation built at a branch point
 * is told by the rest of its branch; the first variation of a group by the answer it is named after;
 * any other has no stored line to read, since nothing marks where it parts from the first.
 */
export function repertoireVariationLine(
  db: Database,
  variation: RepertoireRow,
  branch: readonly string[] | null,
  isFirstOfGroup: boolean,
): string | null {
  if (branch) {
    const setupLength = ITALIAN_SETUP_SAN.length;
    return repertoireMovesText(branch.slice(setupLength), setupLength);
  }
  return isFirstOfGroup ? firstVariationLine(db, variation) : null;
}
