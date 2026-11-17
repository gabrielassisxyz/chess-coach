import { randomUUID } from "node:crypto";
import type { RatingPreview } from "@chess-coach/shared";
import { type Clock, systemClock } from "../clock.js";
import type { SrsAnswerNotification } from "../coach/notify.js";
import { appendChatMessage } from "../db/chat.js";
import type { Database } from "../db/open.js";
import {
  type CardRecord,
  DEFAULT_DUE_LIMIT,
  getCard,
  insertReview,
  listDueCards,
  scheduleOf,
  updateSchedule,
} from "../db/srs.js";
import type { NotificationSink } from "../game/notifications.js";
import { sanFor } from "./cards.js";
import { SrsError } from "./errors.js";
import { isGrade, previewIntervals, review } from "./fsrs.js";

export { listDueCards };

export interface ServedCard {
  exposureId: string;
  cardId: number;
  promptFen: string;
  studentColor: CardRecord["studentColor"];
}

export interface AnswerResult {
  correct: boolean;
  expected_uci: string;
  expected_san: string | null;
}

/** What a rating did to a card: when it was rated and when the card is due again. */
export interface RatedCard {
  reviewedAt: string;
  nextReviewAt: string;
}

interface Exposure {
  cardId: number;
  nextReviewAt: string;
  answeredUci: string | null;
  correct: boolean;
  used: boolean;
}

export interface ReviewDeskDeps {
  db: Database;
  clock?: Clock;
  /** Where the answer notification goes; without one an answer is graded and nothing is written. */
  notifications?: NotificationSink;
}

/**
 * Exposures live in memory on purpose: one serving of a card allows one answer and one rating, and
 * a restart discards unrated servings rather than letting a stale tab rate a card it never saw.
 */
export class ReviewDesk {
  private readonly exposures = new Map<string, Exposure>();
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly notifications: NotificationSink | undefined;

  constructor(deps: ReviewDeskDeps) {
    this.db = deps.db;
    this.clock = deps.clock ?? systemClock;
    this.notifications = deps.notifications;
  }

  listDueCards(limit: number = DEFAULT_DUE_LIMIT): CardRecord[] {
    return listDueCards(this.db, this.clock.now(), limit);
  }

  serveCard(cardId: number): ServedCard {
    const card = this.requireCard(cardId);
    const exposureId = randomUUID();
    this.exposures.set(exposureId, {
      cardId,
      nextReviewAt: card.nextReviewAt,
      answeredUci: null,
      correct: false,
      used: false,
    });
    return {
      exposureId,
      cardId,
      promptFen: card.promptFen,
      studentColor: card.studentColor,
    };
  }

  // The grade is an exact UCI comparison, promotion piece included. A card reviewed through its
  // puzzle's whole line is also told whether every step went right first time: the first move
  // alone cannot say that a later one was missed.
  answer(exposureId: string, uci: string, lineRightFirstTime: boolean = true): AnswerResult {
    const exposure = this.requireExposure(exposureId);
    if (exposure.answeredUci !== null) {
      throw new SrsError("exposure_answered", "this serving of the card was already answered");
    }
    const card = this.requireCard(exposure.cardId);
    exposure.answeredUci = uci;
    exposure.correct = uci === card.expectedUci && lineRightFirstTime;
    const expectedSan = sanFor(card.promptFen, card.expectedUci);
    this.notify({
      type: "srs_answer",
      card_id: card.id,
      prompt_fen: card.promptFen,
      answered_uci: uci,
      answered_san: sanFor(card.promptFen, uci),
      expected_uci: card.expectedUci,
      expected_san: expectedSan,
      correct: exposure.correct,
    });
    return { correct: exposure.correct, expected_uci: card.expectedUci, expected_san: expectedSan };
  }

  /** Hours until the card would be due again for each grade, exactly as `rate` would set them. */
  previewRatings(cardId: number): RatingPreview {
    const hours = previewIntervals(scheduleOf(this.requireCard(cardId)), this.clock.now());
    return { "1": hours[1], "2": hours[2], "3": hours[3], "4": hours[4] };
  }

  rate(exposureId: string, grade: number): RatedCard {
    const exposure = this.requireExposure(exposureId);
    if (!isGrade(grade)) {
      throw new SrsError("invalid_grade", `grade ${grade} is not an integer from 1 to 4`);
    }
    if (exposure.answeredUci === null) {
      throw new SrsError("exposure_unanswered", "the card has not been answered yet");
    }
    const card = this.requireCard(exposure.cardId);
    if (card.nextReviewAt !== exposure.nextReviewAt) {
      throw new SrsError("exposure_stale", "the card was rated since it was served");
    }
    const answeredUci = exposure.answeredUci;
    const now = this.clock.now();
    const next = review(scheduleOf(card), grade, now);
    this.db.transaction(() => {
      insertReview(this.db, {
        cardId: card.id,
        reviewedAt: now.toISOString(),
        grade,
        answeredUci,
        correct: exposure.correct,
      });
      updateSchedule(this.db, card.id, next);
    })();
    exposure.used = true;
    return { reviewedAt: now.toISOString(), nextReviewAt: next.next_review_at };
  }

  private requireCard(cardId: number): CardRecord {
    const card = getCard(this.db, cardId);
    if (!card) throw new SrsError("card_not_found", `card ${cardId} does not exist`);
    return card;
  }

  private requireExposure(exposureId: string): Exposure {
    const exposure = this.exposures.get(exposureId);
    if (!exposure) throw new SrsError("exposure_unknown", "no such serving of a card");
    if (exposure.used) throw new SrsError("exposure_used", "this serving was already rated");
    return exposure;
  }

  private notify(content: SrsAnswerNotification): void {
    if (!this.notifications) return;
    appendChatMessage(
      this.db,
      this.notifications.sessionId(),
      { role: "user", kind: "notification", contentJson: JSON.stringify(content) },
      this.clock,
    );
  }
}
