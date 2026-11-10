export type ActivityErrorCode =
  | "stale_activity"
  | "not_in_demo"
  | "not_in_review"
  | "not_in_live_game"
  | "demo_active"
  | "live_game_active"
  | "training_item_open"
  | "already_requested"
  | "game_not_found"
  | "invalid_ply"
  | "illegal_move"
  | "invalid_position"
  | "invalid_line"
  | "not_in_training"
  | "empty_queue"
  | "item_unfinished"
  | "item_finished"
  | "use_try_move"
  | "not_exploring"
  | "illegal_exploration"
  | "training_active"
  | "puzzle_not_found"
  | "card_not_found"
  | "no_paused_training"
  | "unknown_opening";

export class ActivityError extends Error {
  constructor(
    readonly code: ActivityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ActivityError";
  }
}
