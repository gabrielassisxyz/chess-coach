-- Practice gains a repertoire drill: training_runs.mode accepts 'repertoire', and one pass over a
-- repertoire line is a training_items row of kind 'repertoire', so its tries land in
-- training_tries like any other. Both checks are widened by swapping the column alone, as
-- 019_lichess_game_source.sql does for games: a rebuild (create, copy, drop, rename) runs inside
-- this migration's transaction, where PRAGMA foreign_keys cannot be switched off, so dropping
-- training_runs would trip training_items.run_id and dropping training_items would cascade into
-- training_tries, exploration_events and item_messages. Every row keeps its id.
ALTER TABLE training_runs ADD COLUMN mode_next TEXT NOT NULL DEFAULT 'srs'
  CHECK (mode_next IN ('srs', 'puzzles', 'openings', 'repertoire'));
UPDATE training_runs SET mode_next = mode;
ALTER TABLE training_runs DROP COLUMN mode;
ALTER TABLE training_runs RENAME COLUMN mode_next TO mode;

ALTER TABLE training_items ADD COLUMN kind_next TEXT NOT NULL DEFAULT 'card'
  CHECK (kind_next IN ('card', 'puzzle', 'repertoire'));
UPDATE training_items SET kind_next = kind;
ALTER TABLE training_items DROP COLUMN kind;
ALTER TABLE training_items RENAME COLUMN kind_next TO kind;

-- The review schedule of one move in one position. It is keyed by position and move rather than
-- by variation, so a move two variations share is learned once. The row is written the first time
-- the move is shown, with its answer; a move with no row is new. The schedule columns are those of
-- srs_cards, moved by the same SM-2 function, and `reviews` counts the sessions that rated it.
CREATE TABLE repertoire_cards (
  id INTEGER PRIMARY KEY,
  position_key TEXT NOT NULL,
  move_uci TEXT NOT NULL,
  introduced_at TEXT NOT NULL,
  next_review_at TEXT NOT NULL,
  interval_hours REAL NOT NULL DEFAULT 0,
  ease_factor REAL NOT NULL DEFAULT 2.5,
  repetitions INTEGER NOT NULL DEFAULT 0,
  reviews INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  UNIQUE (position_key, move_uci)
);
