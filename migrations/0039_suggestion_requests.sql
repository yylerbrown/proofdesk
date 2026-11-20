-- A person asking a listening assistant for ways to verify their own filed ticket. Each row is
-- one request: the ticket, who asked, whether they pressed for it (1) or their page sent it by
-- itself (0), when, and when an assistant answered it. Rows are removed ten minutes after they
-- were made, so the table only ever holds the last few minutes of asking.
CREATE TABLE suggestion_requests (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  pressed INTEGER NOT NULL CHECK (pressed IN (0, 1)),
  created_at TEXT NOT NULL,
  answered_at TEXT,
  answered_by INTEGER REFERENCES agent_connections (id)
);

CREATE INDEX idx_suggestion_requests_ticket_id ON suggestion_requests (ticket_id);
CREATE INDEX idx_suggestion_requests_requested_by ON suggestion_requests (requested_by, created_at);

-- The one tick "suggest_checks" became a choice of three, stored as scopes like every other
-- permission: "When asked" holds suggest_when_asked, and "Automatic" holds both it and
-- suggest_automatic. A connection that had the tick keeps what the tick allowed.
UPDATE agent_connections
SET scopes = replace(scopes, '"suggest_checks"', '"suggest_when_asked","suggest_automatic"')
WHERE scopes LIKE '%"suggest_checks"%';
