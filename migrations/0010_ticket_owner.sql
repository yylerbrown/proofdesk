-- The name of a ticket's owner, stored when the ticket is taken, like the author name on a
-- reply. owner_id already exists.
ALTER TABLE tickets ADD COLUMN owner_name TEXT;

-- Every ticket in progress has a named human owner. The service checks this first and
-- answers with a clear message; this makes the database refuse it as well.
CREATE TRIGGER tickets_in_progress_needs_owner
BEFORE UPDATE OF status, owner_id ON tickets
WHEN NEW.status = 'in_progress' AND NEW.owner_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a ticket in progress must have an owner');
END;
