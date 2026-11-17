-- Permanent deletion of a ticket, for when it holds something that must be gone.

-- 1. One line per deleted ticket: its number, when, and who. No content. These rows are
--    never changed or removed.
CREATE TABLE deleted_tickets (
  ticket_id INTEGER PRIMARY KEY,
  deleted_at TEXT NOT NULL,
  deleted_by TEXT NOT NULL
);

CREATE TRIGGER deleted_tickets_no_update BEFORE UPDATE ON deleted_tickets
BEGIN
  SELECT RAISE(ABORT, 'deleted_tickets rows cannot be changed');
END;

CREATE TRIGGER deleted_tickets_no_delete BEFORE DELETE ON deleted_tickets
BEGIN
  SELECT RAISE(ABORT, 'deleted_tickets rows cannot be removed');
END;

-- 2. The event log stays append-only, with one exception: the events of a ticket that is
--    listed in deleted_tickets may be removed. Permanent deletion lists the ticket first.
DROP TRIGGER ticket_events_no_delete;

CREATE TRIGGER ticket_events_no_delete BEFORE DELETE ON ticket_events
WHEN NOT EXISTS (SELECT 1 FROM deleted_tickets WHERE ticket_id = OLD.ticket_id)
BEGIN
  SELECT RAISE(ABORT, 'ticket_events is append-only: rows cannot be deleted');
END;

-- 3. Rebuild tickets with AUTOINCREMENT. Without it SQLite gives a new ticket the highest
--    number in use plus one, so deleting the newest ticket would hand its number to the
--    next one. With it, a number is never used twice. SQLite cannot add AUTOINCREMENT to
--    an existing table, so the table is copied, the old one dropped and the copy renamed.
CREATE TABLE tickets_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved')),
  where_url TEXT,
  fix_check TEXT,
  created_by TEXT,
  owner_id TEXT,
  agent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

INSERT INTO tickets_new
  (id, title, description, status, where_url, fix_check, created_by, owner_id, agent_id,
   created_at, updated_at, archived_at)
SELECT
  id, title, description, status, where_url, fix_check, created_by, owner_id, agent_id,
  created_at, updated_at, archived_at
FROM tickets;

DROP TABLE tickets;
ALTER TABLE tickets_new RENAME TO tickets;

CREATE INDEX idx_tickets_status ON tickets (status);
CREATE INDEX idx_tickets_created_by ON tickets (created_by);
