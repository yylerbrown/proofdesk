-- Makes the event log append-only in the database itself, not only by convention.
-- Any UPDATE or DELETE on ticket_events fails and rolls back the statement.
CREATE TRIGGER ticket_events_no_update
BEFORE UPDATE ON ticket_events
BEGIN
  SELECT RAISE(ABORT, 'ticket_events is append-only: rows cannot be updated');
END;

CREATE TRIGGER ticket_events_no_delete
BEFORE DELETE ON ticket_events
BEGIN
  SELECT RAISE(ABORT, 'ticket_events is append-only: rows cannot be deleted');
END;
