import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ActivityService } from "./activity/service.js";
import { buildApp, type Readiness } from "./app.js";
import { assertSubscriptionAuth } from "./coach/auth.js";
import { CoachSession } from "./coach/session.js";
import { openDatabase } from "./db/open.js";
import { bootEngines } from "./engine/boot.js";
import { evaluatePlayerMove } from "./engine/evaluate.js";
import { EnginePool } from "./engine/pool.js";
import { spawnStockfish } from "./engine/process.js";
import { poolGameEngine } from "./game/engine.js";
import { GameService } from "./game/service.js";
import { ChessComSource, httpFetcher } from "./import/chesscom.js";
import { ImportGrader } from "./import/grader.js";
import { createFileLog, pruneLogs } from "./log.js";
import { httpExplorerFetcher, systemExplorerClock } from "./openings/explorer-client.js";
import { generateExplorerPuzzles } from "./openings/from-explorer.js";
import { generateOpeningPuzzles } from "./openings/from-games.js";
import { generateItalianPuzzles } from "./openings/from-italian.js";
import { contentDir, dataDir, resolveAppRoot } from "./paths.js";
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
// A bad puzzle entry throws here, naming <file>:<index>, before anything else starts.
const seeded = seedPuzzles(db, contentDir());
log.info("puzzles.seeded", { inserted: seeded.inserted, updated: seeded.updated });
const pool = new EnginePool(() => spawnStockfish());
// The sink reads `coach` when a turn commits, long after the constant below is initialised.
const game = new GameService({
  db,
  engine: poolGameEngine(pool),
  notifications: { sessionId: () => coach.ensureSessionId() },
  log,
});
const notifications = { sessionId: () => coach.ensureSessionId() };
const desk = new ReviewDesk({ db, notifications });
const activity = new ActivityService({
  db,
  game,
  training: { desk, notifications, onNotification: () => coach.flushNotifications() },
  log,
});
const generateOpenings = () => generateOpeningPuzzles(db, pool.evaluation);
const generateExplorerOpenings = () =>
  generateExplorerPuzzles(
    db,
    pool.evaluation,
    httpExplorerFetcher(process.env.LICHESS_API_TOKEN),
    join(dataDir(), "explorer-cache"),
    systemExplorerClock,
  );
const generateItalianOpenings = () =>
  generateItalianPuzzles(
    db,
    pool.evaluation,
    httpExplorerFetcher(process.env.LICHESS_API_TOKEN),
    join(dataDir(), "explorer-cache"),
    systemExplorerClock,
  );
const importGrader = new ImportGrader({
  db,
  log,
  onGraded: generateOpenings,
  evaluate: (fen, moveUci, color) => evaluatePlayerMove(pool.evaluation, fen, moveUci, color),
});
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

const app = buildApp({
  readiness: () => readiness,
  db,
  generateOpenings,
  generateExplorerOpenings,
  generateItalianOpenings,
  importer: {
    source: new ChessComSource(httpFetcher()),
    grader: importGrader,
    usernames: (process.env.CHESS_COACH_USERNAMES ?? "").split(",").filter(Boolean),
  },
  hub: { coach, activity, db, allowedOrigins: allowedOriginsFrom() },
  log,
});

app.listen({ port, host: "127.0.0.1" }).then(async (address) => {
  log.info("server.listening", { address });
  try {
    await coach.start();
    log.info("coach.started", { coach_session_id: coach.sessionRow?.id ?? null });
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
