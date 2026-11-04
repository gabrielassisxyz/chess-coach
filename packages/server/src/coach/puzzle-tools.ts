import { type SdkMcpToolDefinition, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Database } from "../db/open.js";
import { listPuzzles } from "../db/puzzles.js";

export const COACH_PUZZLE_LIMIT = 20;

// The listing already omits the solution; the tool adds nothing that could leak it.
// biome-ignore lint/suspicious/noExplicitAny: the SDK types a server's tool list as `any` schemas
export function buildPuzzleTools(db: Database): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "get_puzzles",
      "Pick puzzles for a drill, optionally by motif. Returns id, motif, difficulty, FEN and explanation, never the solution; unseen puzzles come first.",
      {
        motif: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(COACH_PUZZLE_LIMIT).optional(),
      },
      async ({ motif, limit }) => {
        const { total, puzzles } = listPuzzles(db, {
          motif,
          limit: Math.min(limit ?? 10, COACH_PUZZLE_LIMIT),
        });
        const shown = puzzles.map(({ id, motif, difficulty, fen, explanation }) => ({
          id,
          motif,
          difficulty,
          fen,
          explanation,
        }));
        return { content: [{ type: "text", text: JSON.stringify({ total, puzzles: shown }) }] };
      },
    ),
  ];
}
