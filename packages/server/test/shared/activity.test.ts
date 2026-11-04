import {
  type ActivityMove,
  type ActivityState,
  ActivityStateSchema,
  ClientCommandSchema,
  ServerEventSchema,
} from "@chess-coach/shared";
import { describe, expect, it } from "vitest";

const board: Pick<
  ActivityState,
  | "activity_id"
  | "orientation"
  | "fen"
  | "turn"
  | "last_move"
  | "legal_moves"
  | "input_enabled"
  | "pending"
> = {
  activity_id: 4,
  orientation: "black",
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  turn: "white",
  last_move: { from: "e2", to: "e4" },
  legal_moves: [
    { from: "a7", to: "a8", promotions: ["q", "r", "b", "n"] },
    { from: "h2", to: "h3" },
  ],
  input_enabled: true,
  pending: "none",
};

const move: ActivityMove = {
  ply: 1,
  san: "e4",
  uci: "e2e4",
  is_player: true,
  eval_before_cp: 20,
  eval_after_cp: -10,
  cp_loss: 30,
  classification: "great",
  best_move_san: "d4",
};

const variants: ActivityState[] = [
  {
    kind: "live_game",
    ...board,
    game_id: 9,
    phase: "player_turn",
    moves: [move],
    material: { white: 39, black: 39 },
    result: null,
    termination: null,
  },
  {
    kind: "review",
    ...board,
    input_enabled: false,
    legal_moves: [],
    game: { id: 9, moves: [move], result: "1-0" },
    selected_ply: 1,
  },
  { kind: "training", ...board, item: { kind: "puzzle", id: 12 }, exposure_id: "x1" },
  { kind: "training", ...board, item: { kind: "card", id: "c-3" } },
  { kind: "demo", ...board, returns_to: "live_game", moves_played: ["e4", "e5"] },
  { kind: "demo", ...board, returns_to: null, moves_played: [] },
];

describe("ActivityState schemas", () => {
  it.each(variants.map((v, i) => [`${v.kind} #${i}`, v] as const))("round-trips %s", (_n, v) => {
    const wire: unknown = JSON.parse(JSON.stringify(v));
    expect(ActivityStateSchema.parse(wire)).toEqual(v);
    expect(ServerEventSchema.parse({ type: "activity", state: v }).type).toBe("activity");
  });

  it("rejects a kind with another kind's fields missing", () => {
    expect(ActivityStateSchema.safeParse({ kind: "demo", ...board }).success).toBe(false);
    expect(ActivityStateSchema.safeParse({ ...variants[0], kind: "nope" }).success).toBe(false);
  });

  it("validates the board commands", () => {
    const ok = [
      { type: "open_game", game_id: 3 },
      { type: "select_review_ply", game_id: 3, ply: 0 },
      { type: "leave_demo", activity_id: 2 },
      { type: "new_game", color: "black", elo: 1500 },
      { type: "resign" },
      { type: "abort" },
      { type: "move", from: "a7", to: "a8", promotion: "q" },
      { type: "undo" },
    ];
    for (const command of ok) {
      expect(ClientCommandSchema.safeParse({ ...command, command_id: "c" }).success).toBe(true);
    }
    const bad = [
      { type: "open_game", game_id: 0 },
      { type: "select_review_ply", game_id: 3, ply: -1 },
      { type: "new_game", color: "green", elo: 1500 },
      { type: "move", from: "a7", to: "a8", promotion: "k" },
    ];
    for (const command of bad) {
      expect(ClientCommandSchema.safeParse({ ...command, command_id: "c" }).success).toBe(false);
    }
  });
});
