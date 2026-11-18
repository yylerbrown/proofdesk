-- Email notices, written from the ticket history. A notifier reads the history events after a
-- stored cursor, turns the few kinds that someone must hear about into one row each here, and
-- moves the cursor, all in one transaction. The ticket rules know nothing about email.
--
-- One row per history event, recipient and kind, so reading the same event twice adds nothing.
-- The address is kept as it was when the row was written. state is 'pending' (to be sent),
-- 'sent', 'failed', or 'not_sent' with a plain reason, for example on the demo, which never
-- sends. Rows carry the ticket's id, so permanent deletion removes them with the ticket.
CREATE TABLE email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  ticket_id INTEGER NOT NULL REFERENCES tickets (id),
  recipient_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'not_sent')),
  not_sent_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE (event_id, recipient_id, kind),
  -- A reason is given exactly when a notice is not sent.
  CHECK ((state = 'not_sent') = (not_sent_reason IS NOT NULL))
);
CREATE INDEX email_outbox_ticket ON email_outbox (ticket_id, id);
CREATE INDEX email_outbox_state ON email_outbox (state, id);

-- What a notice says and who it is for are fixed when it is written. Sending changes only its
-- state, attempts, error and times.
CREATE TRIGGER email_outbox_content_fixed
BEFORE UPDATE OF event_id, ticket_id, recipient_id, kind, address, subject, body ON email_outbox
BEGIN
  SELECT RAISE(ABORT, 'email_outbox rows keep what they say: only their state can change');
END;

-- The id of the last history event the notifier has read. Exactly one row. It starts at the
-- newest event already stored, so a database from before notices sends nothing about the past.
-- A fresh database starts at 0. The demo seeds its samples after the migrations, so on a fresh
-- demo the samples' history is collected too: their notices show as not sent, like any others.
CREATE TABLE email_outbox_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_event_id INTEGER NOT NULL
);
INSERT INTO email_outbox_cursor (id, last_event_id)
VALUES (1, (SELECT COALESCE(MAX(id), 0) FROM ticket_events));

-- Permanent deletion can remove the newest events, and SQLite then hands their ids to the next
-- events. Moving the cursor back to the newest event left makes sure those are still read.
CREATE TRIGGER email_outbox_cursor_follows_deletion
AFTER DELETE ON ticket_events
BEGIN
  UPDATE email_outbox_cursor
  SET last_event_id = MIN(last_event_id, (SELECT COALESCE(MAX(id), 0) FROM ticket_events));
END;
