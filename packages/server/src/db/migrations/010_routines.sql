CREATE TABLE routines (
  id INTEGER PRIMARY KEY,
  week_start TEXT NOT NULL,
  body TEXT NOT NULL,
  written_by TEXT NOT NULL CHECK (written_by IN ('coach', 'student', 'import')),
  created_at TEXT NOT NULL
);
