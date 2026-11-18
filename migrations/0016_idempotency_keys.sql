-- A write sent with an idempotency key is done once. A retry with the same key gets the first
-- answer back instead of acting again. Rows carry the ticket's id, so permanent deletion
-- removes them with the ticket, and are kept for a day.
CREATE TABLE idempotency_keys (
  actor TEXT NOT NULL,
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response TEXT NOT NULL, -- JSON text
  ticket_id INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor, key)
);
