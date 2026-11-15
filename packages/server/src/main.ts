import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { repertoireTryJudge } from "./activity/repertoire-session.js";
import { ActivityService } from "./activity/service.js";
import type { Readiness } from "./app.js";
import { systemClock } from "./clock.js";
import { assertSubscriptionAuth } from "./coach/auth.js";
import { CoachSession, coachNotificationSinks } from "./coach/session.js";
import { composeServer } from "./compose.js";
import { resolveLichessToken } from "./db/connections.js";
import { openDatabase } from "./db/open.js";
import { bootEngines } from "./engine/boot.js";
import { evaluatePlayerMove } from "./engine/evaluate.js";
import { EnginePool } from "./engine/pool.js";
import { spawnStockfish } from "./engine/process.js";
import { poolGameEngine } from "./game/engine.js";
import { GameService } from "./game/service.js";
import { ChessComSource, httpFetcher } from "./import/chesscom.js";
import { createFileLog, pruneLogs } from "./log.js";
import { listAddableOpenings } from "./openings/addable-openings.js";
import {
  CachedExplorer,
  httpExplorerFetcher,
  systemExplorerClock,
} from "./openings/explorer-client.js";
import { FOUND_NOTE_SYSTEM_PROMPT, generateFoundNotes } from "./openings/found-notes.js";
import { loadRepertoireBranchBook } from "./openings/from-repertoire.js";
import { loadOpeningNames } from "./openings/names.js";
import { generateRepertoireIdeas, sdkIdeaSession } from "./openings/repertoire-ideas.js";
import { contentDir, dataDir, resolveAppRoot } from "./paths.js";
import { ensurePuzzleRating } from "./puzzles/rating.js";
import { seedPuzzles } from "./puzzles/seed.js";
import { ReviewDesk } from "./srs/review.js";
import { allowedOriginsFrom } from "./ws/origin.js";

assertSubscriptionAuth();

const port = Number(process.env.PORT ?? 3210);
const logDir = join(dataDir(), "logs");
const log = createFileLog({ dir: logDir });
log.info("server.start", {
  port,
  data_dir: dataDir(),
  content_dir: contentDir(),
  node: process.version,
  pid: process.pid,
  commit: currentCommit(),
});
log.info("logs.pruned", { dir: logDir, removed: pruneLogs(logDir) });
// A crash that nothing caught still leaves its stack in the log before the process goes.
process.on("uncaughtException", (error) => {
  log.error("process.uncaught_exception", error);
  process.exit(1);
});
// Adding this listener turns off Node's own exit on an unhandled rejection, so it exits here: a
// server whose listen failed must stop rather than stay up without listening.
process.on("unhandledRejection", (reason) => {
  log.error("process.unhandled_rejection", reason);
  process.exit(1);
});
let readiness: Readiness = { ready: false, reason: "coach is starting" };
// Once a turn has failed for good the server stays not-ready until a restart finishes it.
let engineFault = false;
const db = openDatabase(dataDir());
// A missing or malformed table throws here, naming <file>:<line>, before anything else starts.
const openingNames = loadOpeningNames(contentDir());
// The same table's lines, for the positions where the Italian can branch into another variation.
const repertoireBranches = loadRepertoireBranchBook(contentDir());
const pool = new EnginePool(() => spawnStockfish());
// The sinks read `coach` when a turn commits, long after the constant below is initialised.
const sinks = coachNotificationSinks({ ensureSessionId: (tab) => coach.ensureSessionId(tab) });
const game = new GameService({
  db,
  engine: poolGameEngine(pool),
  notifications: sinks.game,
  log,
});
const notifications = sinks.training;
const desk = new ReviewDesk({ db, notifications });
const activity = new ActivityService({
  db,
  game,
  training: {
    desk,
    notifications,
    onNotification: () => coach.flushNotifications(),
    repertoireJudge: repertoireTryJudge(openingNames, pool.evaluation),
  },
  log,
});
// The token is read per request, so saving one in Connections lights the shares up with no
// restart; without one the route answers with null shares and makes no call.
const listAddable = () => {
  const token = resolveLichessToken(db);
  const explorer = token
    ? new CachedExplorer(
        httpExplorerFetcher(token),
        join(dataDir(), "explorer-cache"),
        systemExplorerClock,
      )
    : null;
  return listAddableOpenings(db, openingNames, explorer);
};
// Each run starts its own Claude sessions, so nothing here holds a process open between runs.
const runRepertoireIdeas = () =>
  generateRepertoireIdeas(db, sdkIdeaSession(query, { cwd: dataDir() }), log);
const runFoundNotes = () =>
  generateFoundNotes(
    db,
    sdkIdeaSession(query, { cwd: dataDir(), systemPrompt: FOUND_NOTE_SYSTEM_PROMPT }),
    log,
  );
const coach = new CoachSession({
  db,
  query,
  contentDir: contentDir(),
  dataDir: dataDir(),
  onUserText: (messageId) => activity.linkUserMessage(messageId),
  log,
  world: {
    game,
    activity,
    training: activity,
    analyze: (fen) => pool.analyze(fen),
    evaluateMove: (fen, moveUci, color) => evaluatePlayerMove(pool.evaluation, fen, moveUci, color),
  },
});
// The Games conversation is the one that reads about a stored game, and the coach's own sinks do not
// cover it. `coach` is read when a review commits, long after the constants here are initialised.
const gamesNotifications = { sessionId: () => coach.ensureSessionId("games") };
// The one wiring of names into routes and the review into grading: the composition test pins both.
const composed = composeServer({
  db,
  openingNames,
  repertoireBranches,
  cacheDir: join(dataDir(), "explorer-cache"),
  engine: pool.evaluation,
  fetcherFor: () => httpExplorerFetcher(resolveLichessToken(db)),
  explorerClock: systemExplorerClock,
  evaluate: (fen, moveUci, color) => evaluatePlayerMove(pool.evaluation, fen, moveUci, color),
  log,
  notifications: gamesNotifications,
  onNotification: () => coach.flushNotifications(),
  appExtras: {
    readiness: () => readiness,
    hub: {
      analyse: (request) => pool.analyzeWith(request),
      coach,
      activity,
      db,
      allowedOrigins: allowedOriginsFrom(),
    },
    connections: {
      chessCom: httpFetcher(),
      explorerFor: (token) => httpExplorerFetcher(token),
      allowedOrigins: allowedOriginsFrom(),
    },
    importer: {
      source: new ChessComSource(httpFetcher()),
      usernames: (process.env.CHESS_COACH_USERNAMES ?? "").split(",").filter(Boolean),
    },
    generateRepertoireIdeas: runRepertoireIdeas,
    generateFoundNotes: runFoundNotes,
    listAddableOpenings: listAddable,
  },
});
const importGrader = composed.grader;
const app = composed.app;
// A bad puzzle entry throws here, naming <file>:<index>, before anything else starts.
const seeded = seedPuzzles(db, contentDir(), openingNames);
log.info("puzzles.seeded", { inserted: seeded.inserted, updated: seeded.updated });
const puzzleRating = ensurePuzzleRating(db, systemClock);
log.info("puzzles.rating", { rating: puzzleRating.rating, replayed: puzzleRating.replayed });
game.onNotification(() => coach.flushNotifications());
// The fault itself is logged by the game service; here it only changes what /api/health says.
game.onEngineFault(() => {
  engineFault = true;
  readiness = { ready: false, reason: "engine_fault" };
});

// The engines start before listening so a turn cut off by the last shutdown is finished before
// any browser connects. A missing Stockfish does not stop the server: it reports why on /api/health.
const engines = await bootEngines(pool);
if (engines.ok) {
  log.info("engine.start", { ok: true });
  await game.recover().then(
    () => log.info("game.recovered", { game_id: game.current()?.id ?? null }),
    (error: unknown) => log.error("game.recovery_failed", error),
  );
  if (game.current()?.finishedAt === null) await activity.enterLiveGame();
  // Games imported before the last shutdown resume grading where they stopped.
  importGrader.kick();
} else {
  readiness = { ready: false, reason: engines.reason };
  log.warn("engine.start_failed", { reason: engines.reason, detail: engines.detail });
}

app.listen({ port, host: "127.0.0.1" }).then(async (address) => {
  log.info("server.listening", { address });
  try {
    await coach.start();
    log.info("coach.started", {
      coach_session_ids: {
        play: coach.conversationRow("play")?.id ?? null,
        games: coach.conversationRow("games")?.id ?? null,
        practice: coach.conversationRow("practice")?.id ?? null,
      },
    });
    if (engines.ok && !engineFault) readiness = { ready: true };
  } catch (error) {
    readiness = { ready: false, reason: error instanceof Error ? error.message : String(error) };
    log.error("coach.start_failed", error);
  }
});

// The runner and the process manager can both forward the same signal; the first one wins.
let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  log.info("server.stop", { signal });
  void Promise.all([coach.stop(), pool.stop()]).finally(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Which code produced a log line matters when the server runs from a tree that moves under it.
function currentCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: resolveAppRoot(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
