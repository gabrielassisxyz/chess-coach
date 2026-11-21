-- Where a unit came from, and a White move with no engine figures.
--
-- origin is 'generated' for a unit the app's builder walked, which every unit stored before this
-- column is, and 'pgn' for a unit read from a PGN file. Added as a column alone: no row, id or
-- index of repertoires moves.
ALTER TABLE repertoires ADD COLUMN origin TEXT NOT NULL DEFAULT 'generated'
  CHECK (origin IN ('generated', 'pgn'));

-- A move read from a PGN file has no centipawn loss and no evaluation. Storing 0 for either would
-- be a figure nobody measured, which a later reader would average as if it were, so the two table
-- checks that required them on an 'own' row go. SQLite cannot drop a table check, so the table is
-- rebuilt: create the new one, copy every row with its id, drop the old one, rename. Nothing else
-- about it changes: the columns and their order, the check on kind, and the two partial unique
-- indexes, which are created again under their names once the old table's are gone.
--
-- This runs inside the migration's transaction, where PRAGMA foreign_keys cannot be switched off,
-- so dropping the table deletes its rows first and the foreign keys that point at it fire. Only
-- repertoire_game_reviews does, through added_reply_id and added_answer_id, both ON DELETE SET
-- NULL. Both are saved before the drop and written back once the rows exist again under the same
-- ids. repertoire_cards, drill_reviews and the run queues hold keys or ids with no foreign key, so
-- they stay valid because every row keeps its id.
CREATE TEMP TABLE repertoire_review_links_saved AS
SELECT game_id, added_reply_id, added_answer_id
FROM repertoire_game_reviews
WHERE added_reply_id IS NOT NULL OR added_answer_id IS NOT NULL;

CREATE TABLE repertoire_positions_next (
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
  eval_depth INTEGER
);

INSERT INTO repertoire_positions_next
  (id, repertoire_id, kind, position_key, ply, line_san, move_uci, move_san, share, reach,
   opening_name, idea, source, cp_loss, eval_cp, wins, draws, losses, eval_depth)
SELECT id, repertoire_id, kind, position_key, ply, line_san, move_uci, move_san, share, reach,
       opening_name, idea, source, cp_loss, eval_cp, wins, draws, losses, eval_depth
FROM repertoire_positions;

DROP TABLE repertoire_positions;
ALTER TABLE repertoire_positions_next RENAME TO repertoire_positions;

-- The rule that keeps a variation from teaching two answers to one position.
CREATE UNIQUE INDEX repertoire_positions_one_own_move
  ON repertoire_positions (repertoire_id, position_key) WHERE kind = 'own';

CREATE UNIQUE INDEX repertoire_positions_one_reply
  ON repertoire_positions (repertoire_id, position_key, move_uci) WHERE kind = 'reply';

UPDATE repertoire_game_reviews
SET added_reply_id = saved.added_reply_id,
    added_answer_id = saved.added_answer_id
FROM repertoire_review_links_saved AS saved
WHERE repertoire_game_reviews.game_id = saved.game_id;

DROP TABLE repertoire_review_links_saved;
