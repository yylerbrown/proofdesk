-- When each resolved ticket last became Resolved, so the list's "All" can leave out the ones
-- resolved long ago. It is set when a ticket moves to Resolved from another status, kept while it
-- stays Resolved (a customer's Yes after the team marked it fixed does not move it), and cleared
-- when the ticket is reopened. The time a ticket was filed says nothing about this, and the time
-- it was last updated moves with every reply.
ALTER TABLE tickets ADD COLUMN last_resolved_at TEXT;

-- The resolved tickets already here: the last time their history shows them moved to Resolved,
-- or the time they were last updated when the history does not say.
UPDATE tickets SET last_resolved_at = COALESCE(
  (SELECT MAX(created_at) FROM ticket_events
     WHERE ticket_events.ticket_id = tickets.id
       AND (type = 'resolved_by_team'
         OR (type = 'status_changed' AND json_extract(data, '$.to') = 'resolved')
         OR (type = 'customer_answered' AND json_extract(data, '$.fixed') = 1))),
  updated_at
) WHERE status = 'resolved';

-- "All" reads the resolved tickets by this time.
CREATE INDEX tickets_last_resolved ON tickets (last_resolved_at)
  WHERE archived_at IS NULL AND status = 'resolved';
