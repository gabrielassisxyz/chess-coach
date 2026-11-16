-- Positions the analysis bar or the coach asked about that the evaluation cache did not hold, waiting
-- for the background worker to search them deeper and store the result in the cache file. `key` is the
-- cache's own packed position key, so a row here and the row the worker writes are the same position;
-- `fen` is what the engine is given. A position is queued once. The queue is ordered by rowid, which
-- is insertion order and cannot tie or run backwards with the clock: a position looked at again is
-- deleted and inserted anew, so it moves to the front, and the oldest rows are the first dropped when
-- the queue is over its cap. `enqueued_at` only says how long a row waited.
CREATE TABLE eval_queue (
  key BLOB NOT NULL UNIQUE,
  fen TEXT NOT NULL,
  enqueued_at TEXT NOT NULL
);
