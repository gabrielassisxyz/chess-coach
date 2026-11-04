import { type SdkMcpToolDefinition, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Clock } from "../clock.js";
import type { Database } from "../db/open.js";
import { changeDifficulty } from "../db/settings.js";
import { MAX_ELO, MIN_ELO } from "../engine/play.js";

export const difficultyInput = {
  elo: z.number().int().min(MIN_ELO).max(MAX_ELO),
  reason: z.string().min(1).max(300),
};

// biome-ignore lint/suspicious/noExplicitAny: the SDK types a server's tool list as `any` schemas
export function buildDifficultyTools(db: Database, clock: Clock): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "set_difficulty",
      "Set the engine Elo for the student's next games, with the reason in a sentence. Use it when the student says the games feel too easy or too hard, or when two games show it. Tell the student what you changed.",
      difficultyInput,
      async ({ elo, reason }) => {
        const change = changeDifficulty(db, { toElo: elo, reason: "coach", note: reason }, clock);
        const body = change ?? { unchanged: true, current_elo: elo };
        return { content: [{ type: "text", text: JSON.stringify(body) }] };
      },
    ),
  ];
}
