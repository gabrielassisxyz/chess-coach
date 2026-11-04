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
import { httpExplorerFetcher, systemExplorerClock } from "./openings/explorer-client.js";
import { generateExplorerPuzzles } from "./openings/from-explorer.js";
import { generateOpeningPuzzles } from "./openings/from-games.js";
import { contentDir, dataDir } from "./paths.js";
import { seedPuzzles } from "./puzzles/seed.js";
import { ReviewDesk } from "./srs/review.js";
import { allowedOriginsFrom } from "./ws/origin.js";

assertSubscriptionAuth();

const port = Number(process.env.PORT ?? 3210);
let readiness: Readiness = { ready: false, reason: "coach is starting" };
// Once a turn has failed for good the server stays not-ready until a restart finishes it.
let engineFault = false;
const db = openDatabase(dataDir());
// A bad puzzle entry throws here, naming <file>:<index>, before anything else starts.
const seeded = seedPuzzles(db, contentDir());
console.log(`puzzles seeded: ${seeded.inserted} new, ${seeded.updated} updated`);
const pool = new EnginePool(() => spawnStockfish());
// The sink reads `coach` when a turn commits, long after the constant below is initialised.
const game = new GameService({
  db,
  engine: poolGameEngine(pool),
  notifications: { sessionId: () => coach.ensureSessionId() },
});
const notifications = { sessionId: () => coach.ensureSessionId() };
const desk = new ReviewDesk({ db, notifications });
const activity = new ActivityService({
  db,
  game,
  training: { desk, notifications, onNotification: () => coach.flushNotifications() },
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
const importGrader = new ImportGrader({
  db,
  onGraded: generateOpenings,
  evaluate: (fen, moveUci, color) => evaluatePlayerMove(pool.evaluation, fen, moveUci, color),
});
const coach = new CoachSession({
  db,
  query,
  contentDir: contentDir(),
  dataDir: dataDir(),
  onUserText: (messageId) => activity.linkUserMessage(messageId),
  world: {
    game,
    activity,
    analyze: (fen) => pool.analyze(fen),
    evaluateMove: (fen, moveUci, color) => evaluatePlayerMove(pool.evaluation, fen, moveUci, color),
  },
});
game.onNotification(() => coach.flushNotifications());
game.onEngineFault((fault) => {
  engineFault = true;
  readiness = { ready: false, reason: "engine_fault" };
  console.error(`engine fault during a turn (${fault.reason}): ${fault.message}`);
});

// The engines start before listening so a turn cut off by the last shutdown is finished before
// any browser connects. A missing Stockfish does not stop the server: it reports why on /api/health.
const engines = await bootEngines(pool);
if (engines.ok) {
  await game.recover().catch((error: unknown) => {
    console.error(`game recovery failed: ${error instanceof Error ? error.message : error}`);
  });
  if (game.current()?.finishedAt === null) await activity.enterLiveGame();
  // Games imported before the last shutdown resume grading where they stopped.
  importGrader.kick();
} else {
  readiness = { ready: false, reason: engines.reason };
  console.error(`engine failed to start (${engines.reason}): ${engines.detail}`);
}

const app = buildApp({
  readiness: () => readiness,
  db,
  generateOpenings,
  generateExplorerOpenings,
  importer: {
    source: new ChessComSource(httpFetcher()),
    grader: importGrader,
    usernames: (process.env.CHESS_COACH_USERNAMES ?? "").split(",").filter(Boolean),
  },
  hub: { coach, activity, db, allowedOrigins: allowedOriginsFrom() },
});

app.listen({ port, host: "127.0.0.1" }).then(async (address) => {
  console.log(`chess-coach server listening on ${address}`);
  try {
    await coach.start();
    if (engines.ok && !engineFault) readiness = { ready: true };
  } catch (error) {
    readiness = { ready: false, reason: error instanceof Error ? error.message : String(error) };
    console.error(`coach failed to start: ${readiness.reason}`);
  }
});

const shutdown = (): void =>
  void Promise.all([coach.stop(), pool.stop()]).finally(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
