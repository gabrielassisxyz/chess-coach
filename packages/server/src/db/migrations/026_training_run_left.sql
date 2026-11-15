-- A practice run that stops being on the board ends there, and `left` says it was the student's
-- leaving (another game opened or started, a coach-served item over it) or a server start that
-- closed it. ended_reason accepts it by swapping the column alone, as 021_repertoire_drill.sql does
-- for `mode`: a rebuild (create, copy, drop, rename) runs inside this migration's transaction,
-- where PRAGMA foreign_keys cannot be switched off, so dropping training_runs would trip
-- training_items.run_id. Every row keeps its id and the reason it already has, `discarded`
-- included, which nothing writes any more.
ALTER TABLE training_runs ADD COLUMN ended_reason_next TEXT
  CHECK (ended_reason_next IN ('finished', 'ended', 'discarded', 'replaced', 'left'));
UPDATE training_runs SET ended_reason_next = ended_reason;
ALTER TABLE training_runs DROP COLUMN ended_reason;
ALTER TABLE training_runs RENAME COLUMN ended_reason_next TO ended_reason;
