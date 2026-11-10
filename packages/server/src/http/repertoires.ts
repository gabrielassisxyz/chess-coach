import type { RepertoireCoverage, RepertoiresResponse } from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import { repertoireScopeCounts } from "../activity/repertoire-session.js";
import { type Clock, systemClock } from "../clock.js";
import type { Database } from "../db/open.js";
import { listDrillRepertoires, listRepertoireDrillMoves } from "../db/repertoire-cards.js";
import { listMetOpenings } from "../db/repertoires.js";
import { repertoireCoverage } from "../openings/repertoire-coverage.js";

// The counts come from the same selection the drill makes, so the menu never promises a number of
// moves that starting the drill would not serve. `met` lists the openings the student's games
// reached outside the stored line, each with the unit built from it, if any. The coverage of a
// variation is read from its stored moves alone, so it never waits on the explorer or the engine.
export function registerRepertoireRoutes(
  app: FastifyInstance,
  db: Database,
  clock: Clock = systemClock,
): void {
  app.get("/api/repertoires", async (): Promise<RepertoiresResponse> => {
    const now = clock.now();
    return {
      repertoires: listDrillRepertoires(db).map((repertoire) => ({
        id: repertoire.id,
        side: repertoire.side,
        group_name: repertoire.group_name,
        variation_name: repertoire.variation_name,
        moves: repertoireScopeCounts(listRepertoireDrillMoves(db, repertoire.id), now),
      })),
      met: listMetOpenings(db).map((opening) => ({
        root: opening.root,
        opening_name: opening.openingName,
        games: opening.games,
        repertoire_id: opening.repertoireId,
      })),
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
