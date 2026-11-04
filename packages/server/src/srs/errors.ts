export type SrsErrorCode =
  | "game_not_found"
  | "game_not_finished"
  | "card_not_found"
  | "exposure_unknown"
  | "exposure_used"
  | "exposure_stale"
  | "exposure_answered"
  | "exposure_unanswered"
  | "invalid_quality";

export class SrsError extends Error {
  constructor(
    readonly code: SrsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SrsError";
  }
}
