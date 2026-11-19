-- A version number for each ticket, so a form or a program can say which version it saw. A
-- change sent with an older version is refused instead of quietly writing over a newer one.
-- The trigger raises it by one whenever the ticket's row changes, whichever statement changes
-- it, so no write can forget to. Only the row counts: everything in it is something the
-- customer may see, so the version never tells a customer about team-only work such as a
-- hand to an assistant. A reply, a note or evidence adds to the ticket without changing what
-- an editor sees in its form, so those leave it as it is.
ALTER TABLE tickets ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TRIGGER tickets_version_bump
AFTER UPDATE ON tickets
FOR EACH ROW WHEN NEW.version = OLD.version
BEGIN
  UPDATE tickets SET version = OLD.version + 1 WHERE id = NEW.id;
END;
