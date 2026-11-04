ALTER TABLE srs_cards ADD COLUMN puzzle_id TEXT;

-- A puzzle failed twice still yields one card; the second insert collides here and is skipped.
CREATE UNIQUE INDEX srs_cards_puzzle_id ON srs_cards (puzzle_id) WHERE puzzle_id IS NOT NULL;
