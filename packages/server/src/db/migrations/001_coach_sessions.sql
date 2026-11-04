CREATE TABLE schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE coach_sessions (
  id INTEGER PRIMARY KEY,
  claude_session_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  prompt_version TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY,
  coach_session_id INTEGER NOT NULL REFERENCES coach_sessions(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'tool_use', 'tool_result', 'notification', 'incomplete')),
  content_json TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (coach_session_id, seq)
);
