-- Each screen (Play, Games, Practice) keeps its own conversation with the coach. Every row written
-- before this belonged to the one shared conversation, which is where Play's lives now.
ALTER TABLE coach_sessions
  ADD COLUMN tab TEXT NOT NULL DEFAULT 'play' CHECK (tab IN ('play', 'games', 'practice'));

-- Copied from the row's session when it is written, so a message names its tab without a join.
ALTER TABLE chat_messages
  ADD COLUMN tab TEXT NOT NULL DEFAULT 'play' CHECK (tab IN ('play', 'games', 'practice'));

CREATE INDEX coach_sessions_open_by_tab ON coach_sessions (tab, ended_at, id);
