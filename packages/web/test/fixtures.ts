import type { ActivityMove, LegalMoveEntry, LiveGameActivity } from "@chess-coach/shared";
import { Chess } from "chess.js";
import type { ConnectionsApi } from "../src/state/connections-api.js";
import type { ImportApi } from "../src/state/import-api.js";
import type { PlayFactsApi } from "../src/state/play-facts.js";

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function legalMovesOf(fen: string): LegalMoveEntry[] {
  const chess = new Chess(fen);
  const entries = new Map<string, LegalMoveEntry>();
  for (const move of chess.moves({ verbose: true })) {
    const key = `${move.from}${move.to}`;
    const entry = entries.get(key) ?? { from: move.from, to: move.to };
    if (move.promotion) entry.promotions = [...(entry.promotions ?? []), move.promotion as "q"];
    entries.set(key, entry);
  }
  return [...entries.values()];
}

export function move(ply: number, overrides: Partial<ActivityMove> = {}): ActivityMove {
  return {
    ply,
    san: `m${ply}`,
    uci: "e2e4",
    is_player: ply % 2 === 1,
    eval_before_cp: null,
    eval_after_cp: null,
    cp_loss: null,
    classification: null,
    best_move_san: null,
    ...overrides,
  };
}

export function liveGame(overrides: Partial<LiveGameActivity> = {}): LiveGameActivity {
  return {
    kind: "live_game",
    activity_id: 1,
    orientation: "white",
    fen: START_FEN,
    turn: "white",
    last_move: null,
    legal_moves: legalMovesOf(START_FEN),
    input_enabled: true,
    pending: "none",
    game_id: 1,
    phase: "player_turn",
    moves: [],
    material: { white: 39, black: 39 },
    result: null,
    termination: null,
    ...overrides,
  };
}

/** The source fields every game the coach itself played carries. */
export const COACH_GAME_SOURCE = {
  source: "coach",
  source_url: null,
  opponent: null,
  student_rating: null,
  opponent_rating: null,
  time_control: null,
  played_at: null,
  grading: "done",
} as const;

/** An import API with nothing queued, so a Games render never reaches for the network. */
export const idleImportApi: ImportApi = {
  listChessCom: async () => [],
  importChessCom: async () => ({ imported: 0, skipped: 0 }),
  importLichess: async () => ({ imported: 0, skipped: 0 }),
  importPgn: async () => ({ imported: 0, skipped: 0 }),
  status: async () => ({ pending: 0, running: null, failed: 0 }),
};

const NO_CONNECTIONS = {
  lichess_token_set: false,
  lichess_username: null,
  chesscom_username: null,
};

/** Nothing connected, so a Games render never reaches for the network. */
export const idleConnectionsApi: ConnectionsApi = {
  get: async () => NO_CONNECTIONS,
  saveLichessToken: async () => NO_CONNECTIONS,
  removeLichessToken: async () => NO_CONNECTIONS,
  saveLichessUsername: async () => NO_CONNECTIONS,
  removeLichessUsername: async () => NO_CONNECTIONS,
  saveChessComUsername: async () => NO_CONNECTIONS,
  removeChessComUsername: async () => NO_CONNECTIONS,
};

/** Play facts that never resolve a value, so a Play render never reaches for the network. */
export const idleFactsApi: PlayFactsApi = {
  getGame: async () => Promise.reject(new Error("no server in tests")),
  getProgress: async () => Promise.reject(new Error("no server in tests")),
};
