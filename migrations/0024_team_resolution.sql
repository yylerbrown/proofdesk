-- The team may resolve a ticket without the customer's Yes, with a reason that is shown wherever
-- the ticket is: "Resolved by the team: <reason>". These columns are set only by that, and every
-- other change of status clears them, so a resolved ticket with them empty is one the customer
-- confirmed with their Yes.
ALTER TABLE tickets ADD COLUMN resolved_reason TEXT
  CHECK (resolved_reason IN ('fixed_no_reply', 'duplicate', 'wont_fix', 'cannot_reproduce', 'other'));
ALTER TABLE tickets ADD COLUMN resolved_note TEXT;
ALTER TABLE tickets ADD COLUMN resolved_duplicate_of TEXT;
ALTER TABLE tickets ADD COLUMN resolved_by TEXT;
ALTER TABLE tickets ADD COLUMN resolved_by_name TEXT;
ALTER TABLE tickets ADD COLUMN resolved_at TEXT;
