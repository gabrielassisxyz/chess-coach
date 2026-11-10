import { type Clock, systemClock } from "../clock.js";
import type { RepertoireReviewNotification } from "../coach/notify.js";
import { appendChatMessage } from "../db/chat.js";
import { type GameRecord, getGame, listMoves, type MoveRecord } from "../db/games.js";
import type { Database } from "../db/open.js";
import { rateRepertoireCardFromGame } from "../db/repertoire-cards.js";
import {
  findFirstRepertoireVariation,
  type RepertoireRow,
  repertoireCounts,
} from "../db/repertoires.js";
import type { Searcher } from "../engine/uci.js";
import type { NotificationSink } from "../game/notifications.js";
import { type Log, silentLog } from "../log.js";
import { CachedExplorer, type ExplorerClock, type ExplorerFetcher } from "./explorer-client.js";
import { positionKey } from "./from-games.js";
import { REPERTOIRE_GROUP_ITALIAN } from "./from-repertoire.js";
import type { OpeningNames } from "./names.js";
import {
  type AddedAnswer,
  type AddedMove,
  type GameReviewAddition,
  type GameReviewSources,
  openingNameAfter,
  planGameReviewAddition,
} from "./repertoire-review-addition.js";
import { repertoireReviewNotice } from "./repertoire-review-message.js";
import {
  type CardMove,
  type GameReviewStoredMove,
  type GameVerdict,
  type GameWalk,
  gameVerdictOf,
  repertoireLookupOf,
  repertoireStartPly,
  walkGameAgainstRepertoire,
} from "./repertoire-review-walk.js";

/** The `source` of every position a played game added, so they can be told from generated ones. */
const REPERTOIRE_GAME_SOURCE = "game";

export type GameReviewOutcome =
  | "in_book"
  | "departed"
  | "reply_added"
  | "reply_not_stored"
  | "not_reached"
  | "other_side";

export interface GameReviewDeps {
  db: Database;
  engine: Searcher;
  fetcher: ExplorerFetcher;
  cacheDir: string;
  explorerClock: ExplorerClock;
  names: OpeningNames;
  clock?: Clock;
  log?: Log;
  /** Where the coach's message about each game is written; without it nothing is said. */
  notifications?: NotificationSink;
  /** Called once after a run that wrote messages, so the coach reads them. */
  onNotification?: () => void;
}

export interface GameReviewResult {
  gameId: number;
  outcome: GameReviewOutcome;
  /** Cards rated as passed. */
  passed: number;
  /** Cards rated as failed: one at most, where the student left the repertoire. */
  failed: number;
  /** Positions added to the repertoire. */
  added: number;
  /** Whether a message for the coach was written with the review. */
  notified: boolean;
}

export interface GameReviewSummary {
  /** Games compared with the repertoire in this run. */
  reviewed: number;
  outcomes: Record<GameReviewOutcome, number>;
  passedMoves: number;
  failedMoves: number;
  addedPositions: number;
  notified: number;
  /** Games whose review threw: they stay unreviewed and the next run tries them again. */
  failed: number;
}

interface GameReviewPlan {
  outcome: GameReviewOutcome;
  followed: number;
  passes: CardMove[];
  failure: CardMove | null;
  left: MoveRecord | null;
  expected: GameReviewStoredMove | null;
  openingName: string | null;
  addition: GameReviewAddition | null;
  /** The coach's message about the game; null when nobody is told or the game is not the repertoire's. */
  notification: RepertoireReviewNotification | null;
}

interface GameReviewRun {
  deps: GameReviewDeps;
  variation: RepertoireRow;
  sources: GameReviewSources;
  /** The ply of the last fixed move: a game that makes it has reached the variation. */
  startPly: number;
}

function planOfVerdict(
  run: GameReviewRun,
  walk: GameWalk,
  verdict: GameVerdict,
  moves: readonly MoveRecord[],
): Omit<GameReviewPlan, "addition" | "notification"> {
  const { names } = run.sources;
  const base = {
    followed: walk.followed,
    passes: walk.passes,
    failure: null,
    left: null,
    expected: null,
  };
  switch (verdict.kind) {
    case "not_reached":
      return {
        ...base,
        outcome: "not_reached",
        passes: [],
        left: verdict.left,
        openingName: openingNameAfter(names, moves, verdict.left?.ply ?? walk.followed),
      };
    case "departed":
      return {
        ...base,
        outcome: "departed",
        failure: {
          positionKey: positionKey(verdict.move.fenBefore),
          uci: verdict.expected.move_uci,
        },
        left: verdict.move,
        expected: verdict.expected,
        openingName: openingNameAfter(names, moves, verdict.move.ply),
      };
    case "reply_missing":
      return {
        ...base,
        outcome: "reply_added",
        left: verdict.move,
        openingName: openingNameAfter(names, moves, verdict.move.ply),
      };
    case "in_book":
      return {
        ...base,
        outcome: "in_book",
        openingName: openingNameAfter(names, moves, walk.followed),
      };
  }
}

async function planGameReview(
  run: GameReviewRun,
  game: GameRecord,
  moves: readonly MoveRecord[],
): Promise<GameReviewPlan> {
  const walk = walkGameAgainstRepertoire(moves, run.sources.lookup);
  const verdict = gameVerdictOf(walk, run.startPly);
  const plan = planOfVerdict(run, walk, verdict, moves);
  const addition =
    verdict.kind === "reply_missing"
      ? await planGameReviewAddition(run.sources, verdict.move, verdict.parent, moves)
      : null;
  const notification = run.deps.notifications
    ? repertoireReviewNotice({
        gameId: game.id,
        group: run.variation.group_name,
        variation: run.variation.variation_name,
        moves,
        followed: walk.followed,
        openingName: plan.openingName,
        verdict,
        addition,
        names: run.sources.names,
      })
    : null;
  const unanswered = verdict.kind === "reply_missing" && addition === null;
  return {
    ...plan,
    outcome: unanswered ? "reply_not_stored" : plan.outcome,
    addition,
    notification,
  };
}

const otherSidePlan = (): GameReviewPlan => ({
  outcome: "other_side",
  followed: 0,
  passes: [],
  failure: null,
  left: null,
  expected: null,
  openingName: null,
  addition: null,
  notification: null,
});

// A White move carries the engine's scores, a Black reply does not.
function insertAddedMove(
  db: Database,
  repertoireId: number,
  move: AddedMove,
  scores: Pick<AddedAnswer, "cpLoss" | "evalCp" | "results"> | null,
): number {
  const inserted = db
    .prepare(
      `INSERT INTO repertoire_positions
         (repertoire_id, kind, position_key, ply, line_san, move_uci, move_san, share, reach,
          opening_name, source, cp_loss, eval_cp, wins, draws, losses)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      repertoireId,
      scores ? "own" : "reply",
      move.positionKey,
      move.ply,
      JSON.stringify(move.line),
      move.uci,
      move.san,
      move.share,
      move.reach,
      move.openingName,
      REPERTOIRE_GAME_SOURCE,
      scores?.cpLoss ?? null,
      scores?.evalCp ?? null,
      scores?.results?.wins ?? null,
      scores?.results?.draws ?? null,
      scores?.results?.losses ?? null,
    ) as { id: number };
  return inserted.id;
}

function insertGameReview(
  run: GameReviewRun,
  game: GameRecord,
  plan: GameReviewPlan,
  now: Date,
  added: { replyId: number | null; answerId: number | null },
): void {
  run.deps.db
    .prepare(
      `INSERT INTO repertoire_game_reviews
         (game_id, repertoire_id, reviewed_at, outcome, followed_plies, passed_moves, left_ply,
          left_position_key, left_san, left_uci, expected_san, expected_uci, opening_name,
          added_reply_id, added_answer_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      game.id,
      run.variation.id,
      now.toISOString(),
      plan.outcome,
      plan.followed,
      plan.passes.length,
      plan.left?.ply ?? null,
      plan.left ? positionKey(plan.left.fenBefore) : null,
      plan.left?.san ?? null,
      plan.left?.uci ?? null,
      plan.expected?.move_san ?? null,
      plan.expected?.move_uci ?? null,
      plan.openingName,
      added.replyId,
      added.answerId,
    );
}

// Written inside the review's transaction, so a game is told to the coach exactly once, and a
// restart before the coach reads it finds the row still undelivered.
function writeNotification(run: GameReviewRun, plan: GameReviewPlan, now: Date): boolean {
  const sink = run.deps.notifications;
  if (!sink || !plan.notification) return false;
  appendChatMessage(
    run.deps.db,
    sink.sessionId(),
    { role: "user", kind: "notification", contentJson: JSON.stringify(plan.notification) },
    { now: () => now },
  );
  return true;
}

const isGameReviewed = (db: Database, gameId: number): boolean =>
  db.prepare("SELECT 1 FROM repertoire_game_reviews WHERE game_id = ?").get(gameId) !== undefined;

// Everything a game changes commits together with its review row, and the row is checked again
// inside the transaction: two runs that raced past the first check cannot both apply the game.
function writeGameReview(
  run: GameReviewRun,
  game: GameRecord,
  plan: GameReviewPlan,
): GameReviewResult | null {
  const { db, clock = systemClock } = run.deps;
  const now = clock.now();
  return db.transaction((): GameReviewResult | null => {
    if (isGameReviewed(db, game.id)) return null;
    for (const pass of plan.passes) rateRepertoireCardFromGame(db, pass, true, now);
    if (plan.failure) rateRepertoireCardFromGame(db, plan.failure, false, now);
    const { reply, answer } = plan.addition ?? { reply: null, answer: null };
    const replyId = reply ? insertAddedMove(db, run.variation.id, reply, null) : null;
    const answerId = answer ? insertAddedMove(db, run.variation.id, answer, answer) : null;
    insertGameReview(run, game, plan, now, { replyId, answerId });
    const notified = writeNotification(run, plan, now);
    return {
      gameId: game.id,
      outcome: plan.outcome,
      passed: plan.passes.length,
      failed: plan.failure ? 1 : 0,
      added: (replyId === null ? 0 : 1) + (answerId === null ? 0 : 1),
      notified,
    };
  })();
}

// Compares one graded game with the repertoire and applies what it shows, once: the student's
// moves that match are rated as passed, the move they replaced is rated as failed, and a Black
// reply the repertoire lacks is stored with White's answer. Null when it was reviewed before.
async function reviewGameWithin(
  run: GameReviewRun,
  gameId: number,
): Promise<GameReviewResult | null> {
  const game = getGame(run.deps.db, gameId);
  if (!game || isGameReviewed(run.deps.db, gameId)) return null;
  const moves = listMoves(run.deps.db, gameId);
  const plan =
    game.playerColor === run.variation.side
      ? await planGameReview(run, game, moves)
      : otherSidePlan();
  return writeGameReview(run, game, plan);
}

// Games the grader finished and the review has not seen. A game played on the Play tab is born
// graded and never passes through the grader, and its Black replies come from the engine rather than
// from players at the student's level, so only imported games are compared.
function listGamesToReview(db: Database): number[] {
  const rows = db
    .prepare(
      `SELECT g.id FROM games g
       WHERE g.grading = 'done' AND g.finished_at IS NOT NULL AND g.source <> 'coach'
         AND NOT EXISTS (SELECT 1 FROM repertoire_game_reviews r WHERE r.game_id = g.id)
       ORDER BY g.id`,
    )
    .all() as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

function emptySummary(): GameReviewSummary {
  return {
    reviewed: 0,
    outcomes: {
      in_book: 0,
      departed: 0,
      reply_added: 0,
      reply_not_stored: 0,
      not_reached: 0,
      other_side: 0,
    },
    passedMoves: 0,
    failedMoves: 0,
    addedPositions: 0,
    notified: 0,
    failed: 0,
  };
}

function tally(summary: GameReviewSummary, result: GameReviewResult): void {
  summary.reviewed += 1;
  summary.outcomes[result.outcome] += 1;
  summary.passedMoves += result.passed;
  summary.failedMoves += result.failed;
  summary.addedPositions += result.added;
  if (result.notified) summary.notified += 1;
}

// Nothing to compare with until the generator has stored a variation and its first move.
function beginRun(deps: GameReviewDeps): GameReviewRun | null {
  const variation = findFirstRepertoireVariation(deps.db, "white", REPERTOIRE_GROUP_ITALIAN);
  if (!variation || repertoireCounts(deps.db, variation.id).total === 0) return null;
  return {
    deps,
    variation,
    sources: {
      explorer: new CachedExplorer(deps.fetcher, deps.cacheDir, deps.explorerClock),
      engine: deps.engine,
      names: deps.names,
      lookup: repertoireLookupOf(deps.db, variation.id),
    },
    startPly: repertoireStartPly(deps.db, variation.id),
  };
}

/** Reviews one game; null when it was reviewed before or the repertoire is not built yet. */
export async function reviewRepertoireGame(
  deps: GameReviewDeps,
  gameId: number,
): Promise<GameReviewResult | null> {
  const run = beginRun(deps);
  const result = run ? await reviewGameWithin(run, gameId) : null;
  if (result?.notified) deps.onNotification?.();
  return result;
}

function summaryFields(summary: GameReviewSummary, explorer: CachedExplorer) {
  const { outcomes } = summary;
  return {
    reviewed: summary.reviewed,
    ...outcomes,
    // How many of the games that could reach the Italian did, whichever way they then went.
    reached_start:
      outcomes.in_book + outcomes.departed + outcomes.reply_added + outcomes.reply_not_stored,
    passed_moves: summary.passedMoves,
    failed_moves: summary.failedMoves,
    added_positions: summary.addedPositions,
    notified: summary.notified,
    failed: summary.failed,
    requests: explorer.requests,
    cache_hits: explorer.cacheHits,
  };
}

/**
 * Reviews every graded game that was not reviewed yet, oldest first. A game whose review throws is
 * logged and left for the next run, and the games after it are reviewed all the same.
 */
export async function reviewRepertoireGames(deps: GameReviewDeps): Promise<GameReviewSummary> {
  const log = deps.log ?? silentLog;
  const summary = emptySummary();
  const run = beginRun(deps);
  if (!run) {
    log.info("repertoire.review_skipped", { reason: "no_repertoire" });
    return summary;
  }
  for (const gameId of listGamesToReview(deps.db)) {
    try {
      const result = await reviewGameWithin(run, gameId);
      if (!result) continue;
      tally(summary, result);
      log.info("repertoire.game_reviewed", {
        game_id: gameId,
        outcome: result.outcome,
        passed_moves: result.passed,
        failed_moves: result.failed,
        added_positions: result.added,
      });
    } catch (error) {
      summary.failed += 1;
      log.error("repertoire.review_failed", error, { game_id: gameId });
    }
  }
  log.info("repertoire.review", summaryFields(summary, run.sources.explorer));
  if (summary.notified > 0) deps.onNotification?.();
  return summary;
}
