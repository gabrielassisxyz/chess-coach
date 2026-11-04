import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Database } from "../db/open.js";

export const MCP_SERVER_NAME = "chess";
export const REFERENCE_NAMES = [
  "chess-pedagogy",
  "common-mistakes",
  "curriculum",
  "elo-milestones",
  "learning-science",
  "opening-guide",
  "tactical-patterns",
] as const;
export const COACH_TOOL_NAMES = ["get_progress", "read_reference"].map(
  (name) => `mcp__${MCP_SERVER_NAME}__${name}`,
);

const REFERENCE_CHAR_LIMIT = 60_000;

export const referenceInput = { name: z.enum(REFERENCE_NAMES) };

export interface Progress {
  current_elo: number;
  games_played: number;
  cards_total: number;
  cards_due: number;
}

function tableExists(db: Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function countRows(db: Database, table: string, where = "1 = 1", ...params: string[]): number {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params);
  return (row as { n: number }).n;
}

function readElo(db: Database): number {
  if (!tableExists(db, "settings")) return 0;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'current_elo'").get();
  const parsed = Number((row as { value: string } | undefined)?.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Later migrations create the tables; until then every count is zero rather than an error.
export function getProgress(db: Database, now: Date = new Date()): Progress {
  return {
    current_elo: readElo(db),
    games_played: countRows(db, "games"),
    cards_total: countRows(db, "srs_cards"),
    cards_due: countRows(db, "srs_cards", "next_review_at <= ?", now.toISOString()),
  };
}

// The model names a reference by its stem; the path is built here so no input can reach outside.
export function readReference(contentDir: string, name: (typeof REFERENCE_NAMES)[number]): string {
  const text = readFileSync(join(contentDir, "references", `${name}.md`), "utf8");
  return text.slice(0, REFERENCE_CHAR_LIMIT);
}

function textResult(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

export interface CoachToolDeps {
  db: Database;
  contentDir: string;
  now?: () => Date;
}

export function createCoachMcpServer(deps: CoachToolDeps) {
  const now = deps.now ?? (() => new Date());
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    tools: [
      tool(
        "get_progress",
        "Current rating estimate, number of games played, and spaced-repetition card counts.",
        {},
        async () => textResult(JSON.stringify(getProgress(deps.db, now()))),
      ),
      tool(
        "read_reference",
        "Read one coaching reference document by name.",
        referenceInput,
        async ({ name }) => textResult(readReference(deps.contentDir, name)),
      ),
    ],
  });
}
