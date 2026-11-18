-- Each person's choice about email notices, from the "Email me about my tickets" switch on
-- their account page. A person without a row gets email, which is the default. The id is the
-- same opaque text tickets store, so the made-up people of the development entrance can have a
-- row too.
CREATE TABLE email_settings (
  person_id TEXT PRIMARY KEY,
  email_me INTEGER NOT NULL CHECK (email_me IN (0, 1)),
  updated_at TEXT NOT NULL
);
