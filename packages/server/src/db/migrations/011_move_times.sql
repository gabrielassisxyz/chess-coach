-- When each ply was played. Rows written before this column existed stay NULL.
ALTER TABLE moves ADD COLUMN created_at TEXT;
