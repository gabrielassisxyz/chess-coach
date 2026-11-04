import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { runMigrations } from "./migrate.js";

export type { Database };

export function openDatabase(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new BetterSqlite3(join(dataDir, "chess-coach.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}
