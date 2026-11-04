import { type SdkMcpToolDefinition, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ActivityState } from "@chess-coach/shared";
import { z } from "zod";
import { ActivityError } from "../activity/errors.js";
import type { CoachWorld } from "./game-tools.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

const json = (value: unknown, isError?: true): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError ? { isError } : {}),
});

// A refusal the activity service names becomes a code the model can act on; a fault is not hidden.
async function serve(start: () => Promise<ActivityState>): Promise<ToolResult> {
  try {
    const state = await start();
    if (state.kind !== "training") throw new Error(`expected training, got ${state.kind}`);
    const id = state.item.kind === "card" ? state.item.card_id : state.item.puzzle_id;
    return json({
      item_kind: state.item.kind,
      id,
      fen: state.fen,
      orientation: state.orientation,
    });
  } catch (error) {
    if (error instanceof ActivityError) {
      return json({ error: error.code, message: error.message }, true);
    }
    throw error;
  }
}

// The result of the student's answer reaches the coach as the usual notification, not here.
export function buildTrainingTools(
  world: Pick<CoachWorld, "training">,
  // biome-ignore lint/suspicious/noExplicitAny: the SDK types a server's tool list as `any` schemas
): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "serve_puzzle",
      "Put one puzzle on the student's board as a graded training item. The student explores, writes their reasoning and answers; the result arrives as a notification. Refused while a training session is open.",
      { puzzle_id: z.string().min(1).max(100) },
      async ({ puzzle_id }) =>
        serve(() => world.training.startTrainingItem({ kind: "puzzle", id: puzzle_id })),
    ),
    tool(
      "serve_card",
      "Put one review card on the student's board as a graded training item, due or not. The result arrives as a notification. Refused while a training session is open.",
      { card_id: z.number().int().positive() },
      async ({ card_id }) =>
        serve(() => world.training.startTrainingItem({ kind: "card", id: card_id })),
    ),
  ];
}
