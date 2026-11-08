-- The fields the Lichess puzzle database carries beyond the app's own, all null on library puzzles.
ALTER TABLE puzzles ADD COLUMN popularity INTEGER;
ALTER TABLE puzzles ADD COLUMN plays INTEGER;
ALTER TABLE puzzles ADD COLUMN rating_deviation INTEGER;
ALTER TABLE puzzles ADD COLUMN themes TEXT;
ALTER TABLE puzzles ADD COLUMN opening_tags TEXT;
ALTER TABLE puzzles ADD COLUMN game_url TEXT;

-- A puzzle carries several themes and is served under each. The rating sits in the key so a queue
-- can seek by theme, rating and id without reading a whole rating window. No foreign key: puzzles
-- are never deleted, and checking one per row would slow a bulk load of about 28 million rows.
CREATE TABLE puzzle_themes (
  theme TEXT NOT NULL,
  rating INTEGER NOT NULL,
  puzzle_id TEXT NOT NULL,
  PRIMARY KEY (theme, rating, puzzle_id)
) WITHOUT ROWID;

CREATE INDEX puzzles_by_rating_id ON puzzles (difficulty_rating, id);
