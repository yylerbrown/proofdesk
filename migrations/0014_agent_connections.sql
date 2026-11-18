-- Connections for AI agents. Each is one credential, issued by an admin to one holder, with
-- the scopes it allows. Only a hash of the key is kept; the short prefix is shown so a person
-- can tell keys apart. Revoking a connection keeps its row, so history can still name it.
CREATE TABLE agent_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL, -- JSON array of scope names
  issued_by TEXT NOT NULL,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);

-- For an agent's action: the connection, who issued it, its scopes at that moment and the
-- ticket's human owner, as JSON. Empty for a person's action.
ALTER TABLE ticket_events ADD COLUMN actor_context TEXT;
