export type GameErrorCode =
  | "game_in_progress"
  | "no_game"
  | "not_player_turn"
  | "illegal_move"
  | "game_finished"
  | "nothing_to_undo"
  | "invalid_elo"
  | "invalid_position";

export class GameError extends Error {
  constructor(
    readonly code: GameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GameError";
  }
}
