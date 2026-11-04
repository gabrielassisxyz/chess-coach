import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db/open.js";
import { listCardsNewestFirst } from "../db/srs.js";
import { cardView } from "../srs/cards.js";

export const DEFAULT_CARD_LIMIT = 50;
export const MAX_CARD_LIMIT = 500;

const query = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_CARD_LIMIT).default(DEFAULT_CARD_LIMIT),
});

export function registerCardRoutes(app: FastifyInstance, db: Database): void {
  app.get("/api/cards", async (request, reply) => {
    const parsed = query.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_limit", message: "limit is 1 to 500" });
    }
    return { cards: listCardsNewestFirst(db, parsed.data.limit).map(cardView) };
  });
}
