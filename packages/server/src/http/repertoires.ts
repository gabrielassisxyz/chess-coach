import type { RepertoiresResponse } from "@chess-coach/shared";
import type { FastifyInstance } from "fastify";
import { repertoireScopeCounts } from "../activity/repertoire-session.js";
import { type Clock, systemClock } from "../clock.js";
import type { Database } from "../db/open.js";
import { listDrillRepertoires, listRepertoireDrillMoves } from "../db/repertoire-cards.js";
import { listMetOpenings } from "../db/repertoires.js";

// The counts come from the same selection the drill makes, so the menu never promises a number of
// moves that starting the drill would not serve. `met` lists the openings the student's games
// reached outside the stored line, each with the unit built from it, if any.
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
}
