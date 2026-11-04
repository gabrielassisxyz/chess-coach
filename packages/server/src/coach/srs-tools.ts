import { type SdkMcpToolDefinition, tool } from "@anthropic-ai/claude-agent-sdk";
import { Chess } from "chess.js";
import { z } from "zod";
import type { Clock } from "../clock.js";
import type { Database } from "../db/open.js";
import { getCard, insertCard, listDueCards, setExplanation } from "../db/srs.js";
import { applyUci } from "../engine/moves.js";
import { cardView, createCardsFromGame } from "../srs/cards.js";
import { SrsError } from "../srs/errors.js";
import type { SrsEvaluator } from "./game-tools.js";

export interface SrsToolDeps {
  db: Database;
  clock: Clock;
  evaluateMove: SrsEvaluator;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

const refuse = (error: string, message: string): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error, message }) }],
  isError: true,
});

const isFen = (value: string): boolean => {
  try {
    new Chess(value);
    return true;
  } catch {
    return false;
  }
};

const fenSchema = z.string().min(1).max(120).refine(isFen, "not a valid FEN");
const uciSchema = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/, "not a UCI move");
const MAX_DUE_CARDS = 20;
const explanationSchema = z.string().min(1).max(2000);

function isLegal(fen: string, uci: string): boolean {
  try {
    applyUci(new Chess(fen), uci);
    return true;
  } catch {
    return false;
  }
}

async function addTeachingCard(
  deps: SrsToolDeps,
  input: { fen: string; played_uci: string; best_uci: string; explanation: string },
): Promise<ToolResult> {
  // The shape of a tool input cannot relate one field to another, so legality is checked here.
  for (const [field, uci] of [
    ["played_uci", input.played_uci],
    ["best_uci", input.best_uci],
  ] as const) {
    if (!isLegal(input.fen, uci)) {
      return refuse("illegal_move", `${field} ${uci} is not legal in the given position`);
    }
  }
  const white = new Chess(input.fen).turn() === "w";
  const evaluation = await deps.evaluateMove(input.fen, input.played_uci, white ? "w" : "b");
  const card = insertCard(deps.db, {
    sourceKind: "teaching",
    sourceGameId: null,
    sourceMoveId: null,
    promptFen: input.fen,
    studentColor: white ? "white" : "black",
    playedUci: input.played_uci,
    expectedUci: input.best_uci,
    cpLoss: evaluation.cpLoss,
    classification: evaluation.classification,
    explanation: input.explanation,
    createdAt: deps.clock.now().toISOString(),
  });
  return ok({
    card_id: card?.id,
    cp_loss: evaluation.cpLoss,
    classification: evaluation.classification,
  });
}

async function guarded(run: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SrsError) return refuse(error.code, error.message);
    throw error;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: the SDK types a server's tool list as `any` schemas
export function buildSrsTools(deps: SrsToolDeps): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "create_srs_cards",
      "Save the student's inaccuracies, mistakes and blunders from a finished game as spaced-repetition cards. Safe to call twice: positions that already have a card are skipped. Refused with game_not_finished while the game is live.",
      { game_id: z.number().int().positive() },
      async ({ game_id }) => guarded(() => ok(createCardsFromGame(deps.db, game_id, deps.clock))),
    ),
    tool(
      "add_srs_card",
      "Add a teaching card for a position: the move the student played and the better one, with your explanation. The server measures the centipawn loss itself.",
      {
        fen: fenSchema,
        played_uci: uciSchema,
        best_uci: uciSchema,
        explanation: explanationSchema,
      },
      async (input) => guarded(() => addTeachingCard(deps, input)),
    ),
    tool(
      "explain_card",
      "Write or replace the explanation shown on a card, 1 to 2000 characters. Refused with card_not_found for an unknown id.",
      { card_id: z.number().int().positive(), explanation: explanationSchema },
      async ({ card_id, explanation }) =>
        guarded(() => {
          if (!getCard(deps.db, card_id) || !setExplanation(deps.db, card_id, explanation)) {
            throw new SrsError("card_not_found", `card ${card_id} does not exist`);
          }
          return ok({ card_id });
        }),
    ),
    tool(
      "get_due_cards",
      "List the cards due for review now, oldest first, up to 20. Read-only: it does not serve or grade a card.",
      { limit: z.number().int().min(1).max(MAX_DUE_CARDS).optional() },
      async ({ limit }) =>
        guarded(() =>
          ok(
            listDueCards(deps.db, deps.clock.now(), limit ?? MAX_DUE_CARDS).map((card) => ({
              ...cardView(card),
              student_color: card.studentColor,
            })),
          ),
        ),
    ),
  ];
}
