-- A test spec for a ticket: a short summary and the scenarios that would make the customer's
-- check testable, each as given, when, then, with the automated test that would prove it if
-- one is named. It is proposed, usually by a visitor's own AI assistant, and stays a
-- suggestion until a person accepts it. A new proposal replaces the one before, which is kept
-- with the state "replaced". Nothing here is verified by Proofdesk.
CREATE TABLE ticket_specs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets (id),
  summary TEXT NOT NULL,
  scenarios TEXT NOT NULL, -- JSON array of { title, given, when, then, test_name }
  state TEXT NOT NULL CHECK (state IN ('proposed', 'accepted', 'replaced', 'discarded')),
  author TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('person', 'agent')),
  author_name TEXT NOT NULL,
  connection_id INTEGER,
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_by_name TEXT,
  decided_at TEXT
);

CREATE INDEX ticket_specs_ticket ON ticket_specs (ticket_id);

-- At most one spec per ticket is in force: proposed or accepted.
CREATE UNIQUE INDEX ticket_specs_one_active
  ON ticket_specs (ticket_id) WHERE state IN ('proposed', 'accepted');

-- Evidence may name the scenario of a spec it proves, by the spec and the scenario's number.
ALTER TABLE ticket_evidence ADD COLUMN spec_id INTEGER;
ALTER TABLE ticket_evidence ADD COLUMN scenario INTEGER;
