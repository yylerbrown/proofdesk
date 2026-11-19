-- Pictures on tickets: a screenshot of what is wrong with a new ticket, or of the fix with a
-- reply or a note. Each row is one picture and its bytes. A picture with no entry belongs to
-- the ticket's own description. Who may see it is decided by what it is attached to, so the
-- row only says where it belongs.
--
-- The type is the one read from the picture's first bytes, never the name or the type the
-- browser claimed. shown_only_to is set only on the shared public demo: there a visitor's
-- picture is served only to the browser that added it, and this holds a hash of that
-- browser's random token. It is empty for every picture on a real site and for the pictures
-- the demo seeds itself.
CREATE TABLE ticket_pictures (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  entry_id INTEGER REFERENCES ticket_entries (id) ON DELETE CASCADE,
  added_by TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  size INTEGER NOT NULL CHECK (size > 0),
  bytes BLOB NOT NULL,
  shown_only_to TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_ticket_pictures_ticket_id ON ticket_pictures (ticket_id, entry_id);
