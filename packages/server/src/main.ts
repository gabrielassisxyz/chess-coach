import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildApp, type Readiness } from "./app.js";
import { assertSubscriptionAuth } from "./coach/auth.js";
import { CoachSession } from "./coach/session.js";
import { openDatabase } from "./db/open.js";
import { contentDir, dataDir } from "./paths.js";

assertSubscriptionAuth();

const port = Number(process.env.PORT ?? 3000);
let readiness: Readiness = { ready: false, reason: "coach is starting" };
const app = buildApp({ readiness: () => readiness });

const coach = new CoachSession({
  db: openDatabase(dataDir()),
  query,
  contentDir: contentDir(),
  dataDir: dataDir(),
});

app.listen({ port, host: "127.0.0.1" }).then(async (address) => {
  console.log(`chess-coach server listening on ${address}`);
  try {
    await coach.start();
    readiness = { ready: true };
  } catch (error) {
    readiness = { ready: false, reason: error instanceof Error ? error.message : String(error) };
    console.error(`coach failed to start: ${readiness.reason}`);
  }
});

process.on("SIGINT", () => void coach.stop().finally(() => process.exit(0)));
process.on("SIGTERM", () => void coach.stop().finally(() => process.exit(0)));
