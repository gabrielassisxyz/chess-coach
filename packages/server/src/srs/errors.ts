export type SrsErrorCode = "game_not_found" | "game_not_finished" | "card_not_found";

export class SrsError extends Error {
  constructor(
    readonly code: SrsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SrsError";
  }
}
