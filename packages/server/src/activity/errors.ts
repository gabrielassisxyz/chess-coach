export type ActivityErrorCode =
  | "stale_activity"
  | "not_in_demo"
  | "not_in_review"
  | "not_in_live_game"
  | "demo_active"
  | "game_not_found"
  | "invalid_ply"
  | "illegal_move"
  | "invalid_position"
  | "not_in_training"
  | "empty_queue"
  | "item_unfinished"
  | "item_finished";

export class ActivityError extends Error {
  constructor(
    readonly code: ActivityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ActivityError";
  }
}
