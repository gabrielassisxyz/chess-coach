-- Every card the app schedules moves from the SM-2 ladder to FSRS. The three card tables gain the
-- memory FSRS keeps (state, stability, difficulty, the learning step and the lapses) and lose the
-- two columns only the ladder read. interval_hours stays: it holds the interval the last rating
-- scheduled, a fraction for a step in minutes, and the drill's sibling gate reads it.
--
-- fsrs_state is ts-fsrs's State: 0 New, 1 Learning, 2 Review, 3 Relearning.
ALTER TABLE srs_cards ADD COLUMN fsrs_state INTEGER NOT NULL DEFAULT 0;
ALTER TABLE srs_cards ADD COLUMN stability REAL;
ALTER TABLE srs_cards ADD COLUMN difficulty REAL;
ALTER TABLE srs_cards ADD COLUMN learning_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE srs_cards ADD COLUMN lapses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE srs_cards ADD COLUMN last_reviewed_at TEXT;

ALTER TABLE repertoire_cards ADD COLUMN fsrs_state INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repertoire_cards ADD COLUMN stability REAL;
ALTER TABLE repertoire_cards ADD COLUMN difficulty REAL;
ALTER TABLE repertoire_cards ADD COLUMN learning_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repertoire_cards ADD COLUMN lapses INTEGER NOT NULL DEFAULT 0;

ALTER TABLE found_cards ADD COLUMN fsrs_state INTEGER NOT NULL DEFAULT 0;
ALTER TABLE found_cards ADD COLUMN stability REAL;
ALTER TABLE found_cards ADD COLUMN difficulty REAL;
ALTER TABLE found_cards ADD COLUMN learning_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE found_cards ADD COLUMN lapses INTEGER NOT NULL DEFAULT 0;

-- A card nobody has rated (interval_hours 0) stays New, with no stability or difficulty. A rated
-- card becomes Review. FSRS reads stability as the days after which recall falls to 90%, which is
-- what the SM-2 interval was scheduled to be, so stability is the interval in days. The difficulty
-- is the one ts-fsrs 5.4.2 gives a new card answered Good (2.1181) when the last review passed
-- (repetitions over 0) and the one it gives a new card answered Again (6.4133) when it failed.
-- next_review_at is not touched, so no card changes its due date. Replaying each card's reviews
-- through FSRS would need code this file cannot run, and the next review corrects the estimate.
UPDATE srs_cards
SET fsrs_state = 2,
    stability = interval_hours / 24.0,
    difficulty = CASE WHEN repetitions > 0 THEN 2.1181 ELSE 6.4133 END
WHERE interval_hours > 0;

UPDATE repertoire_cards
SET fsrs_state = 2,
    stability = interval_hours / 24.0,
    difficulty = CASE WHEN repetitions > 0 THEN 2.1181 ELSE 6.4133 END
WHERE interval_hours > 0;

UPDATE found_cards
SET fsrs_state = 2,
    stability = interval_hours / 24.0,
    difficulty = CASE WHEN repetitions > 0 THEN 2.1181 ELSE 6.4133 END
WHERE interval_hours > 0;

-- The other two tables already say when a card was last reviewed; this one read it from its log.
UPDATE srs_cards
SET last_reviewed_at = (
  SELECT r.reviewed_at FROM srs_reviews r
  WHERE r.card_id = srs_cards.id
  ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1
);

ALTER TABLE srs_cards DROP COLUMN ease_factor;
ALTER TABLE srs_cards DROP COLUMN repetitions;
ALTER TABLE repertoire_cards DROP COLUMN ease_factor;
ALTER TABLE repertoire_cards DROP COLUMN repetitions;
ALTER TABLE found_cards DROP COLUMN ease_factor;
ALTER TABLE found_cards DROP COLUMN repetitions;

-- A review is now rated on FSRS's four grades, 1 Again to 4 Easy; every row written before gets the
-- grade its quality maps to, and the old 0 to 5 quality stays as history and is NULL on every row
-- written from now on. quality has to become nullable, which a column cannot be altered to, so the
-- table is rebuilt. Nothing references
-- srs_reviews, so unlike a rebuild of games or training_runs this cannot cascade into other rows.
-- Every row keeps its id.
CREATE TABLE srs_reviews_next (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES srs_cards(id) ON DELETE CASCADE,
  reviewed_at TEXT NOT NULL,
  quality INTEGER CHECK (quality BETWEEN 0 AND 5),
  grade INTEGER CHECK (grade BETWEEN 1 AND 4),
  answered_uci TEXT NOT NULL,
  correct INTEGER NOT NULL
);

INSERT INTO srs_reviews_next (id, card_id, reviewed_at, quality, grade, answered_uci, correct)
SELECT id, card_id, reviewed_at, quality, CASE WHEN quality >= 3 THEN 3 ELSE 1 END, answered_uci,
       correct
FROM srs_reviews;

DROP TABLE srs_reviews;
ALTER TABLE srs_reviews_next RENAME TO srs_reviews;
CREATE INDEX srs_reviews_card ON srs_reviews (card_id);

-- The line drill, the game review and the From my games drill rate a card without leaving a row
-- behind; fitting FSRS's parameters to the student needs the history, and a review not logged now
-- is lost for good. card_key is "<position_key> <move_uci>" for a repertoire card (the move is the
-- last word, since a position key holds spaces itself) and the position id for a found card. There
-- is no foreign key, so deleting a unit keeps what the student did.
CREATE TABLE drill_reviews (
  id INTEGER PRIMARY KEY,
  card_kind TEXT NOT NULL CHECK (card_kind IN ('repertoire', 'found')),
  card_key TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  grade INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 4)
);
