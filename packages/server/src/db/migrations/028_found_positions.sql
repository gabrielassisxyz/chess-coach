-- One row per position worth practising that the student's graded games show, keyed by the
-- position's own: id. The from_* flags say which rules found it: the position before an
-- inaccuracy, a mistake or a blunder of the student's (from_mistake), one that two or more games
-- reached with the student to move (from_repeat), and the one after the opponent's move that left
-- a stored White unit (from_departure). The flags, the counts and the game shown beside it are
-- refreshed on every run; accepted_uci, the moves the engine search accepts there as a JSON array
-- with the best first, is written once, so a stored position is never searched again. A row with
-- listed = 0 is kept for that reason, and so the positions left out can be counted.
--
-- No column is a foreign key: an unlisted row has no puzzle under its id, and game_id only names the
-- game shown, which nothing in the server deletes; a row that outlives a game deleted by hand keeps
-- its last counts.
CREATE TABLE found_positions (
  id TEXT PRIMARY KEY,
  fen TEXT NOT NULL,
  color TEXT NOT NULL CHECK (color IN ('white', 'black')),
  phase TEXT NOT NULL CHECK (phase IN ('opening', 'middlegame', 'endgame')),
  from_mistake INTEGER NOT NULL CHECK (from_mistake IN (0, 1)),
  from_repeat INTEGER NOT NULL CHECK (from_repeat IN (0, 1)),
  from_departure INTEGER NOT NULL CHECK (from_departure IN (0, 1)),
  accepted_uci TEXT NOT NULL,
  listed INTEGER NOT NULL CHECK (listed IN (0, 1)),
  reached_games INTEGER NOT NULL,
  best_games INTEGER NOT NULL,
  last_reached_at TEXT NOT NULL,
  game_id INTEGER NOT NULL,
  ply INTEGER NOT NULL,
  first_found_at TEXT NOT NULL
);
