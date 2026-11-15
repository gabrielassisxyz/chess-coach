-- The review schedule of one position of the student's games, keyed by its found_positions id. It
-- follows repertoire_cards, with the same columns moved by the same SM-2 function, but it is a table
-- of its own: repertoire_cards is keyed by position and move and shared with the line drill, so a
-- position that is also a move of a stored line would share one schedule with it. A position with no
-- row is new; the row is written the first time a drill rates the position, and `reviews` counts
-- the drills that moved it.
CREATE TABLE found_cards (
  position_id TEXT PRIMARY KEY REFERENCES found_positions(id) ON DELETE CASCADE,
  interval_hours REAL NOT NULL DEFAULT 0,
  ease_factor REAL NOT NULL DEFAULT 2.5,
  repetitions INTEGER NOT NULL DEFAULT 0,
  next_review_at TEXT NOT NULL,
  introduced_at TEXT NOT NULL,
  reviews INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT
);

-- training_runs.mode accepts 'found' by swapping the column alone, as 021_repertoire_drill.sql
-- does: a rebuild (create, copy, drop, rename) runs inside this migration's transaction, where
-- PRAGMA foreign_keys cannot be switched off, so dropping training_runs would trip
-- training_items.run_id. Every row keeps its id and its mode.
ALTER TABLE training_runs ADD COLUMN mode_next TEXT NOT NULL DEFAULT 'srs'
  CHECK (mode_next IN ('srs', 'puzzles', 'openings', 'repertoire', 'found'));
UPDATE training_runs SET mode_next = mode;
ALTER TABLE training_runs DROP COLUMN mode;
ALTER TABLE training_runs RENAME COLUMN mode_next TO mode;
