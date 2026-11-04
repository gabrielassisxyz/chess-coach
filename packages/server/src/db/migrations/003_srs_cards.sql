CREATE TABLE srs_cards (
  id INTEGER PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('game_move', 'teaching')),
  source_game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
  -- UNIQUE makes batch creation idempotent. No CHECK ties a game_move card to its move: SET NULL on undo clears only this column and a check requiring it to stay set would abort the undo.
  source_move_id INTEGER UNIQUE REFERENCES moves(id) ON DELETE SET NULL,
  prompt_fen TEXT NOT NULL,
  student_color TEXT NOT NULL CHECK (student_color IN ('white', 'black')),
  played_uci TEXT,
  expected_uci TEXT NOT NULL,
  cp_loss INTEGER,
  classification TEXT,
  explanation TEXT,
  created_at TEXT NOT NULL,
  next_review_at TEXT NOT NULL,
  interval_hours REAL NOT NULL DEFAULT 0,
  ease_factor REAL NOT NULL DEFAULT 2.5,
  repetitions INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX srs_cards_due ON srs_cards (next_review_at);
