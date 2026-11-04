CREATE TABLE srs_reviews (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES srs_cards(id) ON DELETE CASCADE,
  reviewed_at TEXT NOT NULL,
  quality INTEGER NOT NULL CHECK (quality BETWEEN 0 AND 5),
  answered_uci TEXT NOT NULL,
  correct INTEGER NOT NULL
);

CREATE INDEX srs_reviews_card ON srs_reviews (card_id);
