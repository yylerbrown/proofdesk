-- An assistant can say it is blocked: its note is marked, and the team sees the note's first line
-- beside the check and in the list until the assistant writes an ordinary note again.
ALTER TABLE ticket_entries ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
