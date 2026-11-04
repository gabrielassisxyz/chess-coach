import type { ServerEvent } from "@chess-coach/shared";
import { type Clock, systemClock } from "../clock.js";
import type { Database } from "../db/open.js";
import { plyQuestionContent, writeNotification } from "../game/notifications.js";
import { createCardsFromGame } from "../srs/cards.js";

export interface ReviewCommandDeps {
  db: Database;
  clock?: Clock;
  coach: { ensureSessionId(): number; flushNotifications(): void };
}

// The row is built here from stored data and never from client text, so a question about a move
// cannot be forged and never shows up as something the student typed.
export function askCoachAboutPly(deps: ReviewCommandDeps, gameId: number, ply: number): void {
  const content = plyQuestionContent(deps.db, { gameId, ply });
  writeNotification(deps.db, deps.coach.ensureSessionId(), content, deps.clock ?? systemClock);
  deps.coach.flushNotifications();
}

export function createCards(deps: ReviewCommandDeps, gameId: number): ServerEvent {
  const { created } = createCardsFromGame(deps.db, gameId, deps.clock ?? systemClock);
  return { type: "cards_created", game_id: gameId, count: created };
}
