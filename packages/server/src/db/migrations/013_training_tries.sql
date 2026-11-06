-- Every move a student drops on a practice item is graded and kept, wrong ones included. `ply` is
-- the solution index the try was graded against (0 for a card); `at_ms` is measured from the moment
-- the item was served.
CREATE TABLE training_tries (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES training_items(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at_ms INTEGER NOT NULL,
  ply INTEGER NOT NULL,
  uci TEXT NOT NULL,
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  UNIQUE (item_id, seq)
);

-- Accuracy is "solved on the first try". Before retries a puzzle was over at its first wrong move,
-- so every earlier solved row was also a first-try solve.
ALTER TABLE puzzle_attempts ADD COLUMN first_try INTEGER NOT NULL DEFAULT 0;
ALTER TABLE puzzle_attempts ADD COLUMN tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE puzzle_attempts ADD COLUMN gave_up INTEGER NOT NULL DEFAULT 0;
UPDATE puzzle_attempts SET first_try = solved;
