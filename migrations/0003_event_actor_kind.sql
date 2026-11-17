-- Records whether a person or an agent wrote each event. Every event written before this
-- migration came from an anonymous person, so 'person' is the right value for old rows.
ALTER TABLE ticket_events
  ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'person' CHECK (actor_kind IN ('person', 'agent'));
