-- The outcome of every item a run has answered, in queue order, so a resumed run can draw its
-- progress per position rather than only the solved and failed counts.
ALTER TABLE training_runs ADD COLUMN outcomes_json TEXT NOT NULL DEFAULT '[]';
