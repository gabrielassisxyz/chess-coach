import { type SdkMcpToolDefinition, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Database } from "../db/open.js";
import {
  insertRoutine,
  newestRoutine,
  ROUTINE_BODY_MAX,
  ROUTINE_BODY_MIN,
} from "../db/routines.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isMonday(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) && date.getUTCDay() === 1
  );
}

export const writeRoutineInput = {
  body: z.string().min(ROUTINE_BODY_MIN).max(ROUTINE_BODY_MAX),
  week_start: z
    .string()
    .refine(isMonday, "week_start must be a Monday as an ISO date (YYYY-MM-DD)"),
};

function textResult(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export interface RoutineToolDeps {
  db: Database;
  now: () => Date;
}

// Every write is a new row: the coach never edits a plan in place.
// biome-ignore lint/suspicious/noExplicitAny: the SDK types a server's tool list as `any` schemas
export function buildRoutineTools({ db, now }: RoutineToolDeps): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "read_routine",
      "Read the newest weekly routine with its week start and the date it was written, or null when none exists.",
      {},
      async () => {
        const routine = newestRoutine(db);
        if (!routine) return textResult({ routine: null });
        const { id, week_start, body, written_by, created_at } = routine;
        return textResult({ routine: { id, week_start, body, written_by, created_at } });
      },
    ),
    tool(
      "write_routine",
      "Save a new version of the weekly routine (Markdown, 200 to 8000 characters) for the week starting on the given Monday. Returns the new id.",
      writeRoutineInput,
      async ({ body, week_start }) => {
        const id = insertRoutine(db, {
          weekStart: week_start,
          body,
          writtenBy: "coach",
          createdAt: now().toISOString(),
        });
        return textResult({ id });
      },
    ),
  ];
}
