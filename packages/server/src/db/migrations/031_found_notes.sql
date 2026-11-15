-- The note a position from the student's games carries: a sentence or two on why its best accepted
-- move is played there, written once by the found-notes batch and shown after the drill's answer.
-- Null until the batch writes it, and a stored note is never rewritten. Added in place rather than by
-- rebuilding the table, so no row is copied and nothing that points at found_positions is touched.
ALTER TABLE found_positions ADD COLUMN note TEXT;
