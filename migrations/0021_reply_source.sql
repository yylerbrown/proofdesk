-- A reply a person published from an internal note (for example an agent's suggested wording)
-- points at that note, so the team can see where the words came from. The reply's author is
-- the person who published it.
ALTER TABLE ticket_entries ADD COLUMN based_on INTEGER;
