import { type SdkMcpToolDefinition, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ActivityMove, ActivityState } from "@chess-coach/shared";
import { Chess } from "chess.js";
import { z } from "zod";
import { ActivityError } from "../activity/errors.js";
import type { ActivityService } from "../activity/service.js";
import type { PlayerMoveEvaluation, StudentColor } from "../engine/evaluate.js";
import { applyUci } from "../engine/moves.js";
import { MATE_SCORE_CP } from "../engine/parse.js";
import { MAX_ELO, MIN_ELO } from "../engine/play.js";
import { AnalyzeSuperseded } from "../engine/pool.js";
import type { SearchResult } from "../engine/uci.js";
import { GameError } from "../game/errors.js";
import type { GameService } from "../game/service.js";

export type SrsEvaluator = (
  fen: string,
  moveUci: string,
  studentColor: StudentColor,
) => Promise<PlayerMoveEvaluation>;

// What the coach may touch of the running application. Each member is a slice of a real service
// so a test can hand in a fake with only these methods.
export interface CoachWorld {
  game: Pick<GameService, "snapshot" | "resign">;
  activity: Pick<ActivityService, "current" | "startDemo" | "demoMove" | "newGame">;
  analyze(fen: string): Promise<SearchResult>;
  evaluateMove: SrsEvaluator;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

const PV_PLIES = 6;

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function refuse(error: string, message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error, message }) }], isError: true };
}

// Refusals the services already name become a code the model can act on; a fault is not hidden.
async function guarded(run: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GameError || error instanceof ActivityError) {
      return refuse(error.code, error.message);
    }
    if (error instanceof AnalyzeSuperseded) return refuse("superseded", error.message);
    throw error;
  }
}

const isFen = (value: string): boolean => {
  try {
    new Chess(value);
    return true;
  } catch {
    return false;
  }
};

const fenSchema = z.string().min(1).max(120).refine(isFen, "not a valid FEN");

function compactMove(move: ActivityMove): Record<string, unknown> {
  if (!move.is_player) return { ply: move.ply, san: move.san, by: "engine" };
  return {
    ply: move.ply,
    san: move.san,
    by: "student",
    cp_loss: move.cp_loss,
    classification: move.classification,
    best: move.best_move_san,
  };
}

function liveGame(world: CoachWorld): ToolResult | null {
  const snapshot = world.game.snapshot();
  if (!snapshot) return null;
  return ok({
    source: "live",
    game_id: snapshot.gameId,
    fen: snapshot.fen,
    turn: snapshot.turn,
    student_color: snapshot.playerColor,
    phase: snapshot.phase,
    result: snapshot.result,
    termination: snapshot.termination,
    moves: snapshot.moves.map((move) =>
      compactMove({
        ply: move.ply,
        san: move.san,
        uci: move.uci,
        is_player: move.isPlayer,
        eval_before_cp: move.evalBeforeCp,
        eval_after_cp: move.evalAfterCp,
        cp_loss: move.cpLoss,
        classification: move.classification,
        best_move_san: move.bestMoveSan,
      }),
    ),
  });
}

function reviewedGame(state: ActivityState | null): ToolResult | null {
  if (state?.kind !== "review") return null;
  return ok({
    source: "review",
    game_id: state.game.id,
    fen: state.fen,
    turn: state.turn,
    student_color: state.orientation,
    selected_ply: state.selected_ply,
    result: state.game.result,
    moves: state.game.moves.map(compactMove),
  });
}

function getGame(world: CoachWorld): ToolResult {
  const found = reviewedGame(world.activity.current()) ?? liveGame(world);
  return found ?? refuse("no_game", "there is no live game and no game open for review");
}

function stateSummary(state: ActivityState | null): Record<string, unknown> {
  if (!state) return { kind: null };
  const base = { kind: state.kind, fen: state.fen, turn: state.turn };
  return state.kind === "demo" ? { ...base, returns_to: state.returns_to } : base;
}

function lineView(position: Chess, line: SearchResult["lines"][number]): Record<string, unknown> {
  const replay = new Chess(position.fen());
  const pv: string[] = [];
  for (const uci of line.moves.slice(0, PV_PLIES)) {
    try {
      pv.push(applyUci(replay, uci).san);
    } catch {
      break;
    }
  }
  const mate = Math.abs(line.score) >= MATE_SCORE_CP;
  return { score_cp: line.score, ...(mate ? { mate: true } : {}), pv };
}

async function analyze(world: CoachWorld, fen: string | undefined): Promise<ToolResult> {
  const target = fen ?? world.activity.current()?.fen;
  if (target === undefined)
    return refuse("no_position", "give a FEN or put a position on the board");
  const result = await world.analyze(target);
  const position = new Chess(target);
  return ok({
    fen: target,
    side_to_move: position.turn() === "w" ? "white" : "black",
    scores: "centipawns from the side to move",
    lines: result.lines.map((line) => lineView(position, line)),
  });
}

async function startGame(
  world: CoachWorld,
  color: "white" | "black",
  elo: number | undefined,
): Promise<ToolResult> {
  const state = await world.activity.newGame({ color, ...(elo === undefined ? {} : { elo }) });
  if (state.kind !== "live_game") return ok(stateSummary(state));
  return ok({
    game_id: state.game_id,
    student_color: color,
    ...(elo === undefined ? { elo: "current setting, see get_progress" } : { elo }),
    fen: state.fen,
    turn: state.turn,
  });
}

// biome-ignore lint/suspicious/noExplicitAny: the SDK types a server's tool list as `any` schemas
export function buildGameTools(world: CoachWorld): SdkMcpToolDefinition<any>[] {
  return [
    tool(
      "get_game",
      "The live game, or the game open for review: FEN, whose turn, result, and every move with its centipawn loss, classification and best move.",
      {},
      async () => guarded(() => getGame(world)),
    ),
    tool(
      "show_position",
      "Put a position on the student's board as a demo. The live game is kept underneath and comes back when the demo ends.",
      { fen: fenSchema },
      async ({ fen }) => guarded(async () => ok(stateSummary(await world.activity.startDemo(fen)))),
    ),
    tool(
      "make_move",
      "Play one move, in SAN, on the demo board. Refused with not_in_demo when no demo is on the board.",
      { san: z.string().min(2).max(10) },
      async ({ san }) => guarded(async () => ok(stateSummary(await world.activity.demoMove(san)))),
    ),
    tool(
      "analyze",
      "Top three engine lines at depth 18 for a FEN, or for the position on the board when none is given. Scores are in centipawns from the side to move.",
      { fen: fenSchema.optional() },
      async ({ fen }) => guarded(() => analyze(world, fen)),
    ),
    tool(
      "new_game",
      "Start a game for the student at the given engine Elo, or at the current setting when elo is omitted. Refused with game_in_progress while one is unfinished.",
      {
        color: z.enum(["white", "black"]),
        elo: z.number().int().min(MIN_ELO).max(MAX_ELO).optional(),
      },
      async ({ color, elo }) => guarded(() => startGame(world, color, elo)),
    ),
    tool(
      "resign_game",
      "Resign the live game for the student. A post-game message with the three costliest moves follows.",
      {},
      async () =>
        guarded(async () => {
          const snapshot = await world.game.resign();
          return ok({ result: snapshot.result, termination: snapshot.termination });
        }),
    ),
  ];
}
