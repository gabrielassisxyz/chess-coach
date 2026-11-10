-- One row per game compared with a repertoire. It is written in the same transaction as the card
-- ratings and the positions the comparison added, so a game is applied once or not at all, and it
-- is what lists a game's effects afterwards.
--
-- outcome says how far the game followed the repertoire:
--   in_book           every move matched until the game ended or passed the depth the repertoire covers
--   departed          the student played another move than the expected one, and that move's card failed
--   reply_added       Black's reply was missing and was stored with White's answer, source 'game'
--   reply_not_stored  Black's reply was missing and no White answer fits after it
--   not_reached       the game left the line before the variation's starting position, so nothing changed
--   other_side        the student played the colour the repertoire is not for
--
-- left_* is the move that left the repertoire and the position it was played from, expected_* the
-- move the repertoire held there, and opening_name the opening of the position the game had reached
-- by then: a game that never reached the variation is grouped by these later. passed_moves counts
-- the student's moves that matched and were rated as passed.
CREATE TABLE repertoire_game_reviews (
  game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  repertoire_id INTEGER NOT NULL REFERENCES repertoires(id) ON DELETE CASCADE,
  reviewed_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'in_book', 'departed', 'reply_added', 'reply_not_stored', 'not_reached', 'other_side'
  )),
  followed_plies INTEGER NOT NULL,
  passed_moves INTEGER NOT NULL,
  left_ply INTEGER,
  left_position_key TEXT,
  left_san TEXT,
  left_uci TEXT,
  expected_san TEXT,
  expected_uci TEXT,
  opening_name TEXT,
  added_reply_id INTEGER REFERENCES repertoire_positions(id) ON DELETE SET NULL,
  added_answer_id INTEGER REFERENCES repertoire_positions(id) ON DELETE SET NULL
);
