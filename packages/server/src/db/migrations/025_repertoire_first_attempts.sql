-- One row per first attempt the line drill rated, so how much of a variation the student
-- remembered has a history. repertoire_cards keeps only the schedule a move has now, shared by every
-- variation that plays it, so it cannot say when an attempt happened or under which variation.
--
-- A row is written when a drill rates a move: its first attempt in the drill, right or wrong, with
-- a hint or a shown solution counting as wrong. A move shown with its answer, the retries of a
-- missed move and the games that followed a variation rate no attempt and write none.
--
-- The position and the move are the card's key, not a reference to the card: a rebuild deletes the
-- cards of moves no variation stores any more, and the attempts of a variation that keeps its id
-- must outlive them.
CREATE TABLE repertoire_first_attempts (
  id INTEGER PRIMARY KEY,
  position_key TEXT NOT NULL,
  move_uci TEXT NOT NULL,
  repertoire_id INTEGER NOT NULL REFERENCES repertoires(id) ON DELETE CASCADE,
  attempted_at TEXT NOT NULL,
  correct INTEGER NOT NULL CHECK (correct IN (0, 1))
);

-- The share of the last 30 days is read per variation and time.
CREATE INDEX repertoire_first_attempts_by_variation
  ON repertoire_first_attempts (repertoire_id, attempted_at);
