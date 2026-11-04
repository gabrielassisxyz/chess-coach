import type { Database } from "./open.js";

export type RoutineAuthor = "coach" | "student" | "import";

export interface Routine {
  id: number;
  week_start: string;
  body: string;
  written_by: RoutineAuthor;
  created_at: string;
}

export interface NewRoutine {
  weekStart: string;
  body: string;
  writtenBy: RoutineAuthor;
  createdAt: string;
}

export const ROUTINE_BODY_MIN = 200;
export const ROUTINE_BODY_MAX = 8000;

export function insertRoutine(db: Database, routine: NewRoutine): number {
  const result = db
    .prepare("INSERT INTO routines (week_start, body, written_by, created_at) VALUES (?, ?, ?, ?)")
    .run(routine.weekStart, routine.body, routine.writtenBy, routine.createdAt);
  return Number(result.lastInsertRowid);
}

// Newest by id: two writes in the same millisecond still have a defined order.
export function newestRoutine(db: Database): Routine | undefined {
  return db.prepare("SELECT * FROM routines ORDER BY id DESC LIMIT 1").get() as Routine | undefined;
}

export function listRoutines(db: Database, limit: number): Routine[] {
  return db.prepare("SELECT * FROM routines ORDER BY id DESC LIMIT ?").all(limit) as Routine[];
}

export function hasImportedBody(db: Database, body: string): boolean {
  return (
    db.prepare("SELECT 1 FROM routines WHERE written_by = 'import' AND body = ?").get(body) !==
    undefined
  );
}
