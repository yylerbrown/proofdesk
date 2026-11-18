-- Everything an agent's connection asked for, done or refused: which door (the JSON API or the
-- MCP tools), which action, which ticket, the idempotency key, and how it ended. It holds no
-- ticket text, only keys and codes, so a permanently deleted ticket leaves only its number
-- here, as in the deletion record. Old rows are pruned.
CREATE TABLE agent_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES agent_connections (id),
  door TEXT NOT NULL CHECK (door IN ('api', 'mcp')),
  action TEXT NOT NULL,
  ticket_key TEXT,
  idempotency_key TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('done', 'refused', 'failed')),
  code TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX agent_activity_connection ON agent_activity (connection_id, id);
