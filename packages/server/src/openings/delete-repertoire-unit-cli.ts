import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import BetterSqlite3 from "better-sqlite3";
import { systemClock } from "../clock.js";
import { resolveLichessToken } from "../db/connections.js";
import { defaultMigrationsDir, listMigrations } from "../db/migrate.js";
import type { Database } from "../db/open.js";
import { findDrillRepertoire, listDrillRepertoires } from "../db/repertoire-cards.js";
import {
  deleteRepertoireUnit,
  listRepertoireGroupVariations,
  type RepertoireRow,
  type RepertoireUnitDeletion,
  repertoireSetupLine,
} from "../db/repertoires.js";
import { spawnStockfish } from "../engine/process.js";
import { UciEngine } from "../engine/uci.js";
import { contentDir, dataDir } from "../paths.js";
import { httpExplorerFetcher, systemExplorerClock } from "./explorer-client.js";
import { loadOpeningNames } from "./names.js";
import { type GameReviewDeps, reviewRepertoireGame } from "./repertoire-review.js";

// The command removes the unit the hub's Add built from 1.e4 e5 2.Nf3 Qf6 and nothing else: a
// group rooted anywhere else is refused before anything is written.
const DELETABLE_UNIT_SETUP_LINE = "e4 e5 Nf3 Qf6";

const DELETE_UNIT_USAGE =
  'usage: pnpm --filter @chess-coach/server delete:repertoire-unit -- --group "<group>" [--dry-run]';

export interface RepertoireUnitDeleteCommandDeps {
  /**
   * Called once the arguments are read: the database the unit is deleted from, as `db`, opened as
   * it is with foreign keys on, and what its games are reviewed again with.
   */
  open: () => GameReviewDeps;
  out: (line: string) => void;
  err: (line: string) => void;
}

type DeleteUnitArgs = { ok: true; group: string; dryRun: boolean } | { ok: false; reason: string };

function parseDeleteUnitArgs(argv: readonly string[]): DeleteUnitArgs {
  // pnpm passes on the `--` that ends its own flags, which parseArgs would take for the end of ours.
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  try {
    const { values } = parseArgs({
      args,
      options: { group: { type: "string" }, "dry-run": { type: "boolean" } },
      strict: true,
      allowPositionals: false,
    });
    if (!values.group) return { ok: false, reason: "--group is required" };
    return { ok: true, group: values.group, dryRun: values["dry-run"] === true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// Migrating is the server's: opening the database the way it does would apply this checkout's new
// migrations, a write even in a refusal or a dry run, under a service that may run older code. So
// the command runs only on a database whose migrations are exactly this checkout's.
function migrationMismatch(db: Database): string | null {
  const known = listMigrations(defaultMigrationsDir);
  const rows = db.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>;
  const applied = new Set(rows.map((row) => row.name));
  const missing = known.filter((name) => !applied.has(name));
  if (missing.length > 0) {
    return `the database lacks ${missing.join(", ")}: start the server from this checkout first, it migrates at boot`;
  }
  const unknown = [...applied].filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    return `the database holds ${unknown.join(", ")}, which this checkout lacks: run the command from the checkout the server runs`;
  }
  return null;
}

type UnitToDelete =
  | { ok: true; unit: RepertoireRow; setup: string[] }
  | { ok: false; reason: string };

// A missing group is refused with the stored ones listed: a unit's group is the book's whole name
// for its root position, so the family name alone finds nothing.
function findUnitToDelete(db: Database, group: string): UnitToDelete {
  const variations = listRepertoireGroupVariations(db, "white", group);
  const [unit] = variations;
  if (!unit) {
    const groups = new Set(
      listDrillRepertoires(db)
        .filter((stored) => stored.side === "white")
        .map((stored) => `"${stored.group_name}"`),
    );
    const named = [...groups].join(", ") || "none";
    return { ok: false, reason: `no unit is stored under the group "${group}"; groups: ${named}` };
  }
  if (variations.length > 1) {
    const names = variations.map((variation) => `"${variation.variation_name}"`).join(", ");
    return {
      ok: false,
      reason: `the group "${group}" holds ${variations.length} variations (${names}), not one`,
    };
  }
  const setup = repertoireSetupLine(db, unit.id);
  if (setup.join(" ") !== DELETABLE_UNIT_SETUP_LINE) {
    return {
      ok: false,
      reason: `unit ${unit.id} is rooted at "${setup.join(" ")}", not at "${DELETABLE_UNIT_SETUP_LINE}"`,
    };
  }
  return { ok: true, unit, setup };
}

// The delete runs and is rolled back, so a dry run prints the counts the same code would return
// and keeps nothing it did.
function previewRepertoireUnitDeletion(
  db: Database,
  repertoireId: number,
  at: string,
): RepertoireUnitDeletion {
  db.exec("BEGIN");
  try {
    return deleteRepertoireUnit(db, repertoireId, at);
  } finally {
    if (db.inTransaction) db.exec("ROLLBACK");
  }
}

function printUnitToDelete(
  out: (line: string) => void,
  unit: RepertoireRow,
  setup: readonly string[],
): void {
  out(`repertoire: ${unit.id}`);
  out(`group: ${unit.group_name}`);
  out(`variation: ${unit.variation_name}`);
  out(`setup line: ${setup.join(" ")}`);
}

function printUnitDeletionCounts(
  out: (line: string) => void,
  deletion: RepertoireUnitDeletion,
): void {
  const games = deletion.gamesToReview;
  out(`positions: ${deletion.positions}`);
  out(`cards deleted: ${deletion.cardsDeleted}`);
  out(`cards kept: ${deletion.cardsKept}`);
  out(`runs ended: ${deletion.runsEnded}`);
  out(`games to review: ${games.length}${games.length > 0 ? ` (${games.join(", ")})` : ""}`);
}

// After the commit, each game is compared with the units that remain by the grader's own review.
// One that throws keeps no review row, so the review run after the next graded game tries it again.
async function reviewGamesAgain(
  review: GameReviewDeps,
  deps: RepertoireUnitDeleteCommandDeps,
  gameIds: readonly number[],
): Promise<number> {
  let failed = 0;
  for (const gameId of gameIds) {
    try {
      const result = await reviewRepertoireGame(review, gameId);
      if (!result) {
        deps.out(
          `game ${gameId}: not reviewed, no Italian Game is stored or it was reviewed meanwhile`,
        );
        continue;
      }
      const against = findDrillRepertoire(review.db, result.repertoireId);
      const named = against ? ` (${against.group_name}: ${against.variation_name})` : "";
      deps.out(
        `game ${gameId}: ${result.outcome} against repertoire ${result.repertoireId}${named}`,
      );
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      deps.err(`game ${gameId}: review failed, left for the next review run: ${message}`);
    }
  }
  return failed;
}

/**
 * Deletes the one unit of a group, if it is rooted at 1.e4 e5 2.Nf3 Qf6, and reviews again the
 * games whose review named it; with `--dry-run` it prints the same and writes nothing. Returns the
 * exit status: 2 for a usage error, 1 for a refusal or a game whose review failed.
 */
export async function runRepertoireUnitDeleteCommand(
  argv: readonly string[],
  deps: RepertoireUnitDeleteCommandDeps,
): Promise<number> {
  const args = parseDeleteUnitArgs(argv);
  if (!args.ok) {
    deps.err(args.reason);
    deps.err(DELETE_UNIT_USAGE);
    return 2;
  }
  const review = deps.open();
  const { db } = review;
  const mismatch = migrationMismatch(db);
  if (mismatch !== null) {
    deps.err(`refused: ${mismatch}`);
    return 1;
  }
  const target = findUnitToDelete(db, args.group);
  if (!target.ok) {
    deps.err(`refused: ${target.reason}`);
    return 1;
  }
  printUnitToDelete(deps.out, target.unit, target.setup);
  const at = (review.clock ?? systemClock).now().toISOString();
  if (args.dryRun) {
    printUnitDeletionCounts(deps.out, previewRepertoireUnitDeletion(db, target.unit.id, at));
    deps.out("dry run: nothing was written");
    return 0;
  }
  const deletion = deleteRepertoireUnit(db, target.unit.id, at);
  printUnitDeletionCounts(deps.out, deletion);
  return (await reviewGamesAgain(review, deps, deletion.gamesToReview)) === 0 ? 0 : 1;
}

// The file as it is, never created: a mistyped data directory fails here instead of leaving an
// empty database behind. Foreign keys are on as the server has them, since the delete counts on
// the cascade.
function openDatabaseAsItIs(directory: string): Database {
  const db = new BetterSqlite3(join(directory, "chess-coach.db"), { fileMustExist: true });
  db.pragma("foreign_keys = ON");
  return db;
}

// The engine starts only if a game's review has to search; a refusal or a dry run never spawns it.
async function main(): Promise<number> {
  const opened: { db?: Database } = {};
  const engine = new UciEngine(() => spawnStockfish());
  try {
    return await runRepertoireUnitDeleteCommand(process.argv.slice(2), {
      open: () => {
        const db = openDatabaseAsItIs(dataDir());
        opened.db = db;
        return {
          db,
          engine,
          fetcher: httpExplorerFetcher(resolveLichessToken(db)),
          cacheDir: join(dataDir(), "explorer-cache"),
          explorerClock: systemExplorerClock,
          names: loadOpeningNames(contentDir()),
          clock: systemClock,
        };
      },
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    await engine.stop();
    opened.db?.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
