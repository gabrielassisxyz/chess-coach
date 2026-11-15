-- A puzzle of the Lichess database carries the opening of the game it came from in opening_tags,
-- tags separated by spaces from general to specific (`Italian_Game Italian_Game_Classical_Variation`),
-- and is served under each of them as puzzle_themes serves it under each theme: the rating sits in
-- the key so a queue can seek by tag, rating and id. No foreign key, for the reason
-- 017_puzzle_themes.sql gives.
CREATE TABLE puzzle_openings (
  opening TEXT NOT NULL,
  rating INTEGER NOT NULL,
  puzzle_id TEXT NOT NULL,
  PRIMARY KEY (opening, rating, puzzle_id)
) WITHOUT ROWID;

-- One row per tag of every rated puzzle already stored, the import writing the same rows from here
-- on. The split peels one tag off the front of the field per step, so it holds for any number of
-- tags and skips the empty ones a doubled space would leave. Sorted by the key, the rows go into
-- the table's tree in order, so a page is filled once instead of being spilled and read back for
-- every later row that lands on it: on a library of millions this backfill is the slow part of the
-- server start that applies it.
WITH RECURSIVE tag_split (puzzle_id, rating, tag, rest) AS (
  SELECT id, difficulty_rating, '', opening_tags || ' '
  FROM puzzles
  WHERE difficulty_rating IS NOT NULL AND opening_tags IS NOT NULL AND opening_tags <> ''
  UNION ALL
  SELECT puzzle_id, rating, substr(rest, 1, instr(rest, ' ') - 1), substr(rest, instr(rest, ' ') + 1)
  FROM tag_split
  WHERE rest <> ''
)
INSERT OR IGNORE INTO puzzle_openings (opening, rating, puzzle_id)
SELECT tag, rating, puzzle_id FROM tag_split WHERE tag <> '' ORDER BY tag, rating, puzzle_id;
