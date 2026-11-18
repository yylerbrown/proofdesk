-- The owner of an in-progress ticket may hand it to one agent connection. The agent sees and
-- works on only the tickets handed to it. A hand-off ends when the ticket changes hands, the
-- customer is asked, the ticket is archived, or the owner ends it. Ended rows are kept.
CREATE TABLE ticket_agent_handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets (id),
  connection_id INTEGER NOT NULL REFERENCES agent_connections (id),
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);
CREATE INDEX ticket_agent_handoffs_connection ON ticket_agent_handoffs (connection_id, ended_at);
CREATE INDEX ticket_agent_handoffs_ticket ON ticket_agent_handoffs (ticket_id, ended_at);
