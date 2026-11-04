CREATE TABLE puzzles (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  motif TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  fen TEXT NOT NULL,
  solution_uci TEXT NOT NULL,
  solution_san TEXT NOT NULL,
  explanation TEXT NOT NULL,
  lichess_id TEXT,
  difficulty_rating INTEGER
);

CREATE TABLE puzzle_attempts (
  id INTEGER PRIMARY KEY,
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id),
  attempted_at TEXT NOT NULL,
  solved INTEGER NOT NULL CHECK (solved IN (0, 1)),
  answered_uci TEXT NOT NULL,
  failed_ply INTEGER
);

CREATE INDEX puzzle_attempts_by_puzzle ON puzzle_attempts (puzzle_id);
CREATE INDEX puzzles_by_motif ON puzzles (motif);
