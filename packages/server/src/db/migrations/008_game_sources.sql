ALTER TABLE games ADD COLUMN source TEXT NOT NULL DEFAULT 'coach' CHECK (source IN ('coach', 'chesscom', 'pgn'));
ALTER TABLE games ADD COLUMN source_id TEXT;
ALTER TABLE games ADD COLUMN source_url TEXT;
ALTER TABLE games ADD COLUMN opponent TEXT;
ALTER TABLE games ADD COLUMN student_rating INTEGER;
ALTER TABLE games ADD COLUMN opponent_rating INTEGER;
ALTER TABLE games ADD COLUMN time_control TEXT;
ALTER TABLE games ADD COLUMN played_at TEXT;
ALTER TABLE games ADD COLUMN grading TEXT NOT NULL DEFAULT 'done' CHECK (grading IN ('pending', 'running', 'done', 'failed'));

-- A second import of the same game collides here, which is what makes importing idempotent.
CREATE UNIQUE INDEX games_source_id ON games (source_id) WHERE source_id IS NOT NULL;
