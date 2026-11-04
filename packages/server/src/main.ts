import { query } from "@anthropic-ai/claude-agent-sdk";
import { ActivityService } from "./activity/service.js";
import { buildApp, type Readiness } from "./app.js";
import { assertSubscriptionAuth } from "./coach/auth.js";
import { CoachSession } from "./coach/session.js";
import { openDatabase } from "./db/open.js";
import { bootEngines } from "./engine/boot.js";
import { EnginePool } from "./engine/pool.js";
import { spawnStockfish } from "./engine/process.js";
import { poolGameEngine } from "./game/engine.js";
import { GameService } from "./game/service.js";
import { contentDir, dataDir } from "./paths.js";
import { allowedOriginsFrom } from "./ws/origin.js";

assertSubscriptionAuth();

const port = Number(process.env.PORT ?? 3210);
let readiness: Readiness = { ready: false, reason: "coach is starting" };
const db = openDatabase(dataDir());
const coach = new CoachSession({
  db,
  query,
  contentDir: contentDir(),
  dataDir: dataDir(),
});
const pool = new EnginePool(() => spawnStockfish());
const game = new GameService({ db, engine: poolGameEngine(pool) });
const activity = new ActivityService({ db, game });

// The engines start before listening so a turn cut off by the last shutdown is finished before
// any browser connects. A missing Stockfish does not stop the server: it reports why on /api/health.
const engines = await bootEngines(pool);
if (engines.ok) {
  await game.recover().catch((error: unknown) => {
    console.error(`game recovery failed: ${error instanceof Error ? error.message : error}`);
  });
  if (game.current()?.finishedAt === null) await activity.enterLiveGame();
} else {
  readiness = { ready: false, reason: engines.reason };
  console.error(`engine failed to start (${engines.reason}): ${engines.detail}`);
}

const app = buildApp({
  readiness: () => readiness,
  hub: { coach, activity, db, allowedOrigins: allowedOriginsFrom() },
});

app.listen({ port, host: "127.0.0.1" }).then(async (address) => {
  console.log(`chess-coach server listening on ${address}`);
  try {
    await coach.start();
    if (engines.ok) readiness = { ready: true };
  } catch (error) {
    readiness = { ready: false, reason: error instanceof Error ? error.message : String(error) };
    console.error(`coach failed to start: ${readiness.reason}`);
  }
});

const shutdown = (): void =>
  void Promise.all([coach.stop(), pool.stop()]).finally(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
