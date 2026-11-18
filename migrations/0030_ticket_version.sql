-- A version number for each ticket, so a form or a program can say which version it saw. A
-- change sent with an older version is refused instead of quietly writing over a newer one.
-- The first trigger raises it by one whenever the ticket's row changes, whichever statement
-- changes it, so no write can forget to. Handing the ticket to an assistant, or ending that,
-- changes who works on it, so those raise it too. A reply, a note or evidence adds to the
-- ticket without changing what an editor sees in its form, so those leave it as it is.
ALTER TABLE tickets ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TRIGGER tickets_version_bump
AFTER UPDATE ON tickets
FOR EACH ROW WHEN NEW.version = OLD.version
BEGIN
  UPDATE tickets SET version = OLD.version + 1 WHERE id = NEW.id;
END;

CREATE TRIGGER tickets_version_bump_on_handoff
AFTER INSERT ON ticket_agent_handoffs
FOR EACH ROW
BEGIN
  UPDATE tickets SET version = version + 1 WHERE id = NEW.ticket_id;
END;

CREATE TRIGGER tickets_version_bump_on_handoff_end
AFTER UPDATE OF ended_at ON ticket_agent_handoffs
FOR EACH ROW WHEN OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
BEGIN
  UPDATE tickets SET version = version + 1 WHERE id = NEW.ticket_id;
END;
