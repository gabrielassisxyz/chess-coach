-- games.source accepts 'lichess'. The usual rebuild (create, copy, drop, rename) is not safe here:
-- a migration runs inside a transaction, where PRAGMA foreign_keys cannot be switched off, so
-- dropping games would cascade into moves, clear srs_cards.source_game_id and trip the check on
-- difficulty_changes.game_id. Swapping only the column leaves every other table, row and index in
-- place, and dropping a column takes its own CHECK with it.
ALTER TABLE games ADD COLUMN source_next TEXT NOT NULL DEFAULT 'coach'
  CHECK (source_next IN ('coach', 'chesscom', 'pgn', 'lichess'));
UPDATE games SET source_next = source;
ALTER TABLE games DROP COLUMN source;
ALTER TABLE games RENAME COLUMN source_next TO source;
