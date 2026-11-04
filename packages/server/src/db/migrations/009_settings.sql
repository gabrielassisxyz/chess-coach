CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO settings (key, value, updated_at) VALUES ('current_elo', '600', '1970-01-01T00:00:00.000Z');

-- A log, never a source of truth for the streak: the streak is recomputed from games.
CREATE TABLE difficulty_changes (
  id INTEGER PRIMARY KEY,
  changed_at TEXT NOT NULL,
  from_elo INTEGER NOT NULL CHECK (from_elo BETWEEN 100 AND 3190),
  to_elo INTEGER NOT NULL CHECK (to_elo BETWEEN 100 AND 3190),
  reason TEXT NOT NULL CHECK (reason IN ('streak_up', 'streak_down', 'coach', 'student')),
  game_id INTEGER REFERENCES games(id),
  -- The coach's own words for a coach change; null for a streak.
  note TEXT
);
