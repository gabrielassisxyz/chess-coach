import type { FastifyInstance } from "fastify";
import type { AppOptions } from "./app.js";
import { buildApp } from "./app.js";
import { type Clock, systemClock } from "./clock.js";
import type { Database } from "./db/open.js";
import { endRunsLeftOpenAtStart } from "./db/training.js";
import type { Searcher } from "./engine/uci.js";
import type { NotificationSink } from "./game/notifications.js";
import { type EvaluateMove, ImportGrader } from "./import/grader.js";
import { type Log, silentLog } from "./log.js";
import type { ExplorerClock, ExplorerFetcher } from "./openings/explorer-client.js";
import { generateExplorerPuzzles } from "./openings/from-explorer.js";
import { generateOpeningPuzzles } from "./openings/from-games.js";
import { generateItalianPuzzles } from "./openings/from-italian.js";
import {
  generateRepertoire,
  type RepertoireBranchBook,
  type RepertoirePoints,
  type RepertoireResult,
} from "./openings/from-repertoire.js";
import type { OpeningNames } from "./openings/names.js";
import { reviewRepertoireGames } from "./openings/repertoire-review.js";

/**
 * The `buildApp` inputs the entry point owns besides the composed ones: readiness, the
 * websocket hub, the connections and import sources, and the ideas run. Everything that
 * names an opening or grades an import is composed here, so the test and the entry point
 * share the one wiring.
 */
export interface ComposeAppExtras {
  readiness?: AppOptions["readiness"];
  hub?: AppOptions["hub"];
  connections?: AppOptions["connections"];
  importer?: Omit<NonNullable<AppOptions["importer"]>, "grader">;
  generateRepertoireIdeas?: AppOptions["generateRepertoireIdeas"];
  listAddableOpenings?: AppOptions["listAddableOpenings"];
}

export interface ComposeOptions {
  db: Database;
  /** Names the opening of each game from its positions; without it no game carries one. */
  openingNames: OpeningNames;
  /** The book's branch points in the Italian, which the openings menu offers new variations at. */
  repertoireBranches: RepertoireBranchBook;
  /** Where the explorer answers are cached, one directory per data directory. */
  cacheDir: string;
  /** The evaluation lane: searched for drills and scored for grading. */
  engine: Searcher;
  /** Called anew for every explorer run, so a saved token applies without a restart. */
  fetcherFor: () => ExplorerFetcher;
  explorerClock: ExplorerClock;
  /** Grades one student move; the entry point binds it to the engine pool. */
  evaluate: EvaluateMove;
  log?: Log;
  clock?: Clock;
  /** Where the coach's message about each reviewed game is written. */
  notifications?: NotificationSink;
  /** Called once after a run that wrote messages, so the coach reads them. */
  onNotification?: () => void;
  appExtras?: ComposeAppExtras;
}

export interface ComposedServer {
  app: FastifyInstance;
  grader: ImportGrader;
  openingNames: OpeningNames;
  repertoireBranches: RepertoireBranchBook;
}

/**
 * Logs the opening names table and wires it into the games routes and the import
 * grader's after-grading hook, which reviews the repertoire before rebuilding the
 * opening drills. Removing either connection leaves the suite green without this module,
 * so the composition test pins both here.
 */
export function composeServer(options: ComposeOptions): ComposedServer {
  const log = options.log ?? silentLog;
  const { openingNames, repertoireBranches } = options;
  log.info("openings.names_loaded", {
    positions: openingNames.size,
    branch_points: repertoireBranches.length,
  });
  // Before the server listens: no board survives a restart, so a run still open belongs to the
  // process that is gone.
  const runsLeft = endRunsLeftOpenAtStart(
    options.db,
    (options.clock ?? systemClock).now().toISOString(),
  );
  log.info("training.runs_left", { count: runsLeft });

  const generateOpenings = () => generateOpeningPuzzles(options.db, options.engine, openingNames);
  const generateExplorerOpenings = () =>
    generateExplorerPuzzles(
      options.db,
      options.engine,
      options.fetcherFor(),
      options.cacheDir,
      options.explorerClock,
      {},
      openingNames,
    );
  const generateItalianOpenings = () =>
    generateItalianPuzzles(
      options.db,
      options.engine,
      options.fetcherFor(),
      options.cacheDir,
      options.explorerClock,
      {},
      openingNames,
    );
  const generateRepertoireOpenings = (
    root?: readonly string[],
    branch?: readonly string[],
    rebuild?: boolean,
    points?: RepertoirePoints,
  ): Promise<RepertoireResult> =>
    generateRepertoire(
      options.db,
      options.engine,
      options.fetcherFor(),
      options.cacheDir,
      options.explorerClock,
      openingNames,
      { root, branch, rebuild, points },
    );
  // The review logs a failing game itself and goes on, so it runs first: whatever the
  // openings step does, every game that was graded has been compared by then.
  const reviewAfterGrading = () =>
    reviewRepertoireGames({
      db: options.db,
      engine: options.engine,
      fetcher: options.fetcherFor(),
      cacheDir: options.cacheDir,
      explorerClock: options.explorerClock,
      names: openingNames,
      log,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.notifications ? { notifications: options.notifications } : {}),
      ...(options.onNotification ? { onNotification: options.onNotification } : {}),
    });
  const grader = new ImportGrader({
    db: options.db,
    log,
    evaluate: options.evaluate,
    onGraded: async () => {
      const repertoire = await reviewAfterGrading();
      return { repertoire, openings: await generateOpenings() };
    },
  });

  const extras = options.appExtras ?? {};
  const app = buildApp({
    db: options.db,
    openingNames,
    repertoireBranches,
    generateOpenings,
    generateExplorerOpenings,
    generateItalianOpenings,
    generateRepertoireOpenings,
    log,
    ...(extras.readiness ? { readiness: extras.readiness } : {}),
    ...(extras.hub ? { hub: extras.hub } : {}),
    ...(extras.connections ? { connections: extras.connections } : {}),
    ...(extras.generateRepertoireIdeas
      ? { generateRepertoireIdeas: extras.generateRepertoireIdeas }
      : {}),
    ...(extras.listAddableOpenings ? { listAddableOpenings: extras.listAddableOpenings } : {}),
    ...(extras.importer ? { importer: { ...extras.importer, grader } } : {}),
  });
  return { app, grader, openingNames, repertoireBranches };
}
