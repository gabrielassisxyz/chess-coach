import type {
  RepertoireBranch,
  RepertoireCoverage,
  RepertoireGroupSummary,
  RepertoireSideSummary,
  RepertoiresResponse,
} from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import {
  mergeRepertoireUnitMoves,
  type RepertoireUnitMoves,
  repertoireScopeCounts,
} from "../activity/repertoire-session.js";
import { type Clock, systemClock } from "../clock.js";
import type { Database } from "../db/open.js";
import { listDrillRepertoires, listRepertoireDrillMoves } from "../db/repertoire-cards.js";
import { listMetOpenings } from "../db/repertoires.js";
import {
  listRepertoireBranches,
  NO_REPERTOIRE_BRANCH_BOOK,
  type RepertoireBranchBook,
} from "../openings/from-repertoire.js";
import { NO_OPENING_NAMES, type OpeningNames } from "../openings/names.js";
import { repertoireCoverage } from "../openings/repertoire-coverage.js";

export interface RepertoireRouteOptions {
  clock?: Clock;
  /** Names the variation each choice at a branch point would build. */
  names?: OpeningNames;
  /** The book's branch points in the Italian. */
  book?: RepertoireBranchBook;
}

// A group or a side drills its variations merged, so it counts them merged: a move two variations
// share is one move here as it is one move in the drill.
const sameGroup = (a: RepertoireUnitMoves, b: RepertoireUnitMoves): boolean =>
  a.variation.side === b.variation.side && a.variation.group_name === b.variation.group_name;

function groupSummaries(
  units: readonly RepertoireUnitMoves[],
  now: Date,
): RepertoireGroupSummary[] {
  const firsts = units.filter(
    (unit, index) => units.findIndex((other) => sameGroup(other, unit)) === index,
  );
  return firsts.map((first) => ({
    side: first.variation.side,
    group_name: first.variation.group_name,
    moves: repertoireScopeCounts(
      mergeRepertoireUnitMoves(units.filter((unit) => sameGroup(unit, first))),
      now,
    ),
  }));
}

function sideSummaries(units: readonly RepertoireUnitMoves[], now: Date): RepertoireSideSummary[] {
  const sides = [...new Set(units.map((unit) => unit.variation.side))];
  return sides.map((side) => ({
    side,
    moves: repertoireScopeCounts(
      mergeRepertoireUnitMoves(units.filter((unit) => unit.variation.side === side)),
      now,
    ),
  }));
}

// The counts come from the same selection the drill makes, so the menu never promises a number of
// moves that starting the drill would not serve. `met` lists the openings the student's games
// reached outside the stored line, each with the unit built from it, if any, and `branches` the
// positions where the book offers White another move to build a variation from. The coverage of a
// variation is read from its stored moves alone, so it never waits on the explorer or the engine.
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
    const units = listDrillRepertoires(db).map(
      (variation): RepertoireUnitMoves => ({
        variation,
        moves: listRepertoireDrillMoves(db, variation.id),
      }),
    );
    return {
      repertoires: units.map(({ variation, moves }) => ({
        id: variation.id,
        side: variation.side,
        group_name: variation.group_name,
        variation_name: variation.variation_name,
        moves: repertoireScopeCounts(moves, now),
      })),
      groups: groupSummaries(units, now),
      sides: sideSummaries(units, now),
      met: listMetOpenings(db).map((opening) => ({
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
    };
  });

  app.get(
    "/api/repertoires/:id/coverage",
    async (request, reply): Promise<RepertoireCoverage | undefined> => {
      const id = Number((request.params as { id: string }).id);
      const coverage = Number.isSafeInteger(id) && id > 0 ? repertoireCoverage(db, id) : null;
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
