-- Evidence that a ticket's check was met, attached by the team or by an agent: what kind it
-- is, a short summary, an optional link, the revision tested, the command or check that ran,
-- a short result, and the original report kept exactly as sent. Nothing here is verified by
-- Proofdesk; it is shown as reported, by whom. It never resolves a ticket.
CREATE TABLE ticket_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets (id),
  kind TEXT NOT NULL CHECK (kind IN ('test', 'check_run', 'change_link', 'note')),
  summary TEXT NOT NULL,
  link TEXT,
  revision TEXT,
  command TEXT,
  result TEXT,
  report TEXT, -- the original report, as sent (JSON text)
  author TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('person', 'agent')),
  author_name TEXT NOT NULL,
  connection_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX ticket_evidence_ticket ON ticket_evidence (ticket_id);
