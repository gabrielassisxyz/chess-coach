import type {
  RepertoireBranch,
  RepertoireCoverage,
  RepertoireFigures,
  RepertoireFoundSummary,
  RepertoireGroupSummary,
  RepertoireSideSummary,
  RepertoiresResponse,
} from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import {
  foundRepertoireIdsOf,
  mergeRepertoireUnitMoves,
  type RepertoireMissCounts,
  type RepertoireUnitMoves,
  readRepertoireMissCounts,
  repertoireScopeCounts,
} from "../activity/repertoire-session.js";
import { type Clock, systemClock } from "../clock.js";
import type { Database } from "../db/open.js";
import { listDrillRepertoires, listRepertoireDrillMoves } from "../db/repertoire-cards.js";
import { findRepertoireBuild, findRepertoireOrigin, listMetOpenings } from "../db/repertoires.js";
import {
  listRepertoireBranches,
  NO_REPERTOIRE_BRANCH_BOOK,
  type RepertoireBranchBook,
  repertoireRootOf,
} from "../openings/from-repertoire.js";
import { NO_OPENING_NAMES, type OpeningNames } from "../openings/names.js";
import { repertoireCoverage } from "../openings/repertoire-coverage.js";
import {
  repertoireGroupFigures,
  repertoireGroupLine,
  repertoireVariationFigures,
  repertoireVariationLine,
} from "./repertoire-summary.js";

/**
 * The unit a rebuild is walking a copy of, set by the openings route while the run lasts. It lives in
 * memory only: no rebuild outlives its process, and the copy one leaves is removed at the next boot.
 */
export interface RepertoireRebuildState {
  unitId: number | null;
}

export interface RepertoireRouteOptions {
  clock?: Clock;
  /** Names the variation each choice at a branch point would build. */
  names?: OpeningNames;
  /** The book's branch points in the Italian. */
  book?: RepertoireBranchBook;
  /** Shared with the openings route, which names the unit a rebuild walks; none runs without it. */
  rebuilding?: RepertoireRebuildState;
}

// A group or a side drills its variations merged, so it counts them merged: a move two variations
// share is one move here as it is one move in the drill.
const sameGroup = (a: RepertoireUnitMoves, b: RepertoireUnitMoves): boolean =>
  a.variation.side === b.variation.side && a.variation.group_name === b.variation.group_name;

// The oldest variation of each group: the units arrive oldest first.
const firstUnitsOfGroups = (units: readonly RepertoireUnitMoves[]): RepertoireUnitMoves[] =>
  units.filter((unit, index) => units.findIndex((other) => sameGroup(other, unit)) === index);

interface UnitWithFigures {
  unit: RepertoireUnitMoves;
  figures: RepertoireFigures;
}

// An opening of one variation has the numbers of that variation, so the walk of its moves is not
// made twice.
function groupFigures(
  db: Database,
  members: readonly UnitWithFigures[],
  now: Date,
): RepertoireFigures {
  const [only, ...others] = members;
  if (only && others.length === 0) return only.figures;
  return repertoireGroupFigures(
    db,
    members.map((member) => member.unit),
    now,
  );
}

function groupSummaries(
  db: Database,
  entries: readonly UnitWithFigures[],
  now: Date,
  misses: RepertoireMissCounts,
): RepertoireGroupSummary[] {
  const firsts = firstUnitsOfGroups(entries.map((entry) => entry.unit));
  return firsts.map((first) => {
    const members = entries.filter((entry) => sameGroup(entry.unit, first));
    return {
      side: first.variation.side,
      group_name: first.variation.group_name,
      moves: repertoireScopeCounts(
        mergeRepertoireUnitMoves(members.map((member) => member.unit)),
        now,
        misses,
      ),
      ...groupFigures(db, members, now),
      line: repertoireGroupLine(db, first.variation),
    };
  });
}

function sideSummaries(
  units: readonly RepertoireUnitMoves[],
  now: Date,
  misses: RepertoireMissCounts,
): RepertoireSideSummary[] {
  const sides = [...new Set(units.map((unit) => unit.variation.side))];
  return sides.map((side) => ({
    side,
    moves: repertoireScopeCounts(
      mergeRepertoireUnitMoves(units.filter((unit) => unit.variation.side === side)),
      now,
      misses,
    ),
  }));
}

// The units found in games drill together, so they count together: a move two of them share is one
// move here as it is one move in the drill, and the Italian, which no met opening names, is not in it.
function foundSummary(
  units: readonly RepertoireUnitMoves[],
  foundIds: ReadonlySet<number>,
  now: Date,
  misses: RepertoireMissCounts,
): RepertoireFoundSummary {
  const found = units.filter((unit) => foundIds.has(unit.variation.id));
  return { moves: repertoireScopeCounts(mergeRepertoireUnitMoves(found), now, misses) };
}

// The counts come from the same selection the drill makes, so the menu never promises a number of
// moves that starting the drill would not serve. The misses behind the `missed` count are read from
// the log once for the whole answer, whatever the number of cards and levels. `met` lists the openings the student's games
// reached outside the stored line, each with the unit built from it, if any, `found` counts the
// drill of those units together, and `branches` lists the positions where the book offers White
// another move to build a variation from. The coverage of a variation is read from its stored moves
// alone, so it never waits on the explorer or the engine. `rebuilding_id` names the unit a rebuild is
// walking again, whose old rows serve until the walk ends, and its copy is in none of the lists.
export function registerRepertoireRoutes(
  app: FastifyInstance,
  db: Database,
  options: RepertoireRouteOptions = {},
): void {
  const clock = options.clock ?? systemClock;
  const names = options.names ?? NO_OPENING_NAMES;
  const book = options.book ?? NO_REPERTOIRE_BRANCH_BOOK;

  app.get("/api/repertoires", async (): Promise<RepertoiresResponse> => {
    const now = clock.now();
    const misses = readRepertoireMissCounts(db, now);
    const units = listDrillRepertoires(db).map(
      (variation): RepertoireUnitMoves => ({
        variation,
        moves: listRepertoireDrillMoves(db, variation.id),
      }),
    );
    const met = listMetOpenings(db);
    const entries = units.map(
      (unit): UnitWithFigures => ({ unit, figures: repertoireVariationFigures(db, unit, now) }),
    );
    const firstIds = new Set(firstUnitsOfGroups(units).map((first) => first.variation.id));
    return {
      repertoires: entries.map(({ unit: { variation, moves }, figures }) => {
        const build = findRepertoireBuild(db, variation.id);
        return {
          id: variation.id,
          side: variation.side,
          group_name: variation.group_name,
          variation_name: variation.variation_name,
          origin: findRepertoireOrigin(db, variation.id),
          moves: repertoireScopeCounts(moves, now, misses),
          ...figures,
          line: repertoireVariationLine(db, variation, build.branch, firstIds.has(variation.id)),
          points: build.points,
          root: repertoireRootOf(db, variation),
          branch: build.branch,
        };
      }),
      groups: groupSummaries(db, entries, now, misses),
      sides: sideSummaries(units, now, misses),
      found: foundSummary(units, foundRepertoireIdsOf(met), now, misses),
      met: met.map((opening) => ({
        root: opening.root,
        opening_name: opening.openingName,
        games: opening.games,
        repertoire_id: opening.repertoireId,
      })),
      branches: listRepertoireBranches(db, book, names).map(
        (branch): RepertoireBranch => ({
          group_name: branch.groupName,
          line: branch.line,
          choices: branch.choices.map((choice) => ({
            san: choice.san,
            variation_name: choice.variationName,
            repertoire_id: choice.repertoireId,
          })),
        }),
      ),
      rebuilding_id: options.rebuilding?.unitId ?? null,
    };
  });

  // An imported unit lists only the replies it answers, so a walk would call it complete: it is
  // refused before any row is read, and the answer says why instead of passing for a missing unit.
  app.get(
    "/api/repertoires/:id/coverage",
    async (request, reply): Promise<RepertoireCoverage | undefined> => {
      const id = Number((request.params as { id: string }).id);
      const isRowId = Number.isSafeInteger(id) && id > 0;
      if (isRowId && findRepertoireOrigin(db, id) === "pgn") {
        await reply.code(409).send({
          error: "imported_unit",
          message: "an imported unit lists only the replies it answers, so it has no coverage",
        });
        return undefined;
      }
      const coverage = isRowId ? repertoireCoverage(db, id) : null;
      if (!coverage) {
        await reply
          .code(404)
          .send({ error: "repertoire_not_found", message: "no such repertoire" });
        return undefined;
      }
      return coverage;
    },
  );
}
