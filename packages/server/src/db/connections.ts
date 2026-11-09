import type { Database } from "./open.js";

const LICHESS_TOKEN_KEY = "lichess_api_token";
const CHESSCOM_USERNAME_KEY = "chesscom_username";

function read(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function write(db: Database, key: string, value: string, updatedAt: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, updatedAt);
}

function remove(db: Database, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

export function hasLichessToken(db: Database): boolean {
  return read(db, LICHESS_TOKEN_KEY) !== null;
}

export function setLichessToken(db: Database, token: string, updatedAt: string): void {
  write(db, LICHESS_TOKEN_KEY, token, updatedAt);
}

export function clearLichessToken(db: Database): void {
  remove(db, LICHESS_TOKEN_KEY);
}

// Read on every use, so a saved token applies without a restart. The environment wins so that a
// deployment configured through it keeps behaving the same.
export function resolveLichessToken(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.LICHESS_API_TOKEN || (read(db, LICHESS_TOKEN_KEY) ?? undefined);
}

export function storedChessComUsername(db: Database): string | null {
  return read(db, CHESSCOM_USERNAME_KEY);
}

export function setChessComUsername(db: Database, username: string, updatedAt: string): void {
  write(db, CHESSCOM_USERNAME_KEY, username, updatedAt);
}

export function clearChessComUsername(db: Database): void {
  remove(db, CHESSCOM_USERNAME_KEY);
}
