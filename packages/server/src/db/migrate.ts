import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3";
import { type Clock, systemClock } from "../clock.js";

const MIGRATION_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;

export const defaultMigrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

export function listMigrations(dir: string): string[] {
  const names = readdirSync(dir).sort();
  const seen = new Map<string, string>();
  for (const name of names) {
    const match = MIGRATION_NAME.exec(name);
    if (!match) throw new Error(`invalid migration filename: ${name}`);
    const number = match[1] as string;
    const first = seen.get(number);
    if (first) throw new Error(`duplicate migration number ${number}: ${first} and ${name}`);
    seen.set(number, name);
  }
  return names;
}

// The first migration creates schema_migrations itself, so a fresh file has no table to read yet.
function appliedNames(db: Database): Set<string> {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!table) return new Set();
  const rows = db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

export function runMigrations(
  db: Database,
  dir: string = defaultMigrationsDir,
  clock: Clock = systemClock,
): string[] {
  const names = listMigrations(dir);
  const applied = appliedNames(db);
  const ran: string[] = [];
  for (const name of names) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(dir, name), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        name,
        clock.now().toISOString(),
      );
    })();
    ran.push(name);
  }
  return ran;
}
