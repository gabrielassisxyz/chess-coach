-- A hint marks the piece that should move without counting as a try. A hinted item never counts
-- as solved first try, for the same reason a given-up item does not.
ALTER TABLE training_items ADD COLUMN hinted INTEGER NOT NULL DEFAULT 0 CHECK (hinted IN (0, 1));
ALTER TABLE puzzle_attempts ADD COLUMN hinted INTEGER NOT NULL DEFAULT 0 CHECK (hinted IN (0, 1));
