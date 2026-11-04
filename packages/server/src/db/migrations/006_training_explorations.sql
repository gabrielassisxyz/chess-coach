CREATE TABLE training_items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('card', 'puzzle')),
  card_id INTEGER,
  puzzle_id TEXT,
  exposure_id TEXT,
  served_at TEXT NOT NULL,
  answered_at TEXT,
  answer_uci TEXT,
  correct INTEGER
);

CREATE TABLE exploration_events (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES training_items(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('move', 'undo', 'reset')),
  uci TEXT,
  fen_after TEXT NOT NULL,
  UNIQUE (item_id, seq)
);

CREATE TABLE item_messages (
  item_id INTEGER NOT NULL REFERENCES training_items(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES chat_messages(id),
  PRIMARY KEY (item_id, message_id)
);
