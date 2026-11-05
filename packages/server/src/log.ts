import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Clock, systemClock } from "./clock.js";

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

// The project's one logging interface. Every service takes it as a dependency, so a test hands in
// a RecordingLog and asserts on events instead of on text.
export interface Log {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, error: unknown, fields?: LogFields): void;
}

export const MAX_FIELD_BYTES = 8 * 1024;
export const LOG_RETENTION_DAYS = 30;
const LOG_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return { error_name: error.name, error_message: error.message, stack: error.stack };
  }
  return { error_name: typeof error, error_message: String(error) };
}

// A field too big to read in one line is cut, not dropped: the head of a tool result is what an
// investigation usually needs, and `truncated` says the rest exists.
export function boundFields(fields: LogFields): { fields: LogFields; truncated: boolean } {
  let truncated = false;
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text = typeof value === "string" ? value : null;
    const size = text ?? (typeof value === "object" && value !== null ? safeJson(value) : null);
    if (size !== null && Buffer.byteLength(size) > MAX_FIELD_BYTES) {
      out[key] = Buffer.from(size).subarray(0, MAX_FIELD_BYTES).toString();
      truncated = true;
    } else {
      out[key] = value;
    }
  }
  return { fields: out, truncated };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

export function formatLine(
  at: Date,
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): string {
  const bounded = boundFields(fields);
  const line: LogFields = { ts: at.toISOString(), level, event, ...bounded.fields };
  if (bounded.truncated) line.truncated = true;
  return safeJson(line);
}

export interface FileLogOptions {
  dir: string;
  clock?: Clock;
  /** Where the copy for the journal goes; stdout unless a test replaces it. */
  echo?: (line: string) => void;
}

// One file per UTC day under the data directory, so the record survives however the server was
// started; the stdout copy is for the journal when it runs under systemd.
export function createFileLog(options: FileLogOptions): Log {
  const clock = options.clock ?? systemClock;
  const echo = options.echo ?? ((line: string) => process.stdout.write(`${line}\n`));
  mkdirSync(options.dir, { recursive: true });
  const write = (level: LogLevel, event: string, fields?: LogFields): void => {
    const at = clock.now();
    const line = formatLine(at, level, event, fields);
    try {
      appendFileSync(join(options.dir, `${at.toISOString().slice(0, 10)}.jsonl`), `${line}\n`);
    } catch {
      // A full disk must not take the game down with it; the echo still carries the line.
    }
    echo(line);
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, error, fields) => write("error", event, { ...fields, ...errorFields(error) }),
  };
}

/** Deletes the daily files older than `days`; returns how many went. */
export function pruneLogs(dir: string, clock: Clock = systemClock, days = LOG_RETENTION_DAYS) {
  const cutoff = clock.now().getTime() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const match = LOG_FILE.exec(name);
    if (!match) continue;
    if (Date.parse(`${match[1]}T00:00:00Z`) >= cutoff) continue;
    rmSync(join(dir, name), { force: true });
    removed += 1;
  }
  return removed;
}

export interface LoggedEvent {
  level: LogLevel;
  event: string;
  fields: LogFields;
}

// The named fake for tests: keeps every event in order, with the fields as they were passed.
export class RecordingLog implements Log {
  readonly events: LoggedEvent[] = [];

  info(event: string, fields: LogFields = {}): void {
    this.events.push({ level: "info", event, fields });
  }

  warn(event: string, fields: LogFields = {}): void {
    this.events.push({ level: "warn", event, fields });
  }

  error(event: string, error: unknown, fields: LogFields = {}): void {
    this.events.push({ level: "error", event, fields: { ...fields, ...errorFields(error) } });
  }

  named(event: string): LoggedEvent[] {
    return this.events.filter((entry) => entry.event === event);
  }

  names(): string[] {
    return this.events.map((entry) => entry.event);
  }
}

export const silentLog: Log = { info() {}, warn() {}, error() {} };
