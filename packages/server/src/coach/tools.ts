import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Database } from "../db/open.js";
import { getCurrentElo, lastDifficultyChange } from "../db/settings.js";
import { buildDifficultyTools } from "./difficulty-tools.js";
import { buildGameTools, type CoachWorld } from "./game-tools.js";
import { buildPuzzleTools } from "./puzzle-tools.js";
import { buildSrsTools } from "./srs-tools.js";

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
// Written out once so the allow-list handed to the SDK, the prompt check and the registry
// below cannot drift: a test asserts this list equals what is actually registered.
export const COACH_TOOL_BASE_NAMES = [
  "get_progress",
  "read_reference",
  "get_game",
  "show_position",
  "make_move",
  "analyze",
  "new_game",
  "resign_game",
  "create_srs_cards",
  "add_srs_card",
  "explain_card",
  "get_puzzles",
  "get_due_cards",
  "set_difficulty",
] as const;
export const COACH_TOOL_NAMES = COACH_TOOL_BASE_NAMES.map(
  (name) => `mcp__${MCP_SERVER_NAME}__${name}`,
);

const REFERENCE_CHAR_LIMIT = 60_000;

export const referenceInput = { name: z.enum(REFERENCE_NAMES) };

export interface Progress {
  current_elo: number;
  last_difficulty_change: { to_elo: number; reason: string; changed_at: string } | null;
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

// Later migrations create the tables; until then every count is zero rather than an error.
export function getProgress(db: Database, now: Date = new Date()): Progress {
  return {
    current_elo: getCurrentElo(db),
    last_difficulty_change: lastDifficultyChange(db),
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
  world: CoachWorld;
  now?: () => Date;
}

// Tools of later beads are added here, next to the ones that exist.
export function buildCoachTools(deps: CoachToolDeps) {
  const now = deps.now ?? (() => new Date());
  return [
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
    ...buildGameTools(deps.world),
    ...buildSrsTools({ db: deps.db, clock: { now }, evaluateMove: deps.world.evaluateMove }),
    ...buildPuzzleTools(deps.db),
    ...buildDifficultyTools(deps.db, { now }),
  ];
}

export function createCoachMcpServer(deps: CoachToolDeps) {
  return createSdkMcpServer({ name: MCP_SERVER_NAME, tools: buildCoachTools(deps) });
}
