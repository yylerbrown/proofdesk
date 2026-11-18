CREATE TABLE tickets (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved')),
  where_url TEXT,
  fix_check TEXT,
  created_by TEXT,
  owner_id TEXT,
  agent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Append-only log. Rows are only ever inserted, never updated or deleted.
-- The tickets row stays the source of truth for the current state.
CREATE TABLE ticket_events (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets (id),
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_tickets_status ON tickets (status);
CREATE INDEX idx_ticket_events_ticket_id ON ticket_events (ticket_id);
