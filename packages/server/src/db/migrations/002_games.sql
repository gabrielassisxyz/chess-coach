CREATE TABLE games (
  id INTEGER PRIMARY KEY,
  coach_session_id INTEGER REFERENCES coach_sessions(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  player_color TEXT NOT NULL CHECK (player_color IN ('white', 'black')),
  target_elo INTEGER NOT NULL CHECK (target_elo BETWEEN 100 AND 3190),
  initial_fen TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('player_turn', 'evaluating', 'engine_turn', 'finished')),
  result TEXT CHECK (result IN ('1-0', '0-1', '1/2-1/2')),
  termination TEXT CHECK (termination IN ('checkmate', 'stalemate', 'draw', 'resign', 'abort')),
  pgn TEXT NOT NULL DEFAULT ''
);

-- A constant expression indexed only over unfinished rows: a second unfinished game collides with the first.
CREATE UNIQUE INDEX games_one_unfinished ON games ((1)) WHERE finished_at IS NULL;

CREATE TABLE moves (
  id INTEGER PRIMARY KEY,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply INTEGER NOT NULL,
  san TEXT NOT NULL,
  uci TEXT NOT NULL,
  fen_before TEXT NOT NULL,
  fen_after TEXT NOT NULL,
  is_player INTEGER NOT NULL,
  eval_before_cp INTEGER,
  eval_after_cp INTEGER,
  cp_loss INTEGER,
  classification TEXT CHECK (classification IN ('best', 'great', 'good', 'inaccuracy', 'mistake', 'blunder')),
  best_move_uci TEXT,
  best_move_san TEXT,
  UNIQUE (game_id, ply)
);
