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
  {
    kind: "training",
    ...board,
    mode: "puzzles",
    item: {
      kind: "puzzle",
      puzzle_id: "fork-12",
      motif: "fork",
      difficulty: "advanced",
      fen: "8/8/8/8/8/8/8/K6k w - - 0 1",
      cursor: 0,
      reply_uci: null,
      rating: 1400,
      position_in_queue: 1,
      queue_length: 10,
    },
    status: "prompt",
    served_at: "2026-03-01T00:00:00.000Z",
    expected: null,
    exploring: {
      fen: "8/8/8/8/8/8/8/K6k w - - 0 1",
      line_san: ["Ka2"],
      trail: [{ seq: 1, at_ms: 1200, kind: "move", line_san: ["Ka2"] }],
    },
    tries: 1,
    last_try: { uci: "a1b1", san: "Kb1", correct: false },
    gave_up: false,
    solution_line: null,
    suggested_grade: null,
    hint_square: null,
    summary: null,
    moves: [{ ply: 0, uci: "a1a2", san: "Ka2", by: "student" }],
    wrong_tries: [{ ply: 0, uci: "a1b1", san: "Kb1" }],
    queue_outcomes: ["current", "pending"],
    student_rating: 1200,
    rating_change: null,
  },
  {
    kind: "training",
    ...board,
    mode: "srs",
    item: {
      kind: "card",
      card_id: 3,
      exposure_id: "x1",
      prompt_fen: "8/8/8/8/8/8/8/K6k w - - 0 1",
      student_color: "white",
      rating_preview: { "1": 0.01666, "2": 0.1, "3": 0.1666, "4": 192 },
      position_in_queue: 2,
      queue_length: 2,
    },
    status: "failed",
    served_at: "2026-03-01T00:00:00.000Z",
    exposure_id: "x1",
    expected: { uci: "a1a2", san: "Ka2" },
    exploring: { fen: "8/8/8/8/8/8/8/K6k w - - 0 1", line_san: [], trail: [] },
    tries: 0,
    last_try: null,
    gave_up: true,
    solution_line: ["a1a2"],
    suggested_grade: 1,
    hint_square: null,
    summary: { solved: 0, failed: 1 },
  },
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

  describe("the four grades of a card", () => {
    const cardState = variants.find(
      (variant) => variant.kind === "training" && variant.item.kind === "card",
    ) as Extract<ActivityState, { kind: "training" }>;
    const cardItem = cardState.item as Extract<typeof cardState.item, { kind: "card" }>;
    const parsedWith = (change: Record<string, unknown>) =>
      ActivityStateSchema.safeParse({ ...cardState, ...change });

    it("previews the hours to the next review for Again, Hard, Good and Easy, and nothing else", () => {
      const parsed = ActivityStateSchema.parse(
        JSON.parse(JSON.stringify(cardState)),
      ) as typeof cardState;

      expect((parsed.item as typeof cardItem).rating_preview).toEqual({
        "1": 0.01666,
        "2": 0.1,
        "3": 0.1666,
        "4": 192,
      });
      expect(
        parsedWith({ item: { ...cardItem, rating_preview: { "1": 1, "2": 2, "3": 3 } } }).success,
      ).toBe(false);
      expect(
        parsedWith({ item: { ...cardItem, rating_preview: { "1": 1, "2": 2, "3": 3, "4": "4" } } })
          .success,
      ).toBe(false);
    });

    it("suggests a grade from 1 to 4, or none while the card is open", () => {
      for (const grade of [1, 2, 3, 4, null]) {
        expect(parsedWith({ suggested_grade: grade }).success, String(grade)).toBe(true);
      }
      for (const grade of [0, 5, 2.5, "3", undefined]) {
        expect(parsedWith({ suggested_grade: grade }).success, String(grade)).toBe(false);
      }
    });

    it("no longer carries the old quality", () => {
      const { suggested_grade: _grade, ...withoutGrade } = cardState;

      expect(ActivityStateSchema.safeParse({ ...withoutGrade, suggested_quality: 4 }).success).toBe(
        false,
      );
    });
  });

  it("validates the board commands", () => {
    const ok = [
      { type: "open_game", game_id: 3 },
      { type: "select_review_ply", game_id: 3, ply: 0 },
      { type: "leave_demo", activity_id: 2 },
      { type: "new_game", color: "black", elo: 1500 },
      { type: "new_game", color: "black" },
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
      { type: "new_game", color: "black", elo: 1500.5 },
      { type: "move", from: "a7", to: "a8", promotion: "k" },
    ];
    for (const command of bad) {
      expect(ClientCommandSchema.safeParse({ ...command, command_id: "c" }).success).toBe(false);
    }
  });
});

describe("start_training for the positions from the student's games", () => {
  const start = (fields: Record<string, unknown>) =>
    ClientCommandSchema.safeParse({ type: "start_training", command_id: "c", ...fields });

  it("accepts the found mode with each scope, alone or with a colour, a phase and a position", () => {
    for (const scope of ["recommended", "due", "all"]) {
      expect(start({ mode: "found", scope }).success).toBe(true);
    }
    const narrowed = start({
      mode: "found",
      scope: "all",
      color: "black",
      phase: "endgame",
      position: "own:0123456789abcdef",
    });
    expect(narrowed.success).toBe(true);
    expect(narrowed.data).toMatchObject({ phase: "endgame", position: "own:0123456789abcdef" });
    for (const phase of ["opening", "middlegame"]) {
      expect(start({ mode: "found", scope: "due", phase }).success).toBe(true);
    }
  });

  it.each([
    ["no scope", { mode: "found" }],
    ["no scope with filters", { mode: "found", color: "white", phase: "opening" }],
    ["another scope", { mode: "found", scope: "weekly" }],
    ["another colour", { mode: "found", scope: "all", color: "green" }],
    ["another phase", { mode: "found", scope: "all", phase: "late" }],
    ["an empty position", { mode: "found", scope: "all", position: "" }],
    ["a position that is no id", { mode: "found", scope: "all", position: "x".repeat(65) }],
  ])("refuses %s with a validation error", (_name, fields) => {
    const parsed = start(fields);
    expect(parsed.success).toBe(false);
  });

  it("names the missing scope in the error", () => {
    expect(start({ mode: "found" }).error?.issues).toMatchObject([{ path: ["scope"] }]);
  });

  it("leaves the other modes as they were, with no scope needed", () => {
    for (const fields of [
      { mode: "srs" },
      { mode: "puzzles", motif: "fork" },
      { mode: "openings", color: "white" },
      { mode: "repertoire", repertoire_id: 3 },
      { mode: "repertoire", repertoire_id: 3, scope: "due", level: "group" },
    ]) {
      expect(start(fields).success).toBe(true);
    }
    expect(start({ mode: "nope", scope: "all" }).success).toBe(false);
  });
});
