-- Ways to verify a new ticket that an assistant suggests, for the customer to pick from. An
-- admin allows a connection to suggest them. Each row is one way, in plain words, offered by one
-- connection. Its state is offered until the customer picks it (chosen), or until the ticket has
-- a check of its own or the connection offers others instead (withdrawn). The words are the
-- assistant's, never verified: they become the ticket's check only when the customer picks them.
CREATE TABLE check_suggestions (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  connection_id INTEGER NOT NULL REFERENCES agent_connections (id),
  -- The connection's name when it offered them, so the page can say who suggested each one.
  offered_by_name TEXT NOT NULL,
  words TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('offered', 'chosen', 'withdrawn')),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_check_suggestions_ticket_id ON check_suggestions (ticket_id, state);

-- Once the ticket has a check, whoever wrote it, the suggestions still offered are withdrawn.
-- A trigger, like the version number's, so no way of setting the check can forget it.
CREATE TRIGGER check_suggestions_withdrawn_by_check
AFTER UPDATE OF fix_check ON tickets
FOR EACH ROW WHEN NEW.fix_check IS NOT NULL
BEGIN
  UPDATE check_suggestions SET state = 'withdrawn'
    WHERE ticket_id = NEW.id AND state = 'offered';
END;
