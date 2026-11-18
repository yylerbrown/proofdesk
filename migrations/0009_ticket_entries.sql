-- The conversation on a ticket. A reply is seen by the customer and the team. An internal
-- note is seen by the team only. The author's role and name are stored as they were when
-- the entry was written, so a later change of role does not change what an old entry says.
CREATE TABLE ticket_entries (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets (id),
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'note')),
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('person', 'agent')),
  author_role TEXT NOT NULL CHECK (author_role IN ('customer', 'team', 'admin')),
  author_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_ticket_entries_ticket_id ON ticket_entries (ticket_id);
