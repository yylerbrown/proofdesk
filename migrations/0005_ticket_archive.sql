-- When a ticket was archived, or NULL while it is not. An archived ticket is hidden from
-- the ordinary lists but its row and its events are kept.
ALTER TABLE tickets ADD COLUMN archived_at TEXT;
