-- A named opening the student memorizes: White openings group Italian Game, Italian Game groups
-- its variations, and one variation expects one move in each position.
CREATE TABLE repertoires (
  id INTEGER PRIMARY KEY,
  side TEXT NOT NULL CHECK (side IN ('white', 'black')),
  group_name TEXT NOT NULL,
  variation_name TEXT NOT NULL,
  UNIQUE (side, group_name, variation_name)
);

-- One row per position and move of a variation. kind 'own' is the move the student must play and
-- 'reply' is an opponent's reply on the way there; share and reach are fractions, reach being the
-- product of the opponent's shares since the variation's starting position. cp_loss, eval_cp and
-- the win, draw and loss counts describe an 'own' move. eval_cp is the engine's evaluation of the
-- position after the move, in centipawns from White's side with a mate as 10000, and the counts
-- stay null when the explorer had no games for that position; the statistics screen reads them
-- without any network.
CREATE TABLE repertoire_positions (
  id INTEGER PRIMARY KEY,
  repertoire_id INTEGER NOT NULL REFERENCES repertoires(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('own', 'reply')),
  position_key TEXT NOT NULL,
  ply INTEGER NOT NULL,
  line_san TEXT NOT NULL,
  move_uci TEXT NOT NULL,
  move_san TEXT NOT NULL,
  share REAL,
  reach REAL NOT NULL,
  opening_name TEXT,
  idea TEXT,
  source TEXT NOT NULL,
  cp_loss INTEGER,
  eval_cp INTEGER,
  wins INTEGER,
  draws INTEGER,
  losses INTEGER,
  CHECK (kind = 'reply' OR cp_loss IS NOT NULL),
  CHECK (kind = 'reply' OR eval_cp IS NOT NULL)
);

-- The rule that keeps a variation from teaching two answers to one position.
CREATE UNIQUE INDEX repertoire_positions_one_own_move
  ON repertoire_positions (repertoire_id, position_key) WHERE kind = 'own';

CREATE UNIQUE INDEX repertoire_positions_one_reply
  ON repertoire_positions (repertoire_id, position_key, move_uci) WHERE kind = 'reply';
