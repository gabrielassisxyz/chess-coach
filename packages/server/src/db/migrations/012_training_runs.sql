-- A practice queue started from the hub, kept current at every transition so it survives a server
-- restart and a trip to another screen. An open row (ended_at NULL) that is not on the board is a
-- paused run. `items_json` is the ordered [{kind, id}] list; `current_json` is the served item's
-- status and puzzle cursor.
CREATE TABLE training_runs (
  id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('srs', 'puzzles', 'openings')),
  motif TEXT,
  color TEXT CHECK (color IN ('white', 'black')),
  size INTEGER NOT NULL,
  items_json TEXT NOT NULL,
  position INTEGER NOT NULL,
  solved INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  current_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  ended_reason TEXT CHECK (ended_reason IN ('finished', 'ended', 'discarded', 'replaced'))
);

ALTER TABLE training_items ADD COLUMN run_id INTEGER REFERENCES training_runs(id);
